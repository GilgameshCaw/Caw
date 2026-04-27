export default class BitArray {
    buf;
    len;
    static fromBitWriterBuf(buf) {
        const bits = new BitArray(buf, 0);
        bits.len = buf.length * 8;
        let lastByte = buf.at(-1);
        if (lastByte === 0) {
            throw new Error('Invalid bit buffer');
        }
        if (lastByte !== undefined) {
            while ((lastByte & 1) === 0) {
                lastByte >>= 1;
                bits.len--;
            }
            bits.len--;
        }
        return bits;
    }
    constructor(buf, len) {
        this.buf = buf;
        this.len = len;
    }
    at(i) {
        return Boolean(this.buf[i >> 3] & (1 << (7 - (i & 0b111))));
    }
    debugView() {
        let res = '';
        for (let i = 0; i < this.len; i++) {
            res += this.at(i) ? '1' : '0';
        }
        return res;
    }
}
