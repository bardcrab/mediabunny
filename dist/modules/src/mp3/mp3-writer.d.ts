/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { Writer } from '../writer';
export type XingFrameData = {
    mpegVersionId: number;
    layer: number;
    frequencyIndex: number;
    channel: number;
    modeExtension: number;
    copyright: number;
    original: number;
    emphasis: number;
    frameCount: number | null;
    fileSize: number | null;
    toc: Uint8Array | null;
};
export declare class Mp3Writer {
    private writer;
    private helper;
    private helperView;
    constructor(writer: Writer);
    writeU8(value: number): void;
    writeU16(value: number): void;
    writeU32(value: number): void;
    writeAscii(text: string): void;
    writeSynchsafeU32(value: number): void;
    writeIsoString(text: string): void;
    writeUtf8String(text: string): void;
    writeId3V2TextFrame(frameId: string, text: string): void;
    writeId3V2LyricsFrame(lyrics: string): void;
    writeId3V2CommentFrame(comment: string): void;
    writeId3V2ApicFrame(mimeType: string, pictureType: number, description: string, imageData: Uint8Array): void;
    writeXingFrame(data: XingFrameData): void;
}
//# sourceMappingURL=mp3-writer.d.ts.map