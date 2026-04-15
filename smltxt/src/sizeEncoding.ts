const minSize = 10;
const maxSize = 1_000_000_000;

// Ae^(0k) = minSize
// Ae^(255k) = maxSize
// A = minSize
// e^(255k) = maxSize / minSize
// 255k = log(maxSize / minSize)
// k = 1/255 * log(maxSize / minSize)

// Note: We can probably get by with many fewer levels. For now it's convenient
// to just use a byte for each level, but we can reduce the encoded table size
// by using bits in future. I believe there's also fancier ways encode huffman
// tables even smaller too.
const maxLevel = 255;

const k = (1 / maxLevel) * Math.log(maxSize / minSize);

// Print each byte and its decoded size
// for (let byte = 0; byte < 256; byte++) {
//   console.log(byte, Math.round(minSize * Math.exp(byte * k)));
// }

export function encodeSizes(sizes: number[]): Uint8Array {
  const buf = new Uint8Array(sizes.length);

  const maxRawSize = sizes.reduce((a, b) => Math.max(a, b), 1);

  for (const [i, size] of sizes.entries()) {
    const scaledSize = (size / maxRawSize) * maxSize;

    // Ae^(kx) = y
    // e^(kx) = y/A
    // kx = log(y/A)
    // x = log(y/A)/k

    buf[i] = Math.max(0, Math.round(Math.log(scaledSize / minSize) / k));
  }

  return buf;
}

export function decodeSizes(buf: Uint8Array): number[] {
  const res = Array.from<number>({length: buf.length});

  for (const [i, byte] of buf.entries()) {
    res[i] = Math.round(minSize * Math.exp(byte * k));
  }

  return res;
}
