export default class BitReader {
    buf;
    pos;
    len;
    constructor(buf) {
        this.buf = buf;
        this.pos = 0;
        this.len = buf.length * 8;
        let lastByte = this.buf.at(-1);
        if (lastByte === 0) {
            throw new Error('Invalid bit buffer');
        }
        if (lastByte !== undefined) {
            while ((lastByte & 1) === 0) {
                lastByte >>= 1;
                this.len--;
            }
            this.len--;
        }
    }
    read() {
        if (this.pos >= this.len) {
            throw new Error('No more bits to read');
        }
        const byteIndex = Math.floor(this.pos / 8);
        const bitIndex = 7 - (this.pos % 8);
        this.pos++;
        return (this.buf[byteIndex] & (1 << bitIndex)) !== 0;
    }
    bitsRemaining() {
        return this.len - this.pos;
    }
}
