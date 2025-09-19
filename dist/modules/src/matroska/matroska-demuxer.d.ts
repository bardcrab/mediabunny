/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AacCodecInfo, AudioCodec, VideoCodec } from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputTrack } from '../input-track';
import { MetadataTags } from '../tags';
import { AsyncMutex, Rotation } from '../misc';
import { FileSlice, Reader } from '../reader';
type Segment = {
    seekHeadSeen: boolean;
    infoSeen: boolean;
    tracksSeen: boolean;
    cuesSeen: boolean;
    attachmentsSeen: boolean;
    tagsSeen: boolean;
    timestampScale: number;
    timestampFactor: number;
    duration: number;
    seekEntries: SeekEntry[];
    tracks: InternalTrack[];
    cuePoints: CuePoint[];
    dataStartPos: number;
    elementEndPos: number | null;
    clusterSeekStartPos: number;
    clusters: Cluster[];
    clusterLookupMutex: AsyncMutex;
    metadataTags: MetadataTags;
    metadataTagsCollected: boolean;
};
type SeekEntry = {
    id: number;
    segmentPosition: number;
};
type Cluster = {
    elementStartPos: number;
    elementEndPos: number;
    dataStartPos: number;
    timestamp: number;
    trackData: Map<number, ClusterTrackData>;
    nextCluster: Cluster | null;
    isKnownToBeFirstCluster: boolean;
};
type ClusterTrackData = {
    startTimestamp: number;
    endTimestamp: number;
    firstKeyFrameTimestamp: number | null;
    blocks: ClusterBlock[];
    presentationTimestamps: {
        timestamp: number;
        blockIndex: number;
    }[];
};
declare enum BlockLacing {
    None = 0,
    Xiph = 1,
    FixedSize = 2,
    Ebml = 3
}
type ClusterBlock = {
    timestamp: number;
    duration: number;
    isKeyFrame: boolean;
    referencedTimestamps: number[];
    data: Uint8Array;
    lacing: BlockLacing;
};
type CuePoint = {
    time: number;
    trackId: number;
    clusterPosition: number;
};
type InternalTrack = {
    id: number;
    demuxer: MatroskaDemuxer;
    segment: Segment;
    clusters: Cluster[];
    clustersWithKeyFrame: Cluster[];
    cuePoints: CuePoint[];
    isDefault: boolean;
    inputTrack: InputTrack | null;
    codecId: string | null;
    codecPrivate: Uint8Array | null;
    defaultDuration: number | null;
    name: string | null;
    languageCode: string;
    info: null | {
        type: 'video';
        width: number;
        height: number;
        rotation: Rotation;
        codec: VideoCodec | null;
        codecDescription: Uint8Array | null;
        colorSpace: VideoColorSpaceInit | null;
    } | {
        type: 'audio';
        numberOfChannels: number;
        sampleRate: number;
        bitDepth: number;
        codec: AudioCodec | null;
        codecDescription: Uint8Array | null;
        aacCodecInfo: AacCodecInfo | null;
    };
};
export declare class MatroskaDemuxer extends Demuxer {
    reader: Reader;
    readMetadataPromise: Promise<void> | null;
    segments: Segment[];
    currentSegment: Segment | null;
    currentTrack: InternalTrack | null;
    currentCluster: Cluster | null;
    currentBlock: ClusterBlock | null;
    currentCueTime: number | null;
    currentTagTargetIsMovie: boolean;
    currentSimpleTagName: string | null;
    currentAttachedFile: {
        fileName: string | null;
        fileMediaType: string | null;
        fileData: Uint8Array | null;
        fileDescription: string | null;
    } | null;
    isWebM: boolean;
    constructor(input: Input);
    computeDuration(): Promise<number>;
    getTracks(): Promise<InputTrack[]>;
    getMimeType(): Promise<string>;
    getMetadataTags(): Promise<MetadataTags>;
    readMetadata(): Promise<void>;
    readSegment(segmentDataStart: number, dataSize: number | null): Promise<void>;
    readCluster(startPos: number, segment: Segment): Promise<Cluster>;
    getTrackDataInCluster(cluster: Cluster, trackNumber: number): ClusterTrackData;
    expandLacedBlocks(blocks: ClusterBlock[], track: InternalTrack | null): void;
    loadSegmentMetadata(segment: Segment): Promise<void>;
    readContiguousElements(slice: FileSlice): void;
    traverseElement(slice: FileSlice): boolean;
    processTagValue(name: string, value: string | Uint8Array): void;
}
export {};
//# sourceMappingURL=matroska-demuxer.d.ts.map