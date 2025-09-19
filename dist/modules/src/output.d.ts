/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { Rotation } from './misc';
import { MetadataTags } from './tags';
import { OutputFormat } from './output-format';
import { AudioSource, SubtitleSource, VideoSource } from './media-source';
import { Target } from './target';
/**
 * The options for creating an Output object.
 * @group Output files
 * @public
 */
export type OutputOptions<F extends OutputFormat = OutputFormat, T extends Target = Target> = {
    /** The format of the output file. */
    format: F;
    /** The target to which the file will be written. */
    target: T;
};
/**
 * List of all track types.
 * @group Miscellaneous
 * @public
 */
export declare const ALL_TRACK_TYPES: readonly ["video", "audio", "subtitle"];
/**
 * Union type of all track types.
 * @group Miscellaneous
 * @public
 */
export type TrackType = typeof ALL_TRACK_TYPES[number];
export type OutputTrack = {
    id: number;
    output: Output;
    type: TrackType;
} & ({
    type: 'video';
    source: VideoSource;
    metadata: VideoTrackMetadata;
} | {
    type: 'audio';
    source: AudioSource;
    metadata: AudioTrackMetadata;
} | {
    type: 'subtitle';
    source: SubtitleSource;
    metadata: SubtitleTrackMetadata;
});
export type OutputVideoTrack = OutputTrack & {
    type: 'video';
};
export type OutputAudioTrack = OutputTrack & {
    type: 'audio';
};
export type OutputSubtitleTrack = OutputTrack & {
    type: 'subtitle';
};
/**
 * Base track metadata, applicable to all tracks.
 * @group Output files
 * @public
 */
export type BaseTrackMetadata = {
    /** The three-letter, ISO 639-2/T language code specifying the language of this track. */
    languageCode?: string;
    /** A user-defined name for this track, like "English" or "Director Commentary". */
    name?: string;
};
/**
 * Additional metadata for video tracks.
 * @group Output files
 * @public
 */
export type VideoTrackMetadata = BaseTrackMetadata & {
    /** The angle in degrees by which the track's frames should be rotated (clockwise). */
    rotation?: Rotation;
    /**
     * The expected video frame rate in hertz. If set, all timestamps and durations of this track will be snapped to
     * this frame rate. You should avoid adding more frames than the rate allows, as this will lead to multiple frames
     * with the same timestamp.
     */
    frameRate?: number;
};
/**
 * Additional metadata for audio tracks.
 * @group Output files
 * @public
 */
export type AudioTrackMetadata = BaseTrackMetadata & {};
/**
 * Additional metadata for subtitle tracks.
 * @group Output files
 * @public
 */
export type SubtitleTrackMetadata = BaseTrackMetadata & {};
/**
 * Main class orchestrating the creation of a new media file.
 * @group Output files
 * @public
 */
export declare class Output<F extends OutputFormat = OutputFormat, T extends Target = Target> {
    /** The format of the output file. */
    format: F;
    /** The target to which the file will be written. */
    target: T;
    /** The current state of the output. */
    state: 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized';
    /**
     * Creates a new instance of {@link Output} which can then be used to create a new media file according to the
     * specified {@link OutputOptions}.
     */
    constructor(options: OutputOptions<F, T>);
    /** Adds a video track to the output with the given source. Must be called before output is started. */
    addVideoTrack(source: VideoSource, metadata?: VideoTrackMetadata): void;
    /** Adds an audio track to the output with the given source. Must be called before output is started. */
    addAudioTrack(source: AudioSource, metadata?: AudioTrackMetadata): void;
    /** Adds a subtitle track to the output with the given source. Must be called before output is started. */
    addSubtitleTrack(source: SubtitleSource, metadata?: SubtitleTrackMetadata): void;
    /**
     * Sets descriptive metadata tags about the media file, such as title, author, date, or cover art. When called
     * multiple times, only the metadata from the last call will be used.
     *
     * Must be called before output is started.
     */
    setMetadataTags(tags: MetadataTags): void;
    /**
     * Starts the creation of the output file. This method should be called after all tracks have been added. Only after
     * the output has started can media samples be added to the tracks.
     *
     * @returns A promise that resolves when the output has successfully started and is ready to receive media samples.
     */
    start(): Promise<void>;
    /**
     * Resolves with the full MIME type of the output file, including track codecs.
     *
     * The returned promise will resolve only once the precise codec strings of all tracks are known.
     */
    getMimeType(): Promise<string>;
    /**
     * Cancels the creation of the output file, releasing internal resources like encoders and preventing further
     * samples from being added.
     *
     * @returns A promise that resolves once all internal resources have been released.
     */
    cancel(): Promise<void>;
    /**
     * Finalizes the output file. This method must be called after all media samples across all tracks have been added.
     * Once the Promise returned by this method completes, the output file is ready.
     */
    finalize(): Promise<void>;
}
//# sourceMappingURL=output.d.ts.map