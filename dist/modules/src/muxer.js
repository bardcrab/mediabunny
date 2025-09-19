/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { AsyncMutex } from './misc.js';
export class Muxer {
    constructor(output) {
        this.mutex = new AsyncMutex();
        /**
         * This field is used to synchronize multiple MediaStreamTracks. They use the same time coordinate system across
         * tracks, and to ensure correct audio-video sync, we must use the same offset for all of them. The reason an offset
         * is needed at all is because the timestamps typically don't start at zero.
         */
        this.firstMediaStreamTimestamp = null;
        this.trackTimestampInfo = new WeakMap();
        this.output = output;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onTrackClose(track) { }
    validateAndNormalizeTimestamp(track, timestampInSeconds, isKeyFrame) {
        timestampInSeconds += track.source._timestampOffset;
        let timestampInfo = this.trackTimestampInfo.get(track);
        if (!timestampInfo) {
            if (!isKeyFrame) {
                throw new Error('First frame must be a key frame.');
            }
            timestampInfo = {
                maxTimestamp: timestampInSeconds,
                maxTimestampBeforeLastKeyFrame: timestampInSeconds,
            };
            this.trackTimestampInfo.set(track, timestampInfo);
        }
        if (timestampInSeconds < 0) {
            throw new Error(`Timestamps must be non-negative (got ${timestampInSeconds}s).`);
        }
        if (isKeyFrame) {
            timestampInfo.maxTimestampBeforeLastKeyFrame = timestampInfo.maxTimestamp;
        }
        if (timestampInSeconds < timestampInfo.maxTimestampBeforeLastKeyFrame) {
            throw new Error(`Timestamps cannot be smaller than the highest timestamp of the previous run (a run begins with a`
                + ` key frame and ends right before the next key frame). Got ${timestampInSeconds}s, but highest`
                + ` timestamp is ${timestampInfo.maxTimestampBeforeLastKeyFrame}s.`);
        }
        timestampInfo.maxTimestamp = Math.max(timestampInfo.maxTimestamp, timestampInSeconds);
        return timestampInSeconds;
    }
}
