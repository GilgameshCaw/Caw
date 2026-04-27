"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class BitWriter {
    data;
    len;
    constructor() {
        this.data = new Uint8Array(16);
        this.len = 0;
    }
    write(bit) {
        const bytePos = this.len >> 3;
        const bitPos = this.len & 0b111;
        if (bytePos >= this.data.length) {
            const newData = new Uint8Array(this.data.length * 2);
            newData.set(this.data);
            this.data = newData;
        }
        if (bit) {
            this.data[bytePos] |= 1 << (7 - bitPos);
        }
        this.len++;
    }
    at(i) {
        const bytePos = i >> 3;
        const bitPos = i & 0b111;
        return this.data[bytePos] & (1 << (7 - bitPos));
    }
    debugView() {
        let res = '';
        for (let i = 0; i < this.len; i++) {
            res += this.at(i) ? '1' : '0';
        }
        return res;
    }
    clone() {
        const writer = new BitWriter();
        writer.data = this.data.slice();
        writer.len = this.len;
        return writer;
    }
    finish() {
        this.write(true);
        let res = this.data.subarray(0, (this.len >> 3) + 1);
        this.data = undefined;
        if (res.at(-1) === 0) {
            res = res.subarray(0, -1);
        }
        return res;
    }
}
exports.default = BitWriter;
