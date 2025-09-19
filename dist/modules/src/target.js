/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { BufferTargetWriter, NullTargetWriter, StreamTargetWriter } from './writer.js';
/**
 * Base class for targets, specifying where output files are written.
 * @group Output targets
 * @public
 */
export class Target {
    constructor() {
        /** @internal */
        this._output = null;
        /**
         * Called each time data is written to the target. Will be called with the byte range into which data was written.
         *
         * Use this callback to track the size of the output file as it grows. But be warned, this function is chatty and
         * gets called *extremely* often.
         */
        this.onwrite = null;
    }
}
/**
 * A target that writes data directly into an ArrayBuffer in memory. Great for performance, but not suitable for very
 * large files. The buffer will be available once the output has been finalized.
 * @group Output targets
 * @public
 */
export class BufferTarget extends Target {
    constructor() {
        super(...arguments);
        /** Stores the final output buffer. Until the output is finalized, this will be `null`. */
        this.buffer = null;
    }
    /** @internal */
    _createWriter() {
        return new BufferTargetWriter(this);
    }
}
/**
 * This target writes data to a [`WritableStream`](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream),
 * making it a general-purpose target for writing data anywhere. It is also compatible with
 * [`FileSystemWritableFileStream`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemWritableFileStream) for
 * use with the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). The
 * `WritableStream` can also apply backpressure, which will propagate to the output and throttle the encoders.
 * @group Output targets
 * @public
 */
export class StreamTarget extends Target {
    /** Creates a new {@link StreamTarget} which writes to the specified `writable`. */
    constructor(writable, options = {}) {
        super();
        if (!(writable instanceof WritableStream)) {
            throw new TypeError('StreamTarget requires a WritableStream instance.');
        }
        if (options != null && typeof options !== 'object') {
            throw new TypeError('StreamTarget options, when provided, must be an object.');
        }
        if (options.chunked !== undefined && typeof options.chunked !== 'boolean') {
            throw new TypeError('options.chunked, when provided, must be a boolean.');
        }
        if (options.chunkSize !== undefined && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1024)) {
            throw new TypeError('options.chunkSize, when provided, must be an integer and not smaller than 1024.');
        }
        this._writable = writable;
        this._options = options;
    }
    /** @internal */
    _createWriter() {
        return new StreamTargetWriter(this);
    }
}
/**
 * This target just discards all incoming data. It is useful for when you need an {@link Output} but extract data from
 * it differently, for example through format-specific callbacks (`onMoof`, `onMdat`, ...) or encoder events.
 * @group Output targets
 * @public
 */
export class NullTarget extends Target {
    /** @internal */
    _createWriter() {
        return new NullTargetWriter(this);
    }
}
