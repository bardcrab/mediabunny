/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { MaybePromise } from './misc';
import { Source } from './source';
export declare class Reader {
    source: Source;
    fileSize: number | null;
    constructor(source: Source);
    requestSlice(start: number, length: number): MaybePromise<FileSlice | null>;
    requestSliceRange(start: number, minLength: number, maxLength: number): MaybePromise<FileSlice | null>;
}
export declare class FileSlice {
    readonly bytes: Uint8Array;
    readonly view: DataView;
    private readonly offset;
    readonly start: number;
    readonly end: number;
    bufferPos: number;
    constructor(bytes: Uint8Array, view: DataView, offset: number, start: number, end: number);
    static tempFromBytes(bytes: Uint8Array): FileSlice;
    get length(): number;
    get filePos(): number;
    set filePos(value: number);
    skip(byteCount: number): void;
    slice(filePos: number, length?: number): FileSlice;
}
export declare const readBytes: (slice: FileSlice, length: number) => Uint8Array<ArrayBufferLike>;
export declare const readU8: (slice: FileSlice) => number;
export declare const readU16: (slice: FileSlice, littleEndian: boolean) => number;
export declare const readU16Be: (slice: FileSlice) => number;
export declare const readU24Be: (slice: FileSlice) => number;
export declare const readI16Be: (slice: FileSlice) => number;
export declare const readU32: (slice: FileSlice, littleEndian: boolean) => number;
export declare const readU32Be: (slice: FileSlice) => number;
export declare const readU32Le: (slice: FileSlice) => number;
export declare const readI32Be: (slice: FileSlice) => number;
export declare const readI32Le: (slice: FileSlice) => number;
export declare const readU64: (slice: FileSlice, littleEndian: boolean) => number;
export declare const readU64Be: (slice: FileSlice) => number;
export declare const readI64Be: (slice: FileSlice) => number;
export declare const readI64Le: (slice: FileSlice) => number;
export declare const readF32Be: (slice: FileSlice) => number;
export declare const readF64Be: (slice: FileSlice) => number;
export declare const readAscii: (slice: FileSlice, length: number) => string;
//# sourceMappingURL=reader.d.ts.map