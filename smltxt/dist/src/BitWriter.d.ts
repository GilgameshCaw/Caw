export default class BitWriter {
    data: Uint8Array;
    len: number;
    constructor();
    write(bit: boolean): void;
    at(i: number): number;
    debugView(): string;
    clone(): BitWriter;
    finish(): Uint8Array;
}
