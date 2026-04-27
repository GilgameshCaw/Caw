export default class TableBuilder {
    symbolSizeByCtx: number[][];
    addData(s: string): void;
    build(): Uint8Array<ArrayBufferLike>;
}
