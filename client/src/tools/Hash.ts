import makeHasher from 'keccak';

export default class Hash {
  static fromInput(msg: string | Uint8Array) {
    if (typeof msg === 'string') {
      msg = new TextEncoder().encode(msg);
    }

    return new Hash(makeHasher('keccak256').update(Buffer.from(msg)).digest());
  }

  static fromHex(hex: string) {
    const buf = hexToBuf(hex);

    if (buf.length !== 32) {
      throw new Error('expected 256 bits' + buf.length);
    }

    return new Hash(buf);
  }

  readonly #nominal = undefined;

  private constructor(readonly data: Uint8Array) {}
}

export function hexToBuf(hex: string) {
  if (!/^0x([\da-f]{2})*$/i.test(hex)) {
    throw new Error('input is not a hex string');
  }

  const data = new Uint8Array(hex.length / 2 - 1);

  for (let i = 2; i < hex.length; i += 2) {
    data[i] = Number.parseInt(hex.slice(i, i + 2), 16);
  }

  return data;
}
