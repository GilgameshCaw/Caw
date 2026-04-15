export default class ByteWriter {
  data: Uint8Array;
  len: number;

  constructor() {
    this.data = new Uint8Array(16);
    this.len = 0;
  }

  write(byte: number) {
    if (this.len >= this.data.length) {
      const newData = new Uint8Array(this.data.length * 2);
      newData.set(this.data);
      this.data = newData;
    }

    this.data[this.len] = byte;

    this.len++;
  }

  finish(): Uint8Array {
    const res = this.data.subarray(0, this.len);
    (this.data as any) = undefined;

    return res;
  }
}
