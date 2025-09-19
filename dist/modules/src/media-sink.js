/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { parsePcmCodec, PCM_AUDIO_CODECS } from './codec.js';
import { extractHevcNalUnits, extractNalUnitTypeForHevc, HevcNalUnitType } from './codec-data.js';
import { customVideoDecoders, customAudioDecoders } from './custom-coder.js';
import { InputAudioTrack, InputTrack, InputVideoTrack } from './input-track.js';
import { assert, assertNever, CallSerializer, getInt24, getUint24, insertSorted, isSafari, last, mapAsyncGenerator, promiseWithResolvers, toAsyncIterator, toDataView, validateAnyIterable, } from './misc.js';
import { EncodedPacket } from './packet.js';
import { fromAlaw, fromUlaw } from './pcm.js';
import { AudioSample, VideoSample } from './sample.js';
const validatePacketRetrievalOptions = (options) => {
    if (!options || typeof options !== 'object') {
        throw new TypeError('options must be an object.');
    }
    if (options.metadataOnly !== undefined && typeof options.metadataOnly !== 'boolean') {
        throw new TypeError('options.metadataOnly, when defined, must be a boolean.');
    }
    if (options.verifyKeyPackets !== undefined && typeof options.verifyKeyPackets !== 'boolean') {
        throw new TypeError('options.verifyKeyPackets, when defined, must be a boolean.');
    }
    if (options.verifyKeyPackets && options.metadataOnly) {
        throw new TypeError('options.verifyKeyPackets and options.metadataOnly cannot be enabled together.');
    }
};
const validateTimestamp = (timestamp) => {
    if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
        throw new TypeError('timestamp must be a number.'); // It can be non-finite, that's fine
    }
};
const maybeFixPacketType = (track, promise, options) => {
    if (options.verifyKeyPackets) {
        return promise.then(async (packet) => {
            if (!packet || packet.type === 'delta') {
                return packet;
            }
            const determinedType = await track.determinePacketType(packet);
            if (determinedType) {
                // @ts-expect-error Technically readonly
                packet.type = determinedType;
            }
            return packet;
        });
    }
    else {
        return promise;
    }
};
/**
 * Sink for retrieving encoded packets from an input track.
 * @group Media sinks
 * @public
 */
export class EncodedPacketSink {
    /** Creates a new {@link EncodedPacketSink} for the given {@link InputTrack}. */
    constructor(track) {
        if (!(track instanceof InputTrack)) {
            throw new TypeError('track must be an InputTrack.');
        }
        this._track = track;
    }
    /**
     * Retrieves the track's first packet (in decode order), or null if it has no packets. The first packet is very
     * likely to be a key packet.
     */
    getFirstPacket(options = {}) {
        validatePacketRetrievalOptions(options);
        return maybeFixPacketType(this._track, this._track._backing.getFirstPacket(options), options);
    }
    /**
     * Retrieves the packet corresponding to the given timestamp, in seconds. More specifically, returns the last packet
     * (in presentation order) with a start timestamp less than or equal to the given timestamp. This method can be
     * used to retrieve a track's last packet using `getPacket(Infinity)`. The method returns null if the timestamp
     * is before the first packet in the track.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    getPacket(timestamp, options = {}) {
        validateTimestamp(timestamp);
        validatePacketRetrievalOptions(options);
        return maybeFixPacketType(this._track, this._track._backing.getPacket(timestamp, options), options);
    }
    /**
     * Retrieves the packet following the given packet (in decode order), or null if the given packet is the
     * last packet.
     */
    getNextPacket(packet, options = {}) {
        if (!(packet instanceof EncodedPacket)) {
            throw new TypeError('packet must be an EncodedPacket.');
        }
        validatePacketRetrievalOptions(options);
        return maybeFixPacketType(this._track, this._track._backing.getNextPacket(packet, options), options);
    }
    /**
     * Retrieves the key packet corresponding to the given timestamp, in seconds. More specifically, returns the last
     * key packet (in presentation order) with a start timestamp less than or equal to the given timestamp. A key packet
     * is a packet that doesn't require previous packets to be decoded. This method can be used to retrieve a track's
     * last key packet using `getKeyPacket(Infinity)`. The method returns null if the timestamp is before the first
     * key packet in the track.
     *
     * To ensure that the returned packet is guaranteed to be a real key frame, enable `options.verifyKeyPackets`.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getKeyPacket(timestamp, options = {}) {
        validateTimestamp(timestamp);
        validatePacketRetrievalOptions(options);
        if (!options.verifyKeyPackets) {
            return this._track._backing.getKeyPacket(timestamp, options);
        }
        const packet = await this._track._backing.getKeyPacket(timestamp, options);
        if (!packet || packet.type === 'delta') {
            return packet;
        }
        const determinedType = await this._track.determinePacketType(packet);
        if (determinedType === 'delta') {
            // Try returning the previous key packet (in hopes that it's actually a key packet)
            return this.getKeyPacket(packet.timestamp - 1 / this._track.timeResolution, options);
        }
        return packet;
    }
    /**
     * Retrieves the key packet following the given packet (in decode order), or null if the given packet is the last
     * key packet.
     *
     * To ensure that the returned packet is guaranteed to be a real key frame, enable `options.verifyKeyPackets`.
     */
    async getNextKeyPacket(packet, options = {}) {
        if (!(packet instanceof EncodedPacket)) {
            throw new TypeError('packet must be an EncodedPacket.');
        }
        validatePacketRetrievalOptions(options);
        if (!options.verifyKeyPackets) {
            return this._track._backing.getNextKeyPacket(packet, options);
        }
        const nextPacket = await this._track._backing.getNextKeyPacket(packet, options);
        if (!nextPacket || nextPacket.type === 'delta') {
            return nextPacket;
        }
        const determinedType = await this._track.determinePacketType(nextPacket);
        if (determinedType === 'delta') {
            // Try returning the next key packet (in hopes that it's actually a key packet)
            return this.getNextKeyPacket(nextPacket, options);
        }
        return nextPacket;
    }
    /**
     * Creates an async iterator that yields the packets in this track in decode order. To enable fast iteration, this
     * method will intelligently preload packets based on the speed of the consumer.
     *
     * @param startPacket - (optional) The packet from which iteration should begin. This packet will also be yielded.
     * @param endTimestamp - (optional) The timestamp at which iteration should end. This packet will _not_ be yielded.
     */
    packets(startPacket, endPacket, options = {}) {
        if (startPacket !== undefined && !(startPacket instanceof EncodedPacket)) {
            throw new TypeError('startPacket must be an EncodedPacket.');
        }
        if (startPacket !== undefined && startPacket.isMetadataOnly && !options?.metadataOnly) {
            throw new TypeError('startPacket can only be metadata-only if options.metadataOnly is enabled.');
        }
        if (endPacket !== undefined && !(endPacket instanceof EncodedPacket)) {
            throw new TypeError('endPacket must be an EncodedPacket.');
        }
        validatePacketRetrievalOptions(options);
        const packetQueue = [];
        let { promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers();
        let { promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers();
        let ended = false;
        let terminated = false;
        // This stores errors that are "out of band" in the sense that they didn't occur in the normal flow of this
        // method but instead in a different context. This error should not go unnoticed and must be bubbled up to
        // the consumer.
        let outOfBandError = null;
        const timestamps = [];
        // The queue should always be big enough to hold 1 second worth of packets
        const maxQueueSize = () => Math.max(2, timestamps.length);
        // The following is the "pump" process that keeps pumping packets into the queue
        (async () => {
            let packet = startPacket ?? await this.getFirstPacket(options);
            while (packet && !terminated) {
                if (endPacket && packet.sequenceNumber >= endPacket?.sequenceNumber) {
                    break;
                }
                if (packetQueue.length > maxQueueSize()) {
                    ({ promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers());
                    await queueDequeue;
                    continue;
                }
                packetQueue.push(packet);
                onQueueNotEmpty();
                ({ promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers());
                packet = await this.getNextPacket(packet, options);
            }
            ended = true;
            onQueueNotEmpty();
        })().catch((error) => {
            if (!outOfBandError) {
                outOfBandError = error;
                onQueueNotEmpty();
            }
        });
        return {
            async next() {
                while (true) {
                    if (terminated) {
                        return { value: undefined, done: true };
                    }
                    else if (outOfBandError) {
                        throw outOfBandError;
                    }
                    else if (packetQueue.length > 0) {
                        const value = packetQueue.shift();
                        const now = performance.now();
                        timestamps.push(now);
                        while (timestamps.length > 0 && now - timestamps[0] >= 1000) {
                            timestamps.shift();
                        }
                        onQueueDequeue();
                        return { value, done: false };
                    }
                    else if (ended) {
                        return { value: undefined, done: true };
                    }
                    else {
                        await queueNotEmpty;
                    }
                }
            },
            async return() {
                terminated = true;
                onQueueDequeue();
                onQueueNotEmpty();
                return { value: undefined, done: true };
            },
            async throw(error) {
                throw error;
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
    }
}
class DecoderWrapper {
    constructor(onSample, onError) {
        this.onSample = onSample;
        this.onError = onError;
    }
}
/**
 * Base class for decoded media sample sinks.
 * @group Media sinks
 * @public
 */
export class BaseMediaSampleSink {
    /** @internal */
    mediaSamplesInRange(startTimestamp = 0, endTimestamp = Infinity) {
        validateTimestamp(startTimestamp);
        validateTimestamp(endTimestamp);
        const sampleQueue = [];
        let firstSampleQueued = false;
        let lastSample = null;
        let { promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers();
        let { promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers();
        let decoderIsFlushed = false;
        let ended = false;
        let terminated = false;
        // This stores errors that are "out of band" in the sense that they didn't occur in the normal flow of this
        // method but instead in a different context. This error should not go unnoticed and must be bubbled up to
        // the consumer.
        let outOfBandError = null;
        // The following is the "pump" process that keeps pumping packets into the decoder
        (async () => {
            const decoderError = new Error();
            const decoder = await this._createDecoder((sample) => {
                onQueueDequeue();
                if (sample.timestamp >= endTimestamp) {
                    ended = true;
                }
                if (ended) {
                    sample.close();
                    return;
                }
                if (lastSample) {
                    if (sample.timestamp > startTimestamp) {
                        // We don't know ahead of time what the first first is. This is because the first first is the
                        // last first whose timestamp is less than or equal to the start timestamp. Therefore we need to
                        // wait for the first first after the start timestamp, and then we'll know that the previous
                        // first was the first first.
                        sampleQueue.push(lastSample);
                        firstSampleQueued = true;
                    }
                    else {
                        lastSample.close();
                    }
                }
                if (sample.timestamp >= startTimestamp) {
                    sampleQueue.push(sample);
                    firstSampleQueued = true;
                }
                lastSample = firstSampleQueued ? null : sample;
                if (sampleQueue.length > 0) {
                    onQueueNotEmpty();
                    ({ promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers());
                }
            }, (error) => {
                if (!outOfBandError) {
                    error.stack = decoderError.stack; // Provide a more useful stack trace
                    outOfBandError = error;
                    onQueueNotEmpty();
                }
            });
            const packetSink = this._createPacketSink();
            const keyPacket = await packetSink.getKeyPacket(startTimestamp, { verifyKeyPackets: true })
                ?? await packetSink.getFirstPacket();
            if (!keyPacket) {
                return;
            }
            let currentPacket = keyPacket;
            let endPacket = undefined;
            if (endTimestamp < Infinity) {
                // When an end timestamp is set, we cannot simply use that for the packet iterator due to out-of-order
                // frames (B-frames). Instead, we'll need to keep decoding packets until we get a frame that exceeds
                // this end time. However, we can still put a bound on it: Since key frames are by definition never
                // out of order, we can stop at the first key frame after the end timestamp.
                const packet = await packetSink.getPacket(endTimestamp);
                const keyPacket = !packet
                    ? null
                    : packet.type === 'key' && packet.timestamp === endTimestamp
                        ? packet
                        : await packetSink.getNextKeyPacket(packet, { verifyKeyPackets: true });
                if (keyPacket) {
                    endPacket = keyPacket;
                }
            }
            const packets = packetSink.packets(keyPacket, endPacket);
            await packets.next(); // Skip the start packet as we already have it
            while (currentPacket && !ended) {
                const maxQueueSize = computeMaxQueueSize(sampleQueue.length);
                if (sampleQueue.length + decoder.getDecodeQueueSize() > maxQueueSize) {
                    ({ promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers());
                    await queueDequeue;
                    continue;
                }
                decoder.decode(currentPacket);
                const packetResult = await packets.next();
                if (packetResult.done) {
                    break;
                }
                currentPacket = packetResult.value;
            }
            await packets.return();
            if (!terminated)
                await decoder.flush();
            decoder.close();
            if (!firstSampleQueued && lastSample) {
                sampleQueue.push(lastSample);
            }
            decoderIsFlushed = true;
            onQueueNotEmpty(); // To unstuck the generator
        })().catch((error) => {
            if (!outOfBandError) {
                outOfBandError = error;
                onQueueNotEmpty();
            }
        });
        return {
            async next() {
                while (true) {
                    if (terminated) {
                        return { value: undefined, done: true };
                    }
                    else if (outOfBandError) {
                        throw outOfBandError;
                    }
                    else if (sampleQueue.length > 0) {
                        const value = sampleQueue.shift();
                        onQueueDequeue();
                        return { value, done: false };
                    }
                    else if (!decoderIsFlushed) {
                        await queueNotEmpty;
                    }
                    else {
                        return { value: undefined, done: true };
                    }
                }
            },
            async return() {
                terminated = true;
                ended = true;
                onQueueDequeue();
                onQueueNotEmpty();
                lastSample?.close();
                for (const sample of sampleQueue) {
                    sample.close();
                }
                return { value: undefined, done: true };
            },
            async throw(error) {
                throw error;
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
    }
    /** @internal */
    mediaSamplesAtTimestamps(timestamps) {
        validateAnyIterable(timestamps);
        const timestampIterator = toAsyncIterator(timestamps);
        const timestampsOfInterest = [];
        const sampleQueue = [];
        let { promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers();
        let { promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers();
        let decoderIsFlushed = false;
        let terminated = false;
        // This stores errors that are "out of band" in the sense that they didn't occur in the normal flow of this
        // method but instead in a different context. This error should not go unnoticed and must be bubbled up to
        // the consumer.
        let outOfBandError = null;
        const pushToQueue = (sample) => {
            sampleQueue.push(sample);
            onQueueNotEmpty();
            ({ promise: queueNotEmpty, resolve: onQueueNotEmpty } = promiseWithResolvers());
        };
        // The following is the "pump" process that keeps pumping packets into the decoder
        (async () => {
            const decoderError = new Error();
            const decoder = await this._createDecoder((sample) => {
                onQueueDequeue();
                if (terminated) {
                    sample.close();
                    return;
                }
                let sampleUses = 0;
                while (timestampsOfInterest.length > 0
                    && sample.timestamp - timestampsOfInterest[0] > -1e-10 // Give it a little epsilon
                ) {
                    sampleUses++;
                    timestampsOfInterest.shift();
                }
                if (sampleUses > 0) {
                    for (let i = 0; i < sampleUses; i++) {
                        // Clone the sample if we need to emit it multiple times
                        pushToQueue((i < sampleUses - 1 ? sample.clone() : sample));
                    }
                }
                else {
                    sample.close();
                }
            }, (error) => {
                if (!outOfBandError) {
                    error.stack = decoderError.stack; // Provide a more useful stack trace
                    outOfBandError = error;
                    onQueueNotEmpty();
                }
            });
            const packetSink = this._createPacketSink();
            let lastPacket = null;
            let lastKeyPacket = null;
            // The end sequence number (inclusive) in the next batch of packets that will be decoded. The batch starts
            // at the last key frame and goes until this sequence number.
            let maxSequenceNumber = -1;
            const decodePackets = async () => {
                assert(lastKeyPacket);
                // Start at the current key packet
                let currentPacket = lastKeyPacket;
                decoder.decode(currentPacket);
                while (currentPacket.sequenceNumber < maxSequenceNumber) {
                    const maxQueueSize = computeMaxQueueSize(sampleQueue.length);
                    while (sampleQueue.length + decoder.getDecodeQueueSize() > maxQueueSize && !terminated) {
                        ({ promise: queueDequeue, resolve: onQueueDequeue } = promiseWithResolvers());
                        await queueDequeue;
                    }
                    if (terminated) {
                        break;
                    }
                    const nextPacket = await packetSink.getNextPacket(currentPacket);
                    assert(nextPacket);
                    decoder.decode(nextPacket);
                    currentPacket = nextPacket;
                }
                maxSequenceNumber = -1;
            };
            const flushDecoder = async () => {
                await decoder.flush();
                // We don't expect this list to have any elements in it anymore, but in case it does, let's emit
                // nulls for every remaining element, then clear it.
                for (let i = 0; i < timestampsOfInterest.length; i++) {
                    pushToQueue(null);
                }
                timestampsOfInterest.length = 0;
            };
            for await (const timestamp of timestampIterator) {
                validateTimestamp(timestamp);
                if (terminated) {
                    break;
                }
                const targetPacket = await packetSink.getPacket(timestamp);
                const keyPacket = targetPacket && await packetSink.getKeyPacket(timestamp, { verifyKeyPackets: true });
                if (!keyPacket) {
                    if (maxSequenceNumber !== -1) {
                        await decodePackets();
                        await flushDecoder();
                    }
                    pushToQueue(null);
                    lastPacket = null;
                    continue;
                }
                // Check if the key packet has changed or if we're going back in time
                if (lastPacket
                    && (keyPacket.sequenceNumber !== lastKeyPacket.sequenceNumber
                        || targetPacket.timestamp < lastPacket.timestamp)) {
                    await decodePackets();
                    await flushDecoder(); // Always flush here, improves decoder compatibility
                }
                timestampsOfInterest.push(targetPacket.timestamp);
                maxSequenceNumber = Math.max(targetPacket.sequenceNumber, maxSequenceNumber);
                lastPacket = targetPacket;
                lastKeyPacket = keyPacket;
            }
            if (!terminated) {
                if (maxSequenceNumber !== -1) {
                    // We still need to decode packets
                    await decodePackets();
                }
                await flushDecoder();
            }
            decoder.close();
            decoderIsFlushed = true;
            onQueueNotEmpty(); // To unstuck the generator
        })().catch((error) => {
            if (!outOfBandError) {
                outOfBandError = error;
                onQueueNotEmpty();
            }
        });
        return {
            async next() {
                while (true) {
                    if (terminated) {
                        return { value: undefined, done: true };
                    }
                    else if (outOfBandError) {
                        throw outOfBandError;
                    }
                    else if (sampleQueue.length > 0) {
                        const value = sampleQueue.shift();
                        assert(value !== undefined);
                        onQueueDequeue();
                        return { value, done: false };
                    }
                    else if (!decoderIsFlushed) {
                        await queueNotEmpty;
                    }
                    else {
                        return { value: undefined, done: true };
                    }
                }
            },
            async return() {
                terminated = true;
                onQueueDequeue();
                onQueueNotEmpty();
                for (const sample of sampleQueue) {
                    sample?.close();
                }
                return { value: undefined, done: true };
            },
            async throw(error) {
                throw error;
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
    }
}
const computeMaxQueueSize = (decodedSampleQueueSize) => {
    // If we have decoded samples lying around, limit the total queue size to a small value (decoded samples can use up
    // a lot of memory). If not, we're fine with a much bigger queue of encoded packets waiting to be decoded. In fact,
    // some decoders only start flushing out decoded chunks when the packet queue is large enough.
    return decodedSampleQueueSize === 0 ? 40 : 8;
};
class VideoDecoderWrapper extends DecoderWrapper {
    constructor(onSample, onError, codec, decoderConfig, rotation, timeResolution) {
        super(onSample, onError);
        this.codec = codec;
        this.decoderConfig = decoderConfig;
        this.rotation = rotation;
        this.timeResolution = timeResolution;
        this.decoder = null;
        this.customDecoder = null;
        this.customDecoderCallSerializer = new CallSerializer();
        this.customDecoderQueueSize = 0;
        this.inputTimestamps = []; // Timestamps input into the decoder, sorted.
        this.sampleQueue = []; // Safari-specific thing, check usage.
        this.currentPacketIndex = 0;
        this.raslSkipped = false; // For HEVC stuff
        const MatchingCustomDecoder = customVideoDecoders.find(x => x.supports(codec, decoderConfig));
        if (MatchingCustomDecoder) {
            // @ts-expect-error "Can't create instance of abstract class 🤓"
            this.customDecoder = new MatchingCustomDecoder();
            // @ts-expect-error It's technically readonly
            this.customDecoder.codec = codec;
            // @ts-expect-error It's technically readonly
            this.customDecoder.config = decoderConfig;
            // @ts-expect-error It's technically readonly
            this.customDecoder.onSample = (sample) => {
                if (!(sample instanceof VideoSample)) {
                    throw new TypeError('The argument passed to onSample must be a VideoSample.');
                }
                this.finalizeAndEmitSample(sample);
            };
            void this.customDecoderCallSerializer.call(() => this.customDecoder.init());
        }
        else {
            // Specific handler for the WebCodecs VideoDecoder to iron out browser differences
            const sampleHandler = (sample) => {
                if (isSafari()) {
                    // For correct B-frame handling, we don't just hand over the frames directly but instead add them to
                    // a queue, because we want to ensure frames are emitted in presentation order. We flush the queue
                    // each time we receive a frame with a timestamp larger than the highest we've seen so far, as we
                    // can sure that is not a B-frame. Typically, WebCodecs automatically guarantees that frames are
                    // emitted in presentation order, but Safari doesn't always follow this rule.
                    if (this.sampleQueue.length > 0 && (sample.timestamp >= last(this.sampleQueue).timestamp)) {
                        for (const sample of this.sampleQueue) {
                            this.finalizeAndEmitSample(sample);
                        }
                        this.sampleQueue.length = 0;
                    }
                    insertSorted(this.sampleQueue, sample, x => x.timestamp);
                }
                else {
                    // Assign it the next earliest timestamp from the input. We do this because browsers, by spec, are
                    // required to emit decoded frames in presentation order *while* retaining the timestamp of their
                    // originating EncodedVideoChunk. For files with B-frames but no out-of-order timestamps (like a
                    // missing ctts box, for example), this causes a mismatch. We therefore fix the timestamps and
                    // ensure they are sorted by doing this.
                    const timestamp = this.inputTimestamps.shift();
                    // There's no way we'd have more decoded frames than encoded packets we passed in. Actually, the
                    // correspondence should be 1:1.
                    assert(timestamp !== undefined);
                    sample.setTimestamp(timestamp);
                    this.finalizeAndEmitSample(sample);
                }
            };
            this.decoder = new VideoDecoder({
                output: frame => sampleHandler(new VideoSample(frame)),
                error: onError,
            });
            this.decoder.configure(decoderConfig);
        }
    }
    finalizeAndEmitSample(sample) {
        // Round the timestamps to the time resolution
        sample.setTimestamp(Math.round(sample.timestamp * this.timeResolution) / this.timeResolution);
        sample.setDuration(Math.round(sample.duration * this.timeResolution) / this.timeResolution);
        sample.setRotation(this.rotation);
        this.onSample(sample);
    }
    getDecodeQueueSize() {
        if (this.customDecoder) {
            return this.customDecoderQueueSize;
        }
        else {
            assert(this.decoder);
            return this.decoder.decodeQueueSize;
        }
    }
    decode(packet) {
        if (this.codec === 'hevc' && this.currentPacketIndex > 0 && !this.raslSkipped) {
            // If we're using HEVC, we need to make sure to skip any RASL slices that follow a non-IDR key frame such as
            // CRA_NUT. This is because RASL slices cannot be decoded without data before the CRA_NUT. Browsers behave
            // differently here: Chromium drops the packets, Safari throws a decoder error. Either way, it's not good
            // and causes bugs upstream. So, let's take the dropping into our own hands.
            const nalUnits = extractHevcNalUnits(packet.data, this.decoderConfig);
            const hasRaslPicture = nalUnits.some((x) => {
                const type = extractNalUnitTypeForHevc(x);
                return type === HevcNalUnitType.RASL_N || type === HevcNalUnitType.RASL_R;
            });
            if (hasRaslPicture) {
                return; // Drop
            }
            this.raslSkipped = true;
        }
        this.currentPacketIndex++;
        if (this.customDecoder) {
            this.customDecoderQueueSize++;
            void this.customDecoderCallSerializer
                .call(() => this.customDecoder.decode(packet))
                .then(() => this.customDecoderQueueSize--);
        }
        else {
            assert(this.decoder);
            if (!isSafari()) {
                insertSorted(this.inputTimestamps, packet.timestamp, x => x);
            }
            this.decoder.decode(packet.toEncodedVideoChunk());
        }
    }
    async flush() {
        if (this.customDecoder) {
            await this.customDecoderCallSerializer.call(() => this.customDecoder.flush());
        }
        else {
            assert(this.decoder);
            await this.decoder.flush();
        }
        if (isSafari()) {
            for (const sample of this.sampleQueue) {
                this.finalizeAndEmitSample(sample);
            }
            this.sampleQueue.length = 0;
        }
        this.currentPacketIndex = 0;
        this.raslSkipped = false;
    }
    close() {
        if (this.customDecoder) {
            void this.customDecoderCallSerializer.call(() => this.customDecoder.close());
        }
        else {
            assert(this.decoder);
            this.decoder.close();
        }
        for (const sample of this.sampleQueue) {
            sample.close();
        }
        this.sampleQueue.length = 0;
    }
}
/**
 * A sink that retrieves decoded video samples (video frames) from a video track.
 * @group Media sinks
 * @public
 */
export class VideoSampleSink extends BaseMediaSampleSink {
    /** Creates a new {@link VideoSampleSink} for the given {@link InputVideoTrack}. */
    constructor(videoTrack) {
        if (!(videoTrack instanceof InputVideoTrack)) {
            throw new TypeError('videoTrack must be an InputVideoTrack.');
        }
        super();
        this._videoTrack = videoTrack;
    }
    /** @internal */
    async _createDecoder(onSample, onError) {
        if (!(await this._videoTrack.canDecode())) {
            throw new Error('This video track cannot be decoded by this browser. Make sure to check decodability before using'
                + ' a track.');
        }
        const codec = this._videoTrack.codec;
        const rotation = this._videoTrack.rotation;
        const decoderConfig = await this._videoTrack.getDecoderConfig();
        const timeResolution = this._videoTrack.timeResolution;
        assert(codec && decoderConfig);
        return new VideoDecoderWrapper(onSample, onError, codec, decoderConfig, rotation, timeResolution);
    }
    /** @internal */
    _createPacketSink() {
        return new EncodedPacketSink(this._videoTrack);
    }
    /**
     * Retrieves the video sample (frame) corresponding to the given timestamp, in seconds. More specifically, returns
     * the last video sample (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getSample(timestamp) {
        validateTimestamp(timestamp);
        for await (const sample of this.mediaSamplesAtTimestamps([timestamp])) {
            return sample;
        }
        throw new Error('Internal error: Iterator returned nothing.');
    }
    /**
     * Creates an async iterator that yields the video samples (frames) of this track in presentation order. This method
     * will intelligently pre-decode a few frames ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding samples (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding samples (exclusive).
     */
    samples(startTimestamp = 0, endTimestamp = Infinity) {
        return this.mediaSamplesInRange(startTimestamp, endTimestamp);
    }
    /**
     * Creates an async iterator that yields a video sample (frame) for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the sample for every timestamp. The iterator may
     * yield null if no frame is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    samplesAtTimestamps(timestamps) {
        return this.mediaSamplesAtTimestamps(timestamps);
    }
}
/**
 * A sink that renders video samples (frames) of the given video track to canvases. This is often more useful than
 * directly retrieving frames, as it comes with common preprocessing steps such as resizing or applying rotation
 * metadata.
 *
 * This sink will yield `HTMLCanvasElement`s when in a DOM context, and `OffscreenCanvas`es otherwise.
 *
 * @group Media sinks
 * @public
 */
export class CanvasSink {
    /** Creates a new {@link CanvasSink} for the given {@link InputVideoTrack}. */
    constructor(videoTrack, options = {}) {
        /** @internal */
        this._nextCanvasIndex = 0;
        if (!(videoTrack instanceof InputVideoTrack)) {
            throw new TypeError('videoTrack must be an InputVideoTrack.');
        }
        if (options && typeof options !== 'object') {
            throw new TypeError('options must be an object.');
        }
        if (options.width !== undefined && (!Number.isInteger(options.width) || options.width <= 0)) {
            throw new TypeError('options.width, when defined, must be a positive integer.');
        }
        if (options.height !== undefined && (!Number.isInteger(options.height) || options.height <= 0)) {
            throw new TypeError('options.height, when defined, must be a positive integer.');
        }
        if (options.fit !== undefined && !['fill', 'contain', 'cover'].includes(options.fit)) {
            throw new TypeError('options.fit, when provided, must be one of "fill", "contain", or "cover".');
        }
        if (options.width !== undefined
            && options.height !== undefined
            && options.fit === undefined) {
            throw new TypeError('When both options.width and options.height are provided, options.fit must also be provided.');
        }
        if (options.rotation !== undefined && ![0, 90, 180, 270].includes(options.rotation)) {
            throw new TypeError('options.rotation, when provided, must be 0, 90, 180 or 270.');
        }
        if (options.poolSize !== undefined
            && (typeof options.poolSize !== 'number' || !Number.isInteger(options.poolSize) || options.poolSize < 0)) {
            throw new TypeError('poolSize must be a non-negative integer.');
        }
        const rotation = options.rotation ?? videoTrack.rotation;
        let [width, height] = rotation % 180 === 0
            ? [videoTrack.codedWidth, videoTrack.codedHeight]
            : [videoTrack.codedHeight, videoTrack.codedWidth];
        const originalAspectRatio = width / height;
        // If width and height aren't defined together, deduce the missing value using the aspect ratio
        if (options.width !== undefined && options.height === undefined) {
            width = options.width;
            height = Math.round(width / originalAspectRatio);
        }
        else if (options.width === undefined && options.height !== undefined) {
            height = options.height;
            width = Math.round(height * originalAspectRatio);
        }
        else if (options.width !== undefined && options.height !== undefined) {
            width = options.width;
            height = options.height;
        }
        this._videoTrack = videoTrack;
        this._width = width;
        this._height = height;
        this._rotation = rotation;
        this._fit = options.fit ?? 'fill';
        this._videoSampleSink = new VideoSampleSink(videoTrack);
        this._canvasPool = Array.from({ length: options.poolSize ?? 0 }, () => null);
    }
    /** @internal */
    _videoSampleToWrappedCanvas(sample) {
        let canvas = this._canvasPool[this._nextCanvasIndex];
        let canvasIsNew = false;
        if (!canvas) {
            if (typeof document !== 'undefined') {
                // Prefer an HTMLCanvasElement
                canvas = document.createElement('canvas');
                canvas.width = this._width;
                canvas.height = this._height;
            }
            else {
                canvas = new OffscreenCanvas(this._width, this._height);
            }
            if (this._canvasPool.length > 0) {
                this._canvasPool[this._nextCanvasIndex] = canvas;
            }
            canvasIsNew = true;
        }
        if (this._canvasPool.length > 0) {
            this._nextCanvasIndex = (this._nextCanvasIndex + 1) % this._canvasPool.length;
        }
        const context = canvas.getContext('2d', { alpha: false });
        assert(context);
        context.resetTransform();
        if (!canvasIsNew) {
            context.clearRect(0, 0, this._width, this._height);
        }
        sample.drawWithFit(context, {
            fit: this._fit,
            rotation: this._rotation,
        });
        const result = {
            canvas,
            timestamp: sample.timestamp,
            duration: sample.duration,
        };
        sample.close();
        return result;
    }
    /**
     * Retrieves a canvas with the video frame corresponding to the given timestamp, in seconds. More specifically,
     * returns the last video frame (in presentation order) with a start timestamp less than or equal to the given
     * timestamp. Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getCanvas(timestamp) {
        validateTimestamp(timestamp);
        const sample = await this._videoSampleSink.getSample(timestamp);
        return sample && this._videoSampleToWrappedCanvas(sample);
    }
    /**
     * Creates an async iterator that yields canvases with the video frames of this track in presentation order. This
     * method will intelligently pre-decode a few frames ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding canvases (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding canvases (exclusive).
     */
    canvases(startTimestamp = 0, endTimestamp = Infinity) {
        return mapAsyncGenerator(this._videoSampleSink.samples(startTimestamp, endTimestamp), sample => this._videoSampleToWrappedCanvas(sample));
    }
    /**
     * Creates an async iterator that yields a canvas for each timestamp in the argument. This method uses an optimized
     * decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most once, and is
     * therefore more efficient than manually getting the canvas for every timestamp. The iterator may yield null if
     * no frame is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    canvasesAtTimestamps(timestamps) {
        return mapAsyncGenerator(this._videoSampleSink.samplesAtTimestamps(timestamps), sample => sample && this._videoSampleToWrappedCanvas(sample));
    }
}
class AudioDecoderWrapper extends DecoderWrapper {
    constructor(onSample, onError, codec, decoderConfig) {
        super(onSample, onError);
        this.decoder = null;
        this.customDecoder = null;
        this.customDecoderCallSerializer = new CallSerializer();
        this.customDecoderQueueSize = 0;
        // Internal state to accumulate a precise current timestamp based on audio durations, not the (potentially
        // inaccurate) packet timestamps.
        this.currentTimestamp = null;
        const sampleHandler = (sample) => {
            if (this.currentTimestamp === null
                || Math.abs(sample.timestamp - this.currentTimestamp) >= sample.duration) {
                // We need to sync with the sample timestamp again
                this.currentTimestamp = sample.timestamp;
            }
            const preciseTimestamp = this.currentTimestamp;
            this.currentTimestamp += sample.duration;
            if (sample.numberOfFrames === 0) {
                // We skip zero-data (empty) AudioSamples. These are sometimes emitted, for example, by Firefox when it
                // decodes Vorbis (at the start).
                sample.close();
                return;
            }
            // Round the timestamp to the sample rate
            const sampleRate = decoderConfig.sampleRate;
            sample.setTimestamp(Math.round(preciseTimestamp * sampleRate) / sampleRate);
            onSample(sample);
        };
        const MatchingCustomDecoder = customAudioDecoders.find(x => x.supports(codec, decoderConfig));
        if (MatchingCustomDecoder) {
            // @ts-expect-error "Can't create instance of abstract class 🤓"
            this.customDecoder = new MatchingCustomDecoder();
            // @ts-expect-error It's technically readonly
            this.customDecoder.codec = codec;
            // @ts-expect-error It's technically readonly
            this.customDecoder.config = decoderConfig;
            // @ts-expect-error It's technically readonly
            this.customDecoder.onSample = (sample) => {
                if (!(sample instanceof AudioSample)) {
                    throw new TypeError('The argument passed to onSample must be an AudioSample.');
                }
                sampleHandler(sample);
            };
            void this.customDecoderCallSerializer.call(() => this.customDecoder.init());
        }
        else {
            this.decoder = new AudioDecoder({
                output: data => sampleHandler(new AudioSample(data)),
                error: onError,
            });
            this.decoder.configure(decoderConfig);
        }
    }
    getDecodeQueueSize() {
        if (this.customDecoder) {
            return this.customDecoderQueueSize;
        }
        else {
            assert(this.decoder);
            return this.decoder.decodeQueueSize;
        }
    }
    decode(packet) {
        if (this.customDecoder) {
            this.customDecoderQueueSize++;
            void this.customDecoderCallSerializer
                .call(() => this.customDecoder.decode(packet))
                .then(() => this.customDecoderQueueSize--);
        }
        else {
            assert(this.decoder);
            this.decoder.decode(packet.toEncodedAudioChunk());
        }
    }
    flush() {
        if (this.customDecoder) {
            return this.customDecoderCallSerializer.call(() => this.customDecoder.flush());
        }
        else {
            assert(this.decoder);
            return this.decoder.flush();
        }
    }
    close() {
        if (this.customDecoder) {
            void this.customDecoderCallSerializer.call(() => this.customDecoder.close());
        }
        else {
            assert(this.decoder);
            this.decoder.close();
        }
    }
}
// There are a lot of PCM variants not natively supported by the browser and by AudioData. Therefore we need a simple
// decoder that maps any input PCM format into a PCM format supported by the browser.
class PcmAudioDecoderWrapper extends DecoderWrapper {
    constructor(onSample, onError, decoderConfig) {
        super(onSample, onError);
        this.decoderConfig = decoderConfig;
        // Internal state to accumulate a precise current timestamp based on audio durations, not the (potentially
        // inaccurate) packet timestamps.
        this.currentTimestamp = null;
        assert(PCM_AUDIO_CODECS.includes(decoderConfig.codec));
        this.codec = decoderConfig.codec;
        const { dataType, sampleSize, littleEndian } = parsePcmCodec(this.codec);
        this.inputSampleSize = sampleSize;
        switch (sampleSize) {
            case 1:
                {
                    if (dataType === 'unsigned') {
                        this.readInputValue = (view, byteOffset) => view.getUint8(byteOffset) - 2 ** 7;
                    }
                    else if (dataType === 'signed') {
                        this.readInputValue = (view, byteOffset) => view.getInt8(byteOffset);
                    }
                    else if (dataType === 'ulaw') {
                        this.readInputValue = (view, byteOffset) => fromUlaw(view.getUint8(byteOffset));
                    }
                    else if (dataType === 'alaw') {
                        this.readInputValue = (view, byteOffset) => fromAlaw(view.getUint8(byteOffset));
                    }
                    else {
                        assert(false);
                    }
                }
                ;
                break;
            case 2:
                {
                    if (dataType === 'unsigned') {
                        this.readInputValue = (view, byteOffset) => view.getUint16(byteOffset, littleEndian) - 2 ** 15;
                    }
                    else if (dataType === 'signed') {
                        this.readInputValue = (view, byteOffset) => view.getInt16(byteOffset, littleEndian);
                    }
                    else {
                        assert(false);
                    }
                }
                ;
                break;
            case 3:
                {
                    if (dataType === 'unsigned') {
                        this.readInputValue = (view, byteOffset) => getUint24(view, byteOffset, littleEndian) - 2 ** 23;
                    }
                    else if (dataType === 'signed') {
                        this.readInputValue = (view, byteOffset) => getInt24(view, byteOffset, littleEndian);
                    }
                    else {
                        assert(false);
                    }
                }
                ;
                break;
            case 4:
                {
                    if (dataType === 'unsigned') {
                        this.readInputValue = (view, byteOffset) => view.getUint32(byteOffset, littleEndian) - 2 ** 31;
                    }
                    else if (dataType === 'signed') {
                        this.readInputValue = (view, byteOffset) => view.getInt32(byteOffset, littleEndian);
                    }
                    else if (dataType === 'float') {
                        this.readInputValue = (view, byteOffset) => view.getFloat32(byteOffset, littleEndian);
                    }
                    else {
                        assert(false);
                    }
                }
                ;
                break;
            case 8:
                {
                    if (dataType === 'float') {
                        this.readInputValue = (view, byteOffset) => view.getFloat64(byteOffset, littleEndian);
                    }
                    else {
                        assert(false);
                    }
                }
                ;
                break;
            default:
                {
                    assertNever(sampleSize);
                    assert(false);
                }
                ;
        }
        switch (sampleSize) {
            case 1:
                {
                    if (dataType === 'ulaw' || dataType === 'alaw') {
                        this.outputSampleSize = 2;
                        this.outputFormat = 's16';
                        this.writeOutputValue = (view, byteOffset, value) => view.setInt16(byteOffset, value, true);
                    }
                    else {
                        this.outputSampleSize = 1;
                        this.outputFormat = 'u8';
                        this.writeOutputValue = (view, byteOffset, value) => view.setUint8(byteOffset, value + 2 ** 7);
                    }
                }
                ;
                break;
            case 2:
                {
                    this.outputSampleSize = 2;
                    this.outputFormat = 's16';
                    this.writeOutputValue = (view, byteOffset, value) => view.setInt16(byteOffset, value, true);
                }
                ;
                break;
            case 3:
                {
                    this.outputSampleSize = 4;
                    this.outputFormat = 's32';
                    // From https://www.w3.org/TR/webcodecs:
                    // AudioData containing 24-bit samples SHOULD store those samples in s32 or f32. When samples are
                    // stored in s32, each sample MUST be left-shifted by 8 bits.
                    this.writeOutputValue = (view, byteOffset, value) => view.setInt32(byteOffset, value << 8, true);
                }
                ;
                break;
            case 4:
                {
                    this.outputSampleSize = 4;
                    if (dataType === 'float') {
                        this.outputFormat = 'f32';
                        this.writeOutputValue = (view, byteOffset, value) => view.setFloat32(byteOffset, value, true);
                    }
                    else {
                        this.outputFormat = 's32';
                        this.writeOutputValue = (view, byteOffset, value) => view.setInt32(byteOffset, value, true);
                    }
                }
                ;
                break;
            case 8:
                {
                    this.outputSampleSize = 4;
                    this.outputFormat = 'f32';
                    this.writeOutputValue = (view, byteOffset, value) => view.setFloat32(byteOffset, value, true);
                }
                ;
                break;
            default:
                {
                    assertNever(sampleSize);
                    assert(false);
                }
                ;
        }
        ;
    }
    getDecodeQueueSize() {
        return 0;
    }
    decode(packet) {
        const inputView = toDataView(packet.data);
        const numberOfFrames = packet.byteLength / this.decoderConfig.numberOfChannels / this.inputSampleSize;
        const outputBufferSize = numberOfFrames * this.decoderConfig.numberOfChannels * this.outputSampleSize;
        const outputBuffer = new ArrayBuffer(outputBufferSize);
        const outputView = new DataView(outputBuffer);
        for (let i = 0; i < numberOfFrames * this.decoderConfig.numberOfChannels; i++) {
            const inputIndex = i * this.inputSampleSize;
            const outputIndex = i * this.outputSampleSize;
            const value = this.readInputValue(inputView, inputIndex);
            this.writeOutputValue(outputView, outputIndex, value);
        }
        const preciseDuration = numberOfFrames / this.decoderConfig.sampleRate;
        if (this.currentTimestamp === null || Math.abs(packet.timestamp - this.currentTimestamp) >= preciseDuration) {
            // We need to sync with the packet timestamp again
            this.currentTimestamp = packet.timestamp;
        }
        const preciseTimestamp = this.currentTimestamp;
        this.currentTimestamp += preciseDuration;
        const audioSample = new AudioSample({
            format: this.outputFormat,
            data: outputBuffer,
            numberOfChannels: this.decoderConfig.numberOfChannels,
            sampleRate: this.decoderConfig.sampleRate,
            numberOfFrames,
            timestamp: preciseTimestamp,
        });
        this.onSample(audioSample);
    }
    async flush() {
        // Do nothing
    }
    close() {
        // Do nothing
    }
}
/**
 * Sink for retrieving decoded audio samples from an audio track.
 * @group Media sinks
 * @public
 */
export class AudioSampleSink extends BaseMediaSampleSink {
    /** Creates a new {@link AudioSampleSink} for the given {@link InputAudioTrack}. */
    constructor(audioTrack) {
        if (!(audioTrack instanceof InputAudioTrack)) {
            throw new TypeError('audioTrack must be an InputAudioTrack.');
        }
        super();
        this._audioTrack = audioTrack;
    }
    /** @internal */
    async _createDecoder(onSample, onError) {
        if (!(await this._audioTrack.canDecode())) {
            throw new Error('This audio track cannot be decoded by this browser. Make sure to check decodability before using'
                + ' a track.');
        }
        const codec = this._audioTrack.codec;
        const decoderConfig = await this._audioTrack.getDecoderConfig();
        assert(codec && decoderConfig);
        if (PCM_AUDIO_CODECS.includes(decoderConfig.codec)) {
            return new PcmAudioDecoderWrapper(onSample, onError, decoderConfig);
        }
        else {
            return new AudioDecoderWrapper(onSample, onError, codec, decoderConfig);
        }
    }
    /** @internal */
    _createPacketSink() {
        return new EncodedPacketSink(this._audioTrack);
    }
    /**
     * Retrieves the audio sample corresponding to the given timestamp, in seconds. More specifically, returns
     * the last audio sample (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getSample(timestamp) {
        validateTimestamp(timestamp);
        for await (const sample of this.mediaSamplesAtTimestamps([timestamp])) {
            return sample;
        }
        throw new Error('Internal error: Iterator returned nothing.');
    }
    /**
     * Creates an async iterator that yields the audio samples of this track in presentation order. This method
     * will intelligently pre-decode a few samples ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding samples (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding samples (exclusive).
     */
    samples(startTimestamp = 0, endTimestamp = Infinity) {
        return this.mediaSamplesInRange(startTimestamp, endTimestamp);
    }
    /**
     * Creates an async iterator that yields an audio sample for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the sample for every timestamp. The iterator may
     * yield null if no sample is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    samplesAtTimestamps(timestamps) {
        return this.mediaSamplesAtTimestamps(timestamps);
    }
}
/**
 * A sink that retrieves decoded audio samples from an audio track and converts them to `AudioBuffer` instances. This is
 * often more useful than directly retrieving audio samples, as audio buffers can be directly used with the
 * Web Audio API.
 * @group Media sinks
 * @public
 */
export class AudioBufferSink {
    /** Creates a new {@link AudioBufferSink} for the given {@link InputAudioTrack}. */
    constructor(audioTrack) {
        if (!(audioTrack instanceof InputAudioTrack)) {
            throw new TypeError('audioTrack must be an InputAudioTrack.');
        }
        this._audioSampleSink = new AudioSampleSink(audioTrack);
    }
    /** @internal */
    _audioSampleToWrappedArrayBuffer(sample) {
        return {
            buffer: sample.toAudioBuffer(),
            timestamp: sample.timestamp,
            duration: sample.duration,
        };
    }
    /**
     * Retrieves the audio buffer corresponding to the given timestamp, in seconds. More specifically, returns
     * the last audio buffer (in presentation order) with a start timestamp less than or equal to the given timestamp.
     * Returns null if the timestamp is before the track's first timestamp.
     *
     * @param timestamp - The timestamp used for retrieval, in seconds.
     */
    async getBuffer(timestamp) {
        validateTimestamp(timestamp);
        const data = await this._audioSampleSink.getSample(timestamp);
        return data && this._audioSampleToWrappedArrayBuffer(data);
    }
    /**
     * Creates an async iterator that yields audio buffers of this track in presentation order. This method
     * will intelligently pre-decode a few buffers ahead to enable fast iteration.
     *
     * @param startTimestamp - The timestamp in seconds at which to start yielding buffers (inclusive).
     * @param endTimestamp - The timestamp in seconds at which to stop yielding buffers (exclusive).
     */
    buffers(startTimestamp = 0, endTimestamp = Infinity) {
        return mapAsyncGenerator(this._audioSampleSink.samples(startTimestamp, endTimestamp), data => this._audioSampleToWrappedArrayBuffer(data));
    }
    /**
     * Creates an async iterator that yields an audio buffer for each timestamp in the argument. This method
     * uses an optimized decoding pipeline if these timestamps are monotonically sorted, decoding each packet at most
     * once, and is therefore more efficient than manually getting the buffer for every timestamp. The iterator may
     * yield null if no buffer is available for a given timestamp.
     *
     * @param timestamps - An iterable or async iterable of timestamps in seconds.
     */
    buffersAtTimestamps(timestamps) {
        return mapAsyncGenerator(this._audioSampleSink.samplesAtTimestamps(timestamps), data => data && this._audioSampleToWrappedArrayBuffer(data));
    }
}
