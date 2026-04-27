export default class BitArray {
    buf: Uint8Array;
    len: number;
    static fromBitWriterBuf(buf: Uint8Array): BitArray;
    constructor(buf: Uint8Array, len: number);
    at(i: number): boolean;
    debugView(): string;
}
