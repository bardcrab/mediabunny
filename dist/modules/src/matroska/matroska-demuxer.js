/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { extractAv1CodecInfoFromPacket, extractAvcDecoderConfigurationRecord, extractHevcDecoderConfigurationRecord, extractVp9CodecInfoFromPacket, } from '../codec-data.js';
import { extractAudioCodecString, extractVideoCodecString, } from '../codec.js';
import { Demuxer } from '../demuxer.js';
import { InputAudioTrack, InputVideoTrack, } from '../input-track.js';
import { assert, AsyncMutex, binarySearchExact, binarySearchLessOrEqual, COLOR_PRIMARIES_MAP_INVERSE, findLastIndex, insertSorted, isIso639Dash2LanguageCode, last, MATRIX_COEFFICIENTS_MAP_INVERSE, normalizeRotation, roundToPrecision, TRANSFER_CHARACTERISTICS_MAP_INVERSE, UNDETERMINED_LANGUAGE, } from '../misc.js';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet.js';
import { assertDefinedSize, CODEC_STRING_MAP, EBMLId, LEVEL_0_AND_1_EBML_IDS, LEVEL_1_EBML_IDS, MAX_HEADER_SIZE, MIN_HEADER_SIZE, readAsciiString, readUnicodeString, readElementHeader, readElementId, readFloat, readSignedInt, readUnsignedInt, readVarInt, resync, searchForNextElementId, } from './ebml.js';
import { buildMatroskaMimeType } from './matroska-misc.js';
import { FileSlice, readBytes, readI16Be, readU8 } from '../reader.js';
var BlockLacing;
(function (BlockLacing) {
    BlockLacing[BlockLacing["None"] = 0] = "None";
    BlockLacing[BlockLacing["Xiph"] = 1] = "Xiph";
    BlockLacing[BlockLacing["FixedSize"] = 2] = "FixedSize";
    BlockLacing[BlockLacing["Ebml"] = 3] = "Ebml";
})(BlockLacing || (BlockLacing = {}));
const METADATA_ELEMENTS = [
    { id: EBMLId.SeekHead, flag: 'seekHeadSeen' },
    { id: EBMLId.Info, flag: 'infoSeen' },
    { id: EBMLId.Tracks, flag: 'tracksSeen' },
    { id: EBMLId.Cues, flag: 'cuesSeen' },
];
const MAX_RESYNC_LENGTH = 10 * 2 ** 20; // 10 MiB
export class MatroskaDemuxer extends Demuxer {
    constructor(input) {
        super(input);
        this.readMetadataPromise = null;
        this.segments = [];
        this.currentSegment = null;
        this.currentTrack = null;
        this.currentCluster = null;
        this.currentBlock = null;
        this.currentCueTime = null;
        this.currentTagTargetIsMovie = true;
        this.currentSimpleTagName = null;
        this.currentAttachedFile = null;
        this.isWebM = false;
        this.reader = input._reader;
    }
    async computeDuration() {
        const tracks = await this.getTracks();
        const trackDurations = await Promise.all(tracks.map(x => x.computeDuration()));
        return Math.max(0, ...trackDurations);
    }
    async getTracks() {
        await this.readMetadata();
        return this.segments.flatMap(segment => segment.tracks.map(track => track.inputTrack));
    }
    async getMimeType() {
        await this.readMetadata();
        const tracks = await this.getTracks();
        const codecStrings = await Promise.all(tracks.map(x => x.getCodecParameterString()));
        return buildMatroskaMimeType({
            isWebM: this.isWebM,
            hasVideo: this.segments.some(segment => segment.tracks.some(x => x.info?.type === 'video')),
            hasAudio: this.segments.some(segment => segment.tracks.some(x => x.info?.type === 'audio')),
            codecStrings: codecStrings.filter(Boolean),
        });
    }
    async getMetadataTags() {
        await this.readMetadata();
        // Load metadata tags from each segment lazily (only once)
        for (const segment of this.segments) {
            if (!segment.metadataTagsCollected) {
                if (this.reader.fileSize !== null) {
                    await this.loadSegmentMetadata(segment);
                }
                else {
                    // The seeking would be too crazy, let's not
                }
                segment.metadataTagsCollected = true;
            }
        }
        // This is kinda handwavy, and how we handle multiple segments isn't suuuuper well-defined anyway; so we just
        // shallow-merge metadata tags from all (usually just one) segments.
        let metadataTags = {};
        for (const segment of this.segments) {
            metadataTags = { ...metadataTags, ...segment.metadataTags };
        }
        return metadataTags;
    }
    readMetadata() {
        return this.readMetadataPromise ??= (async () => {
            let currentPos = 0;
            // Loop over all top-level elements in the file
            while (true) {
                let slice = this.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
                if (slice instanceof Promise)
                    slice = await slice;
                if (!slice)
                    break;
                const header = readElementHeader(slice);
                if (!header) {
                    break; // Zero padding at the end of the file triggers this, for example
                }
                const id = header.id;
                let size = header.size;
                const dataStartPos = slice.filePos;
                if (id === EBMLId.EBML) {
                    assertDefinedSize(size);
                    let slice = this.reader.requestSlice(dataStartPos, size);
                    if (slice instanceof Promise)
                        slice = await slice;
                    if (!slice)
                        break;
                    this.readContiguousElements(slice);
                }
                else if (id === EBMLId.Segment) { // Segment found!
                    await this.readSegment(dataStartPos, size);
                    if (size === null) {
                        // Segment sizes can be undefined (common in livestreamed files), so assume this is the last
                        // and only segment
                        break;
                    }
                    if (this.reader.fileSize === null) {
                        break; // Stop at the first segment
                    }
                }
                else if (id === EBMLId.Cluster) {
                    if (this.reader.fileSize === null) {
                        break; // Shouldn't be reached anyway, since we stop at the first segment
                    }
                    // Clusters are not a top-level element in Matroska, but some files contain a Segment whose size
                    // doesn't contain any of the clusters that follow it. In the case, we apply the following logic: if
                    // we find a top-level cluster, attribute it to the previous segment.
                    if (size === null) {
                        // Just in case this is one of those weird sizeless clusters, let's do our best and still try to
                        // determine its size.
                        const nextElementPos = await searchForNextElementId(this.reader, dataStartPos, LEVEL_0_AND_1_EBML_IDS, this.reader.fileSize);
                        size = nextElementPos.pos - dataStartPos;
                    }
                    const lastSegment = last(this.segments);
                    if (lastSegment) {
                        // Extend the previous segment's size
                        lastSegment.elementEndPos = dataStartPos + size;
                    }
                }
                assertDefinedSize(size);
                currentPos = dataStartPos + size;
            }
        })();
    }
    async readSegment(segmentDataStart, dataSize) {
        this.currentSegment = {
            seekHeadSeen: false,
            infoSeen: false,
            tracksSeen: false,
            cuesSeen: false,
            tagsSeen: false,
            attachmentsSeen: false,
            timestampScale: -1,
            timestampFactor: -1,
            duration: -1,
            seekEntries: [],
            tracks: [],
            cuePoints: [],
            dataStartPos: segmentDataStart,
            elementEndPos: dataSize === null
                ? null // Assume it goes until the end of the file
                : segmentDataStart + dataSize,
            clusterSeekStartPos: segmentDataStart,
            clusters: [],
            clusterLookupMutex: new AsyncMutex(),
            metadataTags: {},
            metadataTagsCollected: false,
        };
        this.segments.push(this.currentSegment);
        let currentPos = segmentDataStart;
        while (this.currentSegment.elementEndPos === null || currentPos < this.currentSegment.elementEndPos) {
            let slice = this.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
            if (slice instanceof Promise)
                slice = await slice;
            if (!slice)
                break;
            const elementStartPos = currentPos;
            const header = readElementHeader(slice);
            if (!header || (!LEVEL_1_EBML_IDS.includes(header.id) && header.id !== EBMLId.Void)) {
                // Potential junk. Let's try to resync
                const nextPos = await resync(this.reader, elementStartPos, LEVEL_1_EBML_IDS, Math.min(this.currentSegment.elementEndPos ?? Infinity, elementStartPos + MAX_RESYNC_LENGTH));
                if (nextPos) {
                    currentPos = nextPos;
                    continue;
                }
                else {
                    break; // Resync failed
                }
            }
            const { id, size } = header;
            const dataStartPos = slice.filePos;
            const metadataElementIndex = METADATA_ELEMENTS.findIndex(x => x.id === id);
            if (metadataElementIndex !== -1) {
                const field = METADATA_ELEMENTS[metadataElementIndex].flag;
                this.currentSegment[field] = true;
                assertDefinedSize(size);
                let slice = this.reader.requestSlice(dataStartPos, size);
                if (slice instanceof Promise)
                    slice = await slice;
                if (slice) {
                    this.readContiguousElements(slice);
                }
            }
            else if (id === EBMLId.Tags || id === EBMLId.Attachments) {
                // Metadata found at the beginning of the segment, great, let's parse it
                if (id === EBMLId.Tags) {
                    this.currentSegment.tagsSeen = true;
                }
                else {
                    this.currentSegment.attachmentsSeen = true;
                }
                assertDefinedSize(size);
                let slice = this.reader.requestSlice(dataStartPos, size);
                if (slice instanceof Promise)
                    slice = await slice;
                if (slice) {
                    this.readContiguousElements(slice);
                }
            }
            else if (id === EBMLId.Cluster) {
                this.currentSegment.clusterSeekStartPos = elementStartPos;
                break; // Stop at the first cluster
            }
            if (size === null) {
                break;
            }
            else {
                currentPos = dataStartPos + size;
            }
        }
        // Sort the seek entries by file position so reading them exhibits a sequential pattern
        this.currentSegment.seekEntries.sort((a, b) => a.segmentPosition - b.segmentPosition);
        if (this.reader.fileSize !== null) {
            // Use the seek head to read missing metadata elements
            for (const seekEntry of this.currentSegment.seekEntries) {
                const target = METADATA_ELEMENTS.find(x => x.id === seekEntry.id);
                if (!target) {
                    continue;
                }
                if (this.currentSegment[target.flag])
                    continue;
                let slice = this.reader.requestSliceRange(segmentDataStart + seekEntry.segmentPosition, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
                if (slice instanceof Promise)
                    slice = await slice;
                if (!slice)
                    continue;
                const header = readElementHeader(slice);
                if (!header)
                    continue;
                const { id, size } = header;
                if (id !== target.id)
                    continue;
                assertDefinedSize(size);
                this.currentSegment[target.flag] = true;
                let dataSlice = this.reader.requestSlice(slice.filePos, size);
                if (dataSlice instanceof Promise)
                    dataSlice = await dataSlice;
                if (!dataSlice)
                    continue;
                this.readContiguousElements(dataSlice);
            }
        }
        if (this.currentSegment.timestampScale === -1) {
            // TimestampScale element is missing. Technically an invalid file, but let's default to the typical value,
            // which is 1e6.
            this.currentSegment.timestampScale = 1e6;
            this.currentSegment.timestampFactor = 1e9 / 1e6;
        }
        // Put default tracks first
        this.currentSegment.tracks.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
        // Sort cue points by cluster position (required for the next algorithm)
        this.currentSegment.cuePoints.sort((a, b) => a.clusterPosition - b.clusterPosition);
        // Now, let's distribute the cue points to each track. Ideally, each track has their own cue point, but some
        // Matroska files may only specify cue points for a single track. In this case, we still wanna use those cue
        // points for all tracks.
        const allTrackIds = this.currentSegment.tracks.map(x => x.id);
        const remainingTrackIds = new Set();
        let lastClusterPosition = null;
        let lastCuePoint = null;
        for (const cuePoint of this.currentSegment.cuePoints) {
            if (cuePoint.clusterPosition !== lastClusterPosition) {
                for (const id of remainingTrackIds) {
                    // These tracks didn't receive a cue point for the last cluster, so let's give them one
                    assert(lastCuePoint);
                    const track = this.currentSegment.tracks.find(x => x.id === id);
                    track.cuePoints.push(lastCuePoint);
                }
                for (const id of allTrackIds) {
                    remainingTrackIds.add(id);
                }
            }
            lastCuePoint = cuePoint;
            if (!remainingTrackIds.has(cuePoint.trackId)) {
                continue;
            }
            const track = this.currentSegment.tracks.find(x => x.id === cuePoint.trackId);
            track.cuePoints.push(cuePoint);
            remainingTrackIds.delete(cuePoint.trackId);
            lastClusterPosition = cuePoint.clusterPosition;
        }
        for (const id of remainingTrackIds) {
            assert(lastCuePoint);
            const track = this.currentSegment.tracks.find(x => x.id === id);
            track.cuePoints.push(lastCuePoint);
        }
        for (const track of this.currentSegment.tracks) {
            // Sort cue points by time
            track.cuePoints.sort((a, b) => a.time - b.time);
        }
        this.currentSegment = null;
    }
    async readCluster(startPos, segment) {
        let headerSlice = this.reader.requestSliceRange(startPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
        if (headerSlice instanceof Promise)
            headerSlice = await headerSlice;
        assert(headerSlice);
        const elementStartPos = startPos;
        const elementHeader = readElementHeader(headerSlice);
        assert(elementHeader);
        const id = elementHeader.id;
        let size = elementHeader.size;
        const dataStartPos = headerSlice.filePos;
        if (size === null) {
            // The cluster's size is undefined (can happen in livestreamed files). We'd still like to know the size of
            // it, so we have no other choice but to iterate over the EBML structure until we find an element at level
            // 0 or 1, indicating the end of the cluster (all elements inside the cluster are at level 2).
            const nextElementPos = await searchForNextElementId(this.reader, dataStartPos, LEVEL_0_AND_1_EBML_IDS, segment.elementEndPos);
            size = nextElementPos.pos - dataStartPos;
        }
        assert(id === EBMLId.Cluster);
        // Load the entire cluster
        let dataSlice = this.reader.requestSlice(dataStartPos, size);
        if (dataSlice instanceof Promise)
            dataSlice = await dataSlice;
        const cluster = {
            elementStartPos,
            elementEndPos: dataStartPos + size,
            dataStartPos,
            timestamp: -1,
            trackData: new Map(),
            nextCluster: null,
            isKnownToBeFirstCluster: false,
        };
        this.currentCluster = cluster;
        if (dataSlice) {
            this.readContiguousElements(dataSlice);
        }
        for (const [trackId, trackData] of cluster.trackData) {
            const track = segment.tracks.find(x => x.id === trackId) ?? null;
            // This must hold, as track datas only get created if a block for that track is encountered
            assert(trackData.blocks.length > 0);
            let blockReferencesExist = false;
            let hasLacedBlocks = false;
            for (let i = 0; i < trackData.blocks.length; i++) {
                const block = trackData.blocks[i];
                block.timestamp += cluster.timestamp;
                blockReferencesExist ||= block.referencedTimestamps.length > 0;
                hasLacedBlocks ||= block.lacing !== BlockLacing.None;
            }
            if (blockReferencesExist) {
                trackData.blocks = sortBlocksByReferences(trackData.blocks);
            }
            trackData.presentationTimestamps = trackData.blocks
                .map((block, i) => ({ timestamp: block.timestamp, blockIndex: i }))
                .sort((a, b) => a.timestamp - b.timestamp);
            for (let i = 0; i < trackData.presentationTimestamps.length; i++) {
                const currentEntry = trackData.presentationTimestamps[i];
                const currentBlock = trackData.blocks[currentEntry.blockIndex];
                if (trackData.firstKeyFrameTimestamp === null && currentBlock.isKeyFrame) {
                    trackData.firstKeyFrameTimestamp = currentBlock.timestamp;
                }
                if (i < trackData.presentationTimestamps.length - 1) {
                    // Update block durations based on presentation order
                    const nextEntry = trackData.presentationTimestamps[i + 1];
                    currentBlock.duration = nextEntry.timestamp - currentBlock.timestamp;
                }
                else if (currentBlock.duration === 0) {
                    if (track?.defaultDuration != null) {
                        if (currentBlock.lacing === BlockLacing.None) {
                            currentBlock.duration = track.defaultDuration;
                        }
                        else {
                            // Handled by the lace resolution code
                        }
                    }
                }
            }
            if (hasLacedBlocks) {
                // Perform lace resolution. Here, we expand each laced block into multiple blocks where each contains
                // one frame of the lace. We do this after determining block timestamps so we can properly distribute
                // the block's duration across the laced frames.
                this.expandLacedBlocks(trackData.blocks, track);
                // Recompute since blocks have changed
                trackData.presentationTimestamps = trackData.blocks
                    .map((block, i) => ({ timestamp: block.timestamp, blockIndex: i }))
                    .sort((a, b) => a.timestamp - b.timestamp);
            }
            const firstBlock = trackData.blocks[trackData.presentationTimestamps[0].blockIndex];
            const lastBlock = trackData.blocks[last(trackData.presentationTimestamps).blockIndex];
            trackData.startTimestamp = firstBlock.timestamp;
            trackData.endTimestamp = lastBlock.timestamp + lastBlock.duration;
            if (track) {
                insertSorted(track.clusters, cluster, x => x.elementStartPos);
                const hasKeyFrame = trackData.firstKeyFrameTimestamp !== null;
                if (hasKeyFrame) {
                    insertSorted(track.clustersWithKeyFrame, cluster, x => x.elementStartPos);
                }
            }
        }
        insertSorted(segment.clusters, cluster, x => x.elementStartPos);
        this.currentCluster = null;
        return cluster;
    }
    getTrackDataInCluster(cluster, trackNumber) {
        let trackData = cluster.trackData.get(trackNumber);
        if (!trackData) {
            trackData = {
                startTimestamp: 0,
                endTimestamp: 0,
                firstKeyFrameTimestamp: null,
                blocks: [],
                presentationTimestamps: [],
            };
            cluster.trackData.set(trackNumber, trackData);
        }
        return trackData;
    }
    expandLacedBlocks(blocks, track) {
        // https://www.matroska.org/technical/notes.html#block-lacing
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
            const originalBlock = blocks[blockIndex];
            if (originalBlock.lacing === BlockLacing.None) {
                continue;
            }
            const slice = FileSlice.tempFromBytes(originalBlock.data);
            const frameSizes = [];
            const frameCount = readU8(slice) + 1;
            switch (originalBlock.lacing) {
                case BlockLacing.Xiph:
                    {
                        let totalUsedSize = 0;
                        // Xiph lacing, just like in Ogg
                        for (let i = 0; i < frameCount - 1; i++) {
                            let frameSize = 0;
                            while (slice.bufferPos < slice.length) {
                                const value = readU8(slice);
                                frameSize += value;
                                if (value < 255) {
                                    frameSizes.push(frameSize);
                                    totalUsedSize += frameSize;
                                    break;
                                }
                            }
                        }
                        // Compute the last frame's size from whatever's left
                        frameSizes.push(slice.length - (slice.bufferPos + totalUsedSize));
                    }
                    ;
                    break;
                case BlockLacing.FixedSize:
                    {
                        // Fixed size lacing: all frames have same size
                        const totalDataSize = slice.length - 1; // Minus the frame count byte
                        const frameSize = Math.floor(totalDataSize / frameCount);
                        for (let i = 0; i < frameCount; i++) {
                            frameSizes.push(frameSize);
                        }
                    }
                    ;
                    break;
                case BlockLacing.Ebml:
                    {
                        // EBML lacing: first size absolute, subsequent ones are coded as signed differences from the last
                        const firstResult = readVarInt(slice);
                        assert(firstResult !== null); // Assume it's not an invalid VINT
                        let currentSize = firstResult;
                        frameSizes.push(currentSize);
                        let totalUsedSize = currentSize;
                        for (let i = 1; i < frameCount - 1; i++) {
                            const startPos = slice.bufferPos;
                            const diffResult = readVarInt(slice);
                            assert(diffResult !== null);
                            const unsignedDiff = diffResult;
                            const width = slice.bufferPos - startPos;
                            const bias = (1 << (width * 7 - 1)) - 1; // Typo-corrected version of 2^((7*n)-1)^-1
                            const diff = unsignedDiff - bias;
                            currentSize += diff;
                            frameSizes.push(currentSize);
                            totalUsedSize += currentSize;
                        }
                        // Compute the last frame's size from whatever's left
                        frameSizes.push(slice.length - (slice.bufferPos + totalUsedSize));
                    }
                    ;
                    break;
                default: assert(false);
            }
            assert(frameSizes.length === frameCount);
            blocks.splice(blockIndex, 1); // Remove the original block
            // Now, let's insert each frame as its own block
            for (let i = 0; i < frameCount; i++) {
                const frameSize = frameSizes[i];
                const frameData = readBytes(slice, frameSize);
                const blockDuration = originalBlock.duration || (frameCount * (track?.defaultDuration ?? 0));
                // Distribute timestamps evenly across the block duration
                const frameTimestamp = originalBlock.timestamp + (blockDuration * i / frameCount);
                const frameDuration = blockDuration / frameCount;
                blocks.splice(blockIndex + i, 0, {
                    timestamp: frameTimestamp,
                    duration: frameDuration,
                    isKeyFrame: originalBlock.isKeyFrame,
                    referencedTimestamps: originalBlock.referencedTimestamps,
                    data: frameData,
                    lacing: BlockLacing.None,
                });
            }
            blockIndex += frameCount; // Skip the blocks we just added
            blockIndex--;
        }
    }
    async loadSegmentMetadata(segment) {
        for (const seekEntry of segment.seekEntries) {
            if (seekEntry.id === EBMLId.Tags && !segment.tagsSeen) {
                // We need to load the tags
            }
            else if (seekEntry.id === EBMLId.Attachments && !segment.attachmentsSeen) {
                // We need to load the attachments
            }
            else {
                continue;
            }
            let slice = this.reader.requestSliceRange(segment.dataStartPos + seekEntry.segmentPosition, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
            if (slice instanceof Promise)
                slice = await slice;
            if (!slice)
                continue;
            const header = readElementHeader(slice);
            if (!header || header.id !== seekEntry.id)
                continue;
            const { size } = header;
            assertDefinedSize(size);
            assert(!this.currentSegment);
            this.currentSegment = segment;
            let dataSlice = this.reader.requestSlice(slice.filePos, size);
            if (dataSlice instanceof Promise)
                dataSlice = await dataSlice;
            if (dataSlice) {
                this.readContiguousElements(dataSlice);
            }
            this.currentSegment = null;
            // Mark as seen
            if (seekEntry.id === EBMLId.Tags) {
                segment.tagsSeen = true;
            }
            else if (seekEntry.id === EBMLId.Attachments) {
                segment.attachmentsSeen = true;
            }
        }
    }
    readContiguousElements(slice) {
        const startIndex = slice.filePos;
        while (slice.filePos - startIndex <= slice.length - MIN_HEADER_SIZE) {
            const foundElement = this.traverseElement(slice);
            if (!foundElement) {
                break;
            }
        }
    }
    traverseElement(slice) {
        const header = readElementHeader(slice);
        if (!header) {
            return false;
        }
        const { id, size } = header;
        const dataStartPos = slice.filePos;
        assertDefinedSize(size);
        switch (id) {
            case EBMLId.DocType:
                {
                    this.isWebM = readAsciiString(slice, size) === 'webm';
                }
                ;
                break;
            case EBMLId.Seek:
                {
                    if (!this.currentSegment)
                        break;
                    const seekEntry = { id: -1, segmentPosition: -1 };
                    this.currentSegment.seekEntries.push(seekEntry);
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                    if (seekEntry.id === -1 || seekEntry.segmentPosition === -1) {
                        this.currentSegment.seekEntries.pop();
                    }
                }
                ;
                break;
            case EBMLId.SeekID:
                {
                    const lastSeekEntry = this.currentSegment?.seekEntries[this.currentSegment.seekEntries.length - 1];
                    if (!lastSeekEntry)
                        break;
                    lastSeekEntry.id = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.SeekPosition:
                {
                    const lastSeekEntry = this.currentSegment?.seekEntries[this.currentSegment.seekEntries.length - 1];
                    if (!lastSeekEntry)
                        break;
                    lastSeekEntry.segmentPosition = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.TimestampScale:
                {
                    if (!this.currentSegment)
                        break;
                    this.currentSegment.timestampScale = readUnsignedInt(slice, size);
                    this.currentSegment.timestampFactor = 1e9 / this.currentSegment.timestampScale;
                }
                ;
                break;
            case EBMLId.Duration:
                {
                    if (!this.currentSegment)
                        break;
                    this.currentSegment.duration = readFloat(slice, size);
                }
                ;
                break;
            case EBMLId.TrackEntry:
                {
                    if (!this.currentSegment)
                        break;
                    this.currentTrack = {
                        id: -1,
                        segment: this.currentSegment,
                        demuxer: this,
                        clusters: [],
                        clustersWithKeyFrame: [],
                        cuePoints: [],
                        isDefault: false,
                        inputTrack: null,
                        codecId: null,
                        codecPrivate: null,
                        defaultDuration: null,
                        name: null,
                        languageCode: UNDETERMINED_LANGUAGE,
                        info: null,
                    };
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                    if (this.currentTrack
                        && this.currentTrack.id !== -1
                        && this.currentTrack.codecId
                        && this.currentTrack.info) {
                        const slashIndex = this.currentTrack.codecId.indexOf('/');
                        const codecIdWithoutSuffix = slashIndex === -1
                            ? this.currentTrack.codecId
                            : this.currentTrack.codecId.slice(0, slashIndex);
                        if (this.currentTrack.info.type === 'video'
                            && this.currentTrack.info.width !== -1
                            && this.currentTrack.info.height !== -1) {
                            if (this.currentTrack.codecId === CODEC_STRING_MAP.avc) {
                                this.currentTrack.info.codec = 'avc';
                                this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
                            }
                            else if (this.currentTrack.codecId === CODEC_STRING_MAP.hevc) {
                                this.currentTrack.info.codec = 'hevc';
                                this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
                            }
                            else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vp8) {
                                this.currentTrack.info.codec = 'vp8';
                            }
                            else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vp9) {
                                this.currentTrack.info.codec = 'vp9';
                            }
                            else if (codecIdWithoutSuffix === CODEC_STRING_MAP.av1) {
                                this.currentTrack.info.codec = 'av1';
                            }
                            const videoTrack = this.currentTrack;
                            const inputTrack = new InputVideoTrack(new MatroskaVideoTrackBacking(videoTrack));
                            this.currentTrack.inputTrack = inputTrack;
                            this.currentSegment.tracks.push(this.currentTrack);
                        }
                        else if (this.currentTrack.info.type === 'audio'
                            && this.currentTrack.info.numberOfChannels !== -1
                            && this.currentTrack.info.sampleRate !== -1) {
                            if (codecIdWithoutSuffix === CODEC_STRING_MAP.aac) {
                                this.currentTrack.info.codec = 'aac';
                                this.currentTrack.info.aacCodecInfo = {
                                    isMpeg2: this.currentTrack.codecId.includes('MPEG2'),
                                };
                                this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
                            }
                            else if (this.currentTrack.codecId === CODEC_STRING_MAP.mp3) {
                                this.currentTrack.info.codec = 'mp3';
                            }
                            else if (codecIdWithoutSuffix === CODEC_STRING_MAP.opus) {
                                this.currentTrack.info.codec = 'opus';
                                this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
                            }
                            else if (codecIdWithoutSuffix === CODEC_STRING_MAP.vorbis) {
                                this.currentTrack.info.codec = 'vorbis';
                                this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
                            }
                            else if (codecIdWithoutSuffix === CODEC_STRING_MAP.flac) {
                                this.currentTrack.info.codec = 'flac';
                                this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;
                            }
                            else if (this.currentTrack.codecId === 'A_PCM/INT/LIT') {
                                if (this.currentTrack.info.bitDepth === 8) {
                                    this.currentTrack.info.codec = 'pcm-u8';
                                }
                                else if (this.currentTrack.info.bitDepth === 16) {
                                    this.currentTrack.info.codec = 'pcm-s16';
                                }
                                else if (this.currentTrack.info.bitDepth === 24) {
                                    this.currentTrack.info.codec = 'pcm-s24';
                                }
                                else if (this.currentTrack.info.bitDepth === 32) {
                                    this.currentTrack.info.codec = 'pcm-s32';
                                }
                            }
                            else if (this.currentTrack.codecId === 'A_PCM/INT/BIG') {
                                if (this.currentTrack.info.bitDepth === 8) {
                                    this.currentTrack.info.codec = 'pcm-u8';
                                }
                                else if (this.currentTrack.info.bitDepth === 16) {
                                    this.currentTrack.info.codec = 'pcm-s16be';
                                }
                                else if (this.currentTrack.info.bitDepth === 24) {
                                    this.currentTrack.info.codec = 'pcm-s24be';
                                }
                                else if (this.currentTrack.info.bitDepth === 32) {
                                    this.currentTrack.info.codec = 'pcm-s32be';
                                }
                            }
                            else if (this.currentTrack.codecId === 'A_PCM/FLOAT/IEEE') {
                                if (this.currentTrack.info.bitDepth === 32) {
                                    this.currentTrack.info.codec = 'pcm-f32';
                                }
                                else if (this.currentTrack.info.bitDepth === 64) {
                                    this.currentTrack.info.codec = 'pcm-f64';
                                }
                            }
                            const audioTrack = this.currentTrack;
                            const inputTrack = new InputAudioTrack(new MatroskaAudioTrackBacking(audioTrack));
                            this.currentTrack.inputTrack = inputTrack;
                            this.currentSegment.tracks.push(this.currentTrack);
                        }
                    }
                    this.currentTrack = null;
                }
                ;
                break;
            case EBMLId.TrackNumber:
                {
                    if (!this.currentTrack)
                        break;
                    this.currentTrack.id = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.TrackType:
                {
                    if (!this.currentTrack)
                        break;
                    const type = readUnsignedInt(slice, size);
                    if (type === 1) {
                        this.currentTrack.info = {
                            type: 'video',
                            width: -1,
                            height: -1,
                            rotation: 0,
                            codec: null,
                            codecDescription: null,
                            colorSpace: null,
                        };
                    }
                    else if (type === 2) {
                        this.currentTrack.info = {
                            type: 'audio',
                            numberOfChannels: -1,
                            sampleRate: -1,
                            bitDepth: -1,
                            codec: null,
                            codecDescription: null,
                            aacCodecInfo: null,
                        };
                    }
                }
                ;
                break;
            case EBMLId.FlagEnabled:
                {
                    if (!this.currentTrack)
                        break;
                    const enabled = readUnsignedInt(slice, size);
                    if (!enabled) {
                        this.currentSegment.tracks.pop();
                        this.currentTrack = null;
                    }
                }
                ;
                break;
            case EBMLId.FlagDefault:
                {
                    if (!this.currentTrack)
                        break;
                    this.currentTrack.isDefault = !!readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.CodecID:
                {
                    if (!this.currentTrack)
                        break;
                    this.currentTrack.codecId = readAsciiString(slice, size);
                }
                ;
                break;
            case EBMLId.CodecPrivate:
                {
                    if (!this.currentTrack)
                        break;
                    this.currentTrack.codecPrivate = readBytes(slice, size);
                }
                ;
                break;
            case EBMLId.DefaultDuration:
                {
                    if (!this.currentTrack)
                        break;
                    this.currentTrack.defaultDuration
                        = this.currentTrack.segment.timestampFactor * readUnsignedInt(slice, size) / 1e9;
                }
                ;
                break;
            case EBMLId.Name:
                {
                    if (!this.currentTrack)
                        break;
                    this.currentTrack.name = readUnicodeString(slice, size);
                }
                ;
                break;
            case EBMLId.Language:
                {
                    if (!this.currentTrack)
                        break;
                    if (this.currentTrack.languageCode !== UNDETERMINED_LANGUAGE) {
                        // LanguageBCP47 was present, which takes precedence
                        break;
                    }
                    this.currentTrack.languageCode = readAsciiString(slice, size);
                    if (!isIso639Dash2LanguageCode(this.currentTrack.languageCode)) {
                        this.currentTrack.languageCode = UNDETERMINED_LANGUAGE;
                    }
                }
                ;
                break;
            case EBMLId.LanguageBCP47:
                {
                    if (!this.currentTrack)
                        break;
                    const bcp47 = readAsciiString(slice, size);
                    const languageSubtag = bcp47.split('-')[0];
                    if (languageSubtag) {
                        // Technically invalid, for now: The language subtag might be a language code from ISO 639-1,
                        // ISO 639-2, ISO 639-3, ISO 639-5 or some other thing (source: Wikipedia). But, `languageCode` is
                        // documented as ISO 639-2. Changing the definition would be a breaking change. This will get
                        // cleaned up in the future by defining languageCode to be BCP 47 instead.
                        this.currentTrack.languageCode = languageSubtag;
                    }
                    else {
                        this.currentTrack.languageCode = UNDETERMINED_LANGUAGE;
                    }
                }
                ;
                break;
            case EBMLId.Video:
                {
                    if (this.currentTrack?.info?.type !== 'video')
                        break;
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                }
                ;
                break;
            case EBMLId.PixelWidth:
                {
                    if (this.currentTrack?.info?.type !== 'video')
                        break;
                    this.currentTrack.info.width = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.PixelHeight:
                {
                    if (this.currentTrack?.info?.type !== 'video')
                        break;
                    this.currentTrack.info.height = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.Colour:
                {
                    if (this.currentTrack?.info?.type !== 'video')
                        break;
                    this.currentTrack.info.colorSpace = {};
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                }
                ;
                break;
            case EBMLId.MatrixCoefficients:
                {
                    if (this.currentTrack?.info?.type !== 'video' || !this.currentTrack.info.colorSpace)
                        break;
                    const matrixCoefficients = readUnsignedInt(slice, size);
                    const mapped = MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients] ?? null;
                    this.currentTrack.info.colorSpace.matrix = mapped;
                }
                ;
                break;
            case EBMLId.Range:
                {
                    if (this.currentTrack?.info?.type !== 'video' || !this.currentTrack.info.colorSpace)
                        break;
                    this.currentTrack.info.colorSpace.fullRange = readUnsignedInt(slice, size) === 2;
                }
                ;
                break;
            case EBMLId.TransferCharacteristics:
                {
                    if (this.currentTrack?.info?.type !== 'video' || !this.currentTrack.info.colorSpace)
                        break;
                    const transferCharacteristics = readUnsignedInt(slice, size);
                    const mapped = TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics] ?? null;
                    this.currentTrack.info.colorSpace.transfer = mapped;
                }
                ;
                break;
            case EBMLId.Primaries:
                {
                    if (this.currentTrack?.info?.type !== 'video' || !this.currentTrack.info.colorSpace)
                        break;
                    const primaries = readUnsignedInt(slice, size);
                    const mapped = COLOR_PRIMARIES_MAP_INVERSE[primaries] ?? null;
                    this.currentTrack.info.colorSpace.primaries = mapped;
                }
                ;
                break;
            case EBMLId.Projection:
                {
                    if (this.currentTrack?.info?.type !== 'video')
                        break;
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                }
                ;
                break;
            case EBMLId.ProjectionPoseRoll:
                {
                    if (this.currentTrack?.info?.type !== 'video')
                        break;
                    const rotation = readFloat(slice, size);
                    const flippedRotation = -rotation; // Convert counter-clockwise to clockwise
                    try {
                        this.currentTrack.info.rotation = normalizeRotation(flippedRotation);
                    }
                    catch {
                        // It wasn't a valid rotation
                    }
                }
                ;
                break;
            case EBMLId.Audio:
                {
                    if (this.currentTrack?.info?.type !== 'audio')
                        break;
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                }
                ;
                break;
            case EBMLId.SamplingFrequency:
                {
                    if (this.currentTrack?.info?.type !== 'audio')
                        break;
                    this.currentTrack.info.sampleRate = readFloat(slice, size);
                }
                ;
                break;
            case EBMLId.Channels:
                {
                    if (this.currentTrack?.info?.type !== 'audio')
                        break;
                    this.currentTrack.info.numberOfChannels = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.BitDepth:
                {
                    if (this.currentTrack?.info?.type !== 'audio')
                        break;
                    this.currentTrack.info.bitDepth = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.CuePoint:
                {
                    if (!this.currentSegment)
                        break;
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                    this.currentCueTime = null;
                }
                ;
                break;
            case EBMLId.CueTime:
                {
                    this.currentCueTime = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.CueTrackPositions:
                {
                    if (this.currentCueTime === null)
                        break;
                    assert(this.currentSegment);
                    const cuePoint = { time: this.currentCueTime, trackId: -1, clusterPosition: -1 };
                    this.currentSegment.cuePoints.push(cuePoint);
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                    if (cuePoint.trackId === -1 || cuePoint.clusterPosition === -1) {
                        this.currentSegment.cuePoints.pop();
                    }
                }
                ;
                break;
            case EBMLId.CueTrack:
                {
                    const lastCuePoint = this.currentSegment?.cuePoints[this.currentSegment.cuePoints.length - 1];
                    if (!lastCuePoint)
                        break;
                    lastCuePoint.trackId = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.CueClusterPosition:
                {
                    const lastCuePoint = this.currentSegment?.cuePoints[this.currentSegment.cuePoints.length - 1];
                    if (!lastCuePoint)
                        break;
                    assert(this.currentSegment);
                    lastCuePoint.clusterPosition = this.currentSegment.dataStartPos + readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.Timestamp:
                {
                    if (!this.currentCluster)
                        break;
                    this.currentCluster.timestamp = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.SimpleBlock:
                {
                    if (!this.currentCluster)
                        break;
                    const trackNumber = readVarInt(slice);
                    if (trackNumber === null)
                        break;
                    const relativeTimestamp = readI16Be(slice);
                    const flags = readU8(slice);
                    const isKeyFrame = !!(flags & 0x80);
                    const lacing = (flags >> 1) & 0x3; // If the block is laced, we'll expand it later
                    const trackData = this.getTrackDataInCluster(this.currentCluster, trackNumber);
                    trackData.blocks.push({
                        timestamp: relativeTimestamp, // We'll add the cluster's timestamp to this later
                        duration: 0, // Will set later
                        isKeyFrame,
                        referencedTimestamps: [],
                        data: readBytes(slice, size - (slice.filePos - dataStartPos)),
                        lacing,
                    });
                }
                ;
                break;
            case EBMLId.BlockGroup:
                {
                    if (!this.currentCluster)
                        break;
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                    if (this.currentBlock) {
                        for (let i = 0; i < this.currentBlock.referencedTimestamps.length; i++) {
                            this.currentBlock.referencedTimestamps[i] += this.currentBlock.timestamp;
                        }
                        this.currentBlock = null;
                    }
                }
                ;
                break;
            case EBMLId.Block:
                {
                    if (!this.currentCluster)
                        break;
                    const trackNumber = readVarInt(slice);
                    if (trackNumber === null)
                        break;
                    const relativeTimestamp = readI16Be(slice);
                    const flags = readU8(slice);
                    const lacing = (flags >> 1) & 0x3; // If the block is laced, we'll expand it later
                    const trackData = this.getTrackDataInCluster(this.currentCluster, trackNumber);
                    this.currentBlock = {
                        timestamp: relativeTimestamp, // We'll add the cluster's timestamp to this later
                        duration: 0, // Will set later
                        isKeyFrame: true,
                        referencedTimestamps: [],
                        data: readBytes(slice, size - (slice.filePos - dataStartPos)),
                        lacing,
                    };
                    trackData.blocks.push(this.currentBlock);
                }
                ;
                break;
            case EBMLId.BlockDuration:
                {
                    if (!this.currentBlock)
                        break;
                    this.currentBlock.duration = readUnsignedInt(slice, size);
                }
                ;
                break;
            case EBMLId.ReferenceBlock:
                {
                    if (!this.currentBlock)
                        break;
                    this.currentBlock.isKeyFrame = false;
                    const relativeTimestamp = readSignedInt(slice, size);
                    // We'll offset this by the block's timestamp later
                    this.currentBlock.referencedTimestamps.push(relativeTimestamp);
                }
                ;
                break;
            case EBMLId.Tag:
                {
                    this.currentTagTargetIsMovie = true;
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                }
                ;
                break;
            case EBMLId.Targets:
                {
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                }
                ;
                break;
            case EBMLId.TargetTypeValue:
                {
                    const targetTypeValue = readUnsignedInt(slice, size);
                    if (targetTypeValue !== 50) {
                        this.currentTagTargetIsMovie = false;
                    }
                }
                ;
                break;
            case EBMLId.TagTrackUID:
            case EBMLId.TagEditionUID:
            case EBMLId.TagChapterUID:
            case EBMLId.TagAttachmentUID:
                {
                    this.currentTagTargetIsMovie = false;
                }
                ;
                break;
            case EBMLId.SimpleTag:
                {
                    if (!this.currentTagTargetIsMovie)
                        break;
                    this.currentSimpleTagName = null;
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                }
                ;
                break;
            case EBMLId.TagName:
                {
                    this.currentSimpleTagName = readUnicodeString(slice, size);
                }
                ;
                break;
            case EBMLId.TagString:
                {
                    if (!this.currentSimpleTagName)
                        break;
                    const value = readUnicodeString(slice, size);
                    this.processTagValue(this.currentSimpleTagName, value);
                }
                ;
                break;
            case EBMLId.TagBinary:
                {
                    if (!this.currentSimpleTagName)
                        break;
                    const value = readBytes(slice, size);
                    this.processTagValue(this.currentSimpleTagName, value);
                }
                ;
                break;
            case EBMLId.AttachedFile:
                {
                    if (!this.currentSegment)
                        break;
                    this.currentAttachedFile = {
                        fileName: null,
                        fileMediaType: null,
                        fileData: null,
                        fileDescription: null,
                    };
                    this.readContiguousElements(slice.slice(dataStartPos, size));
                    // Only process image attachments
                    if (this.currentAttachedFile.fileMediaType?.startsWith('image/') && this.currentAttachedFile.fileData) {
                        const fileName = this.currentAttachedFile.fileName;
                        let kind = 'unknown';
                        if (fileName) {
                            const lowerName = fileName.toLowerCase();
                            if (lowerName.startsWith('cover.')) {
                                kind = 'coverFront';
                            }
                            else if (lowerName.startsWith('back.')) {
                                kind = 'coverBack';
                            }
                        }
                        this.currentSegment.metadataTags.images ??= [];
                        this.currentSegment.metadataTags.images.push({
                            data: this.currentAttachedFile.fileData,
                            mimeType: this.currentAttachedFile.fileMediaType,
                            kind,
                            name: this.currentAttachedFile.fileName ?? undefined,
                            description: this.currentAttachedFile.fileDescription ?? undefined,
                        });
                    }
                    this.currentAttachedFile = null;
                }
                ;
                break;
            case EBMLId.FileName:
                {
                    if (!this.currentAttachedFile)
                        break;
                    this.currentAttachedFile.fileName = readUnicodeString(slice, size);
                }
                ;
                break;
            case EBMLId.FileMediaType:
                {
                    if (!this.currentAttachedFile)
                        break;
                    this.currentAttachedFile.fileMediaType = readAsciiString(slice, size);
                }
                ;
                break;
            case EBMLId.FileData:
                {
                    if (!this.currentAttachedFile)
                        break;
                    this.currentAttachedFile.fileData = readBytes(slice, size);
                }
                ;
                break;
            case EBMLId.FileDescription:
                {
                    if (!this.currentAttachedFile)
                        break;
                    this.currentAttachedFile.fileDescription = readUnicodeString(slice, size);
                }
                ;
                break;
        }
        slice.filePos = dataStartPos + size;
        return true;
    }
    processTagValue(name, value) {
        if (!this.currentSegment?.metadataTags)
            return;
        const metadataTags = this.currentSegment.metadataTags;
        metadataTags.raw ??= {};
        metadataTags.raw[name] ??= value;
        if (typeof value === 'string') {
            switch (name.toLowerCase()) {
                case 'title':
                    {
                        metadataTags.title ??= value;
                    }
                    ;
                    break;
                case 'description':
                    {
                        metadataTags.description ??= value;
                    }
                    ;
                    break;
                case 'artist':
                    {
                        metadataTags.artist ??= value;
                    }
                    ;
                    break;
                case 'album':
                    {
                        metadataTags.album ??= value;
                    }
                    ;
                    break;
                case 'album_artist':
                    {
                        metadataTags.albumArtist ??= value;
                    }
                    ;
                    break;
                case 'genre':
                    {
                        metadataTags.genre ??= value;
                    }
                    ;
                    break;
                case 'comment':
                    {
                        metadataTags.comment ??= value;
                    }
                    ;
                    break;
                case 'lyrics':
                    {
                        metadataTags.lyrics ??= value;
                    }
                    ;
                    break;
                case 'date':
                    {
                        const date = new Date(value);
                        if (!Number.isNaN(date.getTime())) {
                            metadataTags.date ??= date;
                        }
                    }
                    ;
                    break;
                case 'track_number':
                case 'part_number':
                    {
                        const parts = value.split('/');
                        const trackNum = Number.parseInt(parts[0], 10);
                        const tracksTotal = parts[1] && Number.parseInt(parts[1], 10);
                        if (Number.isInteger(trackNum) && trackNum > 0) {
                            metadataTags.trackNumber ??= trackNum;
                        }
                        if (tracksTotal && Number.isInteger(tracksTotal) && tracksTotal > 0) {
                            metadataTags.tracksTotal ??= tracksTotal;
                        }
                    }
                    ;
                    break;
                case 'disc_number':
                case 'disc':
                    {
                        const discParts = value.split('/');
                        const discNum = Number.parseInt(discParts[0], 10);
                        const discsTotal = discParts[1] && Number.parseInt(discParts[1], 10);
                        if (Number.isInteger(discNum) && discNum > 0) {
                            metadataTags.discNumber ??= discNum;
                        }
                        if (discsTotal && Number.isInteger(discsTotal) && discsTotal > 0) {
                            metadataTags.discsTotal ??= discsTotal;
                        }
                    }
                    ;
                    break;
            }
        }
    }
}
class MatroskaTrackBacking {
    constructor(internalTrack) {
        this.internalTrack = internalTrack;
        this.packetToClusterLocation = new WeakMap();
    }
    getId() {
        return this.internalTrack.id;
    }
    getCodec() {
        throw new Error('Not implemented on base class.');
    }
    getInternalCodecId() {
        return this.internalTrack.codecId;
    }
    async computeDuration() {
        const lastPacket = await this.getPacket(Infinity, { metadataOnly: true });
        return (lastPacket?.timestamp ?? 0) + (lastPacket?.duration ?? 0);
    }
    getName() {
        return this.internalTrack.name;
    }
    getLanguageCode() {
        return this.internalTrack.languageCode;
    }
    async getFirstTimestamp() {
        const firstPacket = await this.getFirstPacket({ metadataOnly: true });
        return firstPacket?.timestamp ?? 0;
    }
    getTimeResolution() {
        return this.internalTrack.segment.timestampFactor;
    }
    async getFirstPacket(options) {
        return this.performClusterLookup(() => {
            const startCluster = this.internalTrack.segment.clusters[0] ?? null;
            if (startCluster?.isKnownToBeFirstCluster) {
                // Walk from the very first cluster in the file until we find one with our track in it
                let currentCluster = startCluster;
                while (currentCluster) {
                    const trackData = currentCluster.trackData.get(this.internalTrack.id);
                    if (trackData) {
                        return {
                            clusterIndex: binarySearchExact(this.internalTrack.clusters, currentCluster.elementStartPos, x => x.elementStartPos),
                            blockIndex: 0,
                            correctBlockFound: true,
                        };
                    }
                    currentCluster = currentCluster.nextCluster;
                }
            }
            return {
                clusterIndex: -1,
                blockIndex: -1,
                correctBlockFound: false,
            };
        }, -Infinity, // Use -Infinity as a search timestamp to avoid using the cues
        Infinity, options);
    }
    intoTimescale(timestamp) {
        // Do a little rounding to catch cases where the result is very close to an integer. If it is, it's likely
        // that the number was originally an integer divided by the timescale. For stability, it's best
        // to return the integer in this case.
        return roundToPrecision(timestamp * this.internalTrack.segment.timestampFactor, 14);
    }
    async getPacket(timestamp, options) {
        const timestampInTimescale = this.intoTimescale(timestamp);
        return this.performClusterLookup(() => this.findBlockInClustersForTimestamp(timestampInTimescale), timestampInTimescale, timestampInTimescale, options);
    }
    async getNextPacket(packet, options) {
        const locationInCluster = this.packetToClusterLocation.get(packet);
        if (locationInCluster === undefined) {
            throw new Error('Packet was not created from this track.');
        }
        const trackData = locationInCluster.cluster.trackData.get(this.internalTrack.id);
        const clusterIndex = binarySearchExact(this.internalTrack.clusters, locationInCluster.cluster.elementStartPos, x => x.elementStartPos);
        assert(clusterIndex !== -1);
        return this.performClusterLookup(() => {
            if (locationInCluster.blockIndex + 1 < trackData.blocks.length) {
                // We can simply take the next block in the cluster
                return {
                    clusterIndex,
                    blockIndex: locationInCluster.blockIndex + 1,
                    correctBlockFound: true,
                };
            }
            else {
                // Walk the list of clusters until we find the next cluster for this track
                let currentCluster = locationInCluster.cluster;
                while (currentCluster.nextCluster) {
                    currentCluster = currentCluster.nextCluster;
                    const trackData = currentCluster.trackData.get(this.internalTrack.id);
                    if (trackData) {
                        const clusterIndex = binarySearchExact(this.internalTrack.clusters, currentCluster.elementStartPos, x => x.elementStartPos);
                        assert(clusterIndex !== -1);
                        return {
                            clusterIndex,
                            blockIndex: 0,
                            correctBlockFound: true,
                        };
                    }
                }
                return {
                    clusterIndex,
                    blockIndex: -1,
                    correctBlockFound: false,
                };
            }
        }, -Infinity, // Use -Infinity as a search timestamp to avoid using the cues
        Infinity, options);
    }
    async getKeyPacket(timestamp, options) {
        const timestampInTimescale = this.intoTimescale(timestamp);
        return this.performClusterLookup(() => this.findKeyBlockInClustersForTimestamp(timestampInTimescale), timestampInTimescale, timestampInTimescale, options);
    }
    async getNextKeyPacket(packet, options) {
        const locationInCluster = this.packetToClusterLocation.get(packet);
        if (locationInCluster === undefined) {
            throw new Error('Packet was not created from this track.');
        }
        const trackData = locationInCluster.cluster.trackData.get(this.internalTrack.id);
        const clusterIndex = binarySearchExact(this.internalTrack.clusters, locationInCluster.cluster.elementStartPos, x => x.elementStartPos);
        assert(clusterIndex !== -1);
        return this.performClusterLookup(() => {
            const nextKeyFrameIndex = trackData.blocks.findIndex((x, i) => x.isKeyFrame && i > locationInCluster.blockIndex);
            if (nextKeyFrameIndex !== -1) {
                // We can simply take the next key frame in the cluster
                return {
                    clusterIndex,
                    blockIndex: nextKeyFrameIndex,
                    correctBlockFound: true,
                };
            }
            else {
                // Walk the list of clusters until we find the next cluster for this track with a key frame
                let currentCluster = locationInCluster.cluster;
                while (currentCluster.nextCluster) {
                    currentCluster = currentCluster.nextCluster;
                    const trackData = currentCluster.trackData.get(this.internalTrack.id);
                    if (trackData && trackData.firstKeyFrameTimestamp !== null) {
                        const clusterIndex = binarySearchExact(this.internalTrack.clusters, currentCluster.elementStartPos, x => x.elementStartPos);
                        assert(clusterIndex !== -1);
                        const keyFrameIndex = trackData.blocks.findIndex(x => x.isKeyFrame);
                        assert(keyFrameIndex !== -1); // There must be one
                        return {
                            clusterIndex,
                            blockIndex: keyFrameIndex,
                            correctBlockFound: true,
                        };
                    }
                }
                return {
                    clusterIndex,
                    blockIndex: -1,
                    correctBlockFound: false,
                };
            }
        }, -Infinity, // Use -Infinity as a search timestamp to avoid using the cues
        Infinity, options);
    }
    async fetchPacketInCluster(cluster, blockIndex, options) {
        if (blockIndex === -1) {
            return null;
        }
        const trackData = cluster.trackData.get(this.internalTrack.id);
        const block = trackData.blocks[blockIndex];
        assert(block);
        const data = options.metadataOnly ? PLACEHOLDER_DATA : block.data;
        const timestamp = block.timestamp / this.internalTrack.segment.timestampFactor;
        const duration = block.duration / this.internalTrack.segment.timestampFactor;
        const packet = new EncodedPacket(data, block.isKeyFrame ? 'key' : 'delta', timestamp, duration, cluster.dataStartPos + blockIndex, block.data.byteLength);
        this.packetToClusterLocation.set(packet, { cluster, blockIndex });
        return packet;
    }
    findBlockInClustersForTimestamp(timestampInTimescale) {
        const clusterIndex = binarySearchLessOrEqual(
        // This array is technically not sorted by start timestamp, but for any reasonable file, it basically is.
        this.internalTrack.clusters, timestampInTimescale, x => x.trackData.get(this.internalTrack.id).startTimestamp);
        let blockIndex = -1;
        let correctBlockFound = false;
        if (clusterIndex !== -1) {
            const cluster = this.internalTrack.clusters[clusterIndex];
            const trackData = cluster.trackData.get(this.internalTrack.id);
            const index = binarySearchLessOrEqual(trackData.presentationTimestamps, timestampInTimescale, x => x.timestamp);
            assert(index !== -1);
            blockIndex = trackData.presentationTimestamps[index].blockIndex;
            correctBlockFound = timestampInTimescale < trackData.endTimestamp;
        }
        return { clusterIndex, blockIndex, correctBlockFound };
    }
    findKeyBlockInClustersForTimestamp(timestampInTimescale) {
        const indexInKeyFrameClusters = binarySearchLessOrEqual(
        // This array is technically not sorted by start timestamp, but for any reasonable file, it basically is.
        this.internalTrack.clustersWithKeyFrame, timestampInTimescale, x => x.trackData.get(this.internalTrack.id).firstKeyFrameTimestamp);
        let clusterIndex = -1;
        let blockIndex = -1;
        let correctBlockFound = false;
        if (indexInKeyFrameClusters !== -1) {
            const cluster = this.internalTrack.clustersWithKeyFrame[indexInKeyFrameClusters];
            // Now, let's find the actual index of the cluster in the list of ALL clusters, not just key frame ones
            clusterIndex = binarySearchExact(this.internalTrack.clusters, cluster.elementStartPos, x => x.elementStartPos);
            assert(clusterIndex !== -1);
            const trackData = cluster.trackData.get(this.internalTrack.id);
            const index = findLastIndex(trackData.presentationTimestamps, (x) => {
                const block = trackData.blocks[x.blockIndex];
                return block.isKeyFrame && x.timestamp <= timestampInTimescale;
            });
            assert(index !== -1); // It's a key frame cluster, so there must be a key frame
            const entry = trackData.presentationTimestamps[index];
            blockIndex = entry.blockIndex;
            correctBlockFound = timestampInTimescale < trackData.endTimestamp;
        }
        return { clusterIndex, blockIndex, correctBlockFound };
    }
    /** Looks for a packet in the clusters while trying to load as few clusters as possible to retrieve it. */
    async performClusterLookup(
    // This function returns the best-matching block that is currently loaded. Based on this information, we know
    // which clusters we need to load to find the actual match.
    getBestMatch, 
    // The timestamp with which we can search the lookup table
    searchTimestamp, 
    // The timestamp for which we know the correct block will not come after it
    latestTimestamp, options) {
        const { demuxer, segment } = this.internalTrack;
        const release = await segment.clusterLookupMutex.acquire(); // The algorithm requires exclusivity
        try {
            const { clusterIndex, blockIndex, correctBlockFound } = getBestMatch();
            if (correctBlockFound) {
                // The correct block already exists, easy path.
                const cluster = this.internalTrack.clusters[clusterIndex];
                return this.fetchPacketInCluster(cluster, blockIndex, options);
            }
            let prevCluster = null;
            let bestClusterIndex = clusterIndex;
            let bestBlockIndex = blockIndex;
            // Search for a cue point; this way, we won't need to start searching from the start of the file
            // but can jump right into the correct cluster (or at least nearby).
            const cuePointIndex = binarySearchLessOrEqual(this.internalTrack.cuePoints, searchTimestamp, x => x.time);
            const cuePoint = cuePointIndex !== -1 ? this.internalTrack.cuePoints[cuePointIndex] : null;
            let currentPos;
            let nextClusterIsFirstCluster = false;
            if (clusterIndex === -1) {
                currentPos = cuePoint?.clusterPosition ?? segment.clusterSeekStartPos;
                nextClusterIsFirstCluster = currentPos === segment.clusterSeekStartPos;
            }
            else {
                const cluster = this.internalTrack.clusters[clusterIndex];
                if (!cuePoint || cluster.elementStartPos >= cuePoint.clusterPosition) {
                    currentPos = cluster.elementEndPos;
                    prevCluster = cluster;
                }
                else {
                    // Use the lookup entry
                    currentPos = cuePoint.clusterPosition;
                }
            }
            while (segment.elementEndPos === null || currentPos <= segment.elementEndPos - MIN_HEADER_SIZE) {
                if (prevCluster) {
                    const trackData = prevCluster.trackData.get(this.internalTrack.id);
                    if (trackData && trackData.startTimestamp > latestTimestamp) {
                        // We're already past the upper bound, no need to keep searching
                        break;
                    }
                    if (prevCluster.nextCluster) {
                        // Skip ahead quickly without needing to read the file again
                        currentPos = prevCluster.nextCluster.elementEndPos;
                        prevCluster = prevCluster.nextCluster;
                        continue;
                    }
                }
                // Load the header
                let slice = demuxer.reader.requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
                if (slice instanceof Promise)
                    slice = await slice;
                if (!slice)
                    break;
                const elementStartPos = currentPos;
                const elementHeader = readElementHeader(slice);
                if (!elementHeader
                    || (!LEVEL_1_EBML_IDS.includes(elementHeader.id) && elementHeader.id !== EBMLId.Void)) {
                    // There's an element here that shouldn't be here. Might be garbage. In this case, let's
                    // try and resync to the next valid element.
                    const nextPos = await resync(demuxer.reader, elementStartPos, LEVEL_1_EBML_IDS, Math.min(segment.elementEndPos ?? Infinity, elementStartPos + MAX_RESYNC_LENGTH));
                    if (nextPos) {
                        currentPos = nextPos;
                        continue;
                    }
                    else {
                        break; // Resync failed
                    }
                }
                const id = elementHeader.id;
                let size = elementHeader.size;
                const dataStartPos = slice.filePos;
                if (id === EBMLId.Cluster) {
                    const index = binarySearchExact(segment.clusters, elementStartPos, x => x.elementStartPos);
                    let cluster;
                    if (index === -1) {
                        // This is the first time we've seen this cluster
                        cluster = await demuxer.readCluster(elementStartPos, segment);
                    }
                    else {
                        // We already know this cluster
                        cluster = segment.clusters[index];
                    }
                    // Even if we already know the cluster, we might not yet know its predecessor, so always do this
                    if (prevCluster)
                        prevCluster.nextCluster = cluster;
                    prevCluster = cluster;
                    if (nextClusterIsFirstCluster) {
                        cluster.isKnownToBeFirstCluster = true;
                        nextClusterIsFirstCluster = false;
                    }
                    const { clusterIndex, blockIndex, correctBlockFound } = getBestMatch();
                    if (correctBlockFound) {
                        const cluster = this.internalTrack.clusters[clusterIndex];
                        return this.fetchPacketInCluster(cluster, blockIndex, options);
                    }
                    if (clusterIndex !== -1) {
                        bestClusterIndex = clusterIndex;
                        bestBlockIndex = blockIndex;
                    }
                }
                if (size === null) {
                    // Undefined element size (can happen in livestreamed files). In this case, we need to do some
                    // searching to determine the actual size of the element.
                    if (id === EBMLId.Cluster) {
                        // The cluster should have already computed its length, we can just copy that result
                        assert(prevCluster);
                        size = prevCluster.elementEndPos - dataStartPos;
                    }
                    else {
                        // Search for the next element at level 0 or 1
                        const nextElementPos = await searchForNextElementId(demuxer.reader, dataStartPos, LEVEL_0_AND_1_EBML_IDS, segment.elementEndPos);
                        size = nextElementPos.pos - dataStartPos;
                    }
                    const endPos = dataStartPos + size;
                    if (segment.elementEndPos !== null && endPos > segment.elementEndPos - MIN_HEADER_SIZE) {
                        // No more elements fit in this segment
                        break;
                    }
                    else {
                        // Check the next element. If it's a new segment, we know this segment ends here. The new
                        // segment is just ignored, since we're likely in a livestreamed file and thus only care about
                        // the first segment.
                        let slice = demuxer.reader.requestSliceRange(endPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE);
                        if (slice instanceof Promise)
                            slice = await slice;
                        if (!slice)
                            break;
                        const elementId = readElementId(slice);
                        if (elementId === EBMLId.Segment) {
                            segment.elementEndPos = endPos;
                            break;
                        }
                    }
                }
                currentPos = dataStartPos + size;
            }
            const bestCluster = bestClusterIndex !== -1 ? this.internalTrack.clusters[bestClusterIndex] : null;
            // Catch faulty cue points
            if (cuePoint && (!bestCluster || bestCluster.elementStartPos < cuePoint.clusterPosition)) {
                // The cue point lied to us! We found a cue point but no cluster there that satisfied the match. In this
                // case, let's search again but using the cue point before that.
                const previousCuePoint = this.internalTrack.cuePoints[cuePointIndex - 1];
                const newSearchTimestamp = previousCuePoint?.time ?? -Infinity;
                return this.performClusterLookup(getBestMatch, newSearchTimestamp, latestTimestamp, options);
            }
            if (bestCluster) {
                // If we finished looping but didn't find a perfect match, still return the best match we found
                return this.fetchPacketInCluster(bestCluster, bestBlockIndex, options);
            }
            return null;
        }
        finally {
            release();
        }
    }
}
class MatroskaVideoTrackBacking extends MatroskaTrackBacking {
    constructor(internalTrack) {
        super(internalTrack);
        this.decoderConfigPromise = null;
        this.internalTrack = internalTrack;
    }
    getCodec() {
        return this.internalTrack.info.codec;
    }
    getCodedWidth() {
        return this.internalTrack.info.width;
    }
    getCodedHeight() {
        return this.internalTrack.info.height;
    }
    getRotation() {
        return this.internalTrack.info.rotation;
    }
    async getColorSpace() {
        return {
            primaries: this.internalTrack.info.colorSpace?.primaries,
            transfer: this.internalTrack.info.colorSpace?.transfer,
            matrix: this.internalTrack.info.colorSpace?.matrix,
            fullRange: this.internalTrack.info.colorSpace?.fullRange,
        };
    }
    async getDecoderConfig() {
        if (!this.internalTrack.info.codec) {
            return null;
        }
        return this.decoderConfigPromise ??= (async () => {
            let firstPacket = null;
            const needsPacketForAdditionalInfo = this.internalTrack.info.codec === 'vp9'
                || this.internalTrack.info.codec === 'av1'
                // Packets are in Annex B format:
                || (this.internalTrack.info.codec === 'avc' && !this.internalTrack.info.codecDescription)
                // Packets are in Annex B format:
                || (this.internalTrack.info.codec === 'hevc' && !this.internalTrack.info.codecDescription);
            if (needsPacketForAdditionalInfo) {
                firstPacket = await this.getFirstPacket({});
            }
            return {
                codec: extractVideoCodecString({
                    width: this.internalTrack.info.width,
                    height: this.internalTrack.info.height,
                    codec: this.internalTrack.info.codec,
                    codecDescription: this.internalTrack.info.codecDescription,
                    colorSpace: this.internalTrack.info.colorSpace,
                    avcCodecInfo: this.internalTrack.info.codec === 'avc' && firstPacket
                        ? extractAvcDecoderConfigurationRecord(firstPacket.data)
                        : null,
                    hevcCodecInfo: this.internalTrack.info.codec === 'hevc' && firstPacket
                        ? extractHevcDecoderConfigurationRecord(firstPacket.data)
                        : null,
                    vp9CodecInfo: this.internalTrack.info.codec === 'vp9' && firstPacket
                        ? extractVp9CodecInfoFromPacket(firstPacket.data)
                        : null,
                    av1CodecInfo: this.internalTrack.info.codec === 'av1' && firstPacket
                        ? extractAv1CodecInfoFromPacket(firstPacket.data)
                        : null,
                }),
                codedWidth: this.internalTrack.info.width,
                codedHeight: this.internalTrack.info.height,
                description: this.internalTrack.info.codecDescription ?? undefined,
                colorSpace: this.internalTrack.info.colorSpace ?? undefined,
            };
        })();
    }
}
class MatroskaAudioTrackBacking extends MatroskaTrackBacking {
    constructor(internalTrack) {
        super(internalTrack);
        this.decoderConfig = null;
        this.internalTrack = internalTrack;
    }
    getCodec() {
        return this.internalTrack.info.codec;
    }
    getNumberOfChannels() {
        return this.internalTrack.info.numberOfChannels;
    }
    getSampleRate() {
        return this.internalTrack.info.sampleRate;
    }
    async getDecoderConfig() {
        if (!this.internalTrack.info.codec) {
            return null;
        }
        return this.decoderConfig ??= {
            codec: extractAudioCodecString({
                codec: this.internalTrack.info.codec,
                codecDescription: this.internalTrack.info.codecDescription,
                aacCodecInfo: this.internalTrack.info.aacCodecInfo,
            }),
            numberOfChannels: this.internalTrack.info.numberOfChannels,
            sampleRate: this.internalTrack.info.sampleRate,
            description: this.internalTrack.info.codecDescription ?? undefined,
        };
    }
}
/** Sorts blocks such that referenced blocks come before the blocks that reference them. */
const sortBlocksByReferences = (blocks) => {
    const timestampToBlock = new Map();
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        timestampToBlock.set(block.timestamp, block);
    }
    const processedBlocks = new Set();
    const result = [];
    const processBlock = (block) => {
        if (processedBlocks.has(block)) {
            return;
        }
        // Marking the block as processed here already; prevents this algorithm from dying on cycles
        processedBlocks.add(block);
        for (let j = 0; j < block.referencedTimestamps.length; j++) {
            const timestamp = block.referencedTimestamps[j];
            const otherBlock = timestampToBlock.get(timestamp);
            if (!otherBlock) {
                continue;
            }
            processBlock(otherBlock);
        }
        result.push(block);
    };
    for (let i = 0; i < blocks.length; i++) {
        processBlock(blocks[i]);
    }
    return result;
};
