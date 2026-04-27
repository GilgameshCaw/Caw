export default class BitReader {
    buf: Uint8Array;
    pos: number;
    len: number;
    constructor(buf: Uint8Array);
    read(): boolean;
    bitsRemaining(): number;
}
