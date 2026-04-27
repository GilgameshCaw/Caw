export default class ByteWriter {
    data: Uint8Array;
    len: number;
    constructor();
    write(byte: number): void;
    finish(): Uint8Array;
}
