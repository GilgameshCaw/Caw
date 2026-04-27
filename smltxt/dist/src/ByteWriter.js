"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class ByteWriter {
    data;
    len;
    constructor() {
        this.data = new Uint8Array(16);
        this.len = 0;
    }
    write(byte) {
        if (this.len >= this.data.length) {
            const newData = new Uint8Array(this.data.length * 2);
            newData.set(this.data);
            this.data = newData;
        }
        this.data[this.len] = byte;
        this.len++;
    }
    finish() {
        const res = this.data.subarray(0, this.len);
        this.data = undefined;
        return res;
    }
}
exports.default = ByteWriter;
