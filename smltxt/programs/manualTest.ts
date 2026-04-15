import process from 'node:process';
import SmlTxt from '../src/SmlTxt';
import parsePosts from './src/parsePosts';

async function main() {
  process.stdout.write('loading table ... ');
  const before = performance.now();
  const st = SmlTxt.fromPkg();
  const after = performance.now();
  console.log(`${(after - before).toFixed(1)}ms\n`);

  const input = `The quick brown fox jumped over the lazy dog.`;
  console.log(JSON.stringify(input));
  const inputLen = new TextEncoder().encode(input).length;
  const compressed = st.compress(input);

  console.log(`= 0x${Buffer.from(compressed).toString('hex')}`);
  console.log(`bpc: ${((compressed.length / inputLen) * 8).toFixed(2)}`);

  const decompressed = st.decompress(compressed);
  console.log({decompressed});

  let totalCompressionMs = 0;
  let totalDecompressionMs = 0;
  let totalInputBytes = 0;
  let totalCompressedBytes = 0;

  let count = 0;

  process.stdout.write('\nanalyzing test-posts.json ');

  await parsePosts('data/test-posts.json', (post) => {
    let compressed: Uint8Array;

    {
      const before = performance.now();
      compressed = st.compress(post);
      const after = performance.now();
      totalCompressionMs += after - before;
    }

    {
      const before = performance.now();
      const decompressed = st.decompress(compressed);
      const after = performance.now();

      if (decompressed !== post) {
        console.error(
          'ERROR: decompression did not reproduce post',
          JSON.stringify(post),
        );
      }

      totalDecompressionMs += after - before;
    }

    totalCompressedBytes += compressed.length;
    totalInputBytes += new TextEncoder().encode(post).length;
    count++;

    if (count % 10_000 === 0) {
      process.stdout.write('.');
    }
  });

  console.log();

  console.log(
    `bpc: ${((totalCompressedBytes / totalInputBytes) * 8).toFixed(2)}`,
  );

  {
    const bytesPerSec = totalInputBytes / (totalCompressionMs / 1000);
    console.log(`compression: ${(bytesPerSec / 2 ** 20).toFixed(2)} MB/s`);
  }

  {
    const bytesPerSec = totalInputBytes / (totalDecompressionMs / 1000);
    console.log(`decompression: ${(bytesPerSec / 2 ** 20).toFixed(2)} MB/s`);
  }
}

main().catch(console.error);
