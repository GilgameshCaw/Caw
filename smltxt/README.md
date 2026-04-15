# smltxt

Compresses text. Even small amounts of text.

## Usage

```ts
import SmlTxt from 'smltxt';

const st = SmlTxt.fromPkg();

const compressed = st.compress('hello world');
console.log(compressed);

const decompressed = st.decompress(compressed);
console.log(decompressed);
```

## Why not gzip/etc?

Those programs are not meant for small inputs. For example:

```
$ echo -n 'hello world' | wc -c
    11
$ echo -n 'hello world' | gzip | wc -c
    31
```

Above, gzip *expands* `hello world` from 11 bytes to 31 bytes. This is the
opposite of what we want.

You can improve on this by removing headers, adding a dictionary and such, but
these programs still refuse to produce meaningful compression for small inputs.

By contrast, smltxt compresses `hello world` into `0xbdd5f39c115c`, which is
just 6 bytes.

## Build Instructions

### Phase 1: Create `data/posts.json`

Training data should be in line-json format — each line a valid JSON-encoded
string (the post text). Place it at `data/posts.json`.

If you have a corpus of posts organized as JSON-per-line files under
`data/post-stream/`, `npm run digest-posts` will flatten them into
`data/posts.json`.

### Phase 2: Create `data/table.dat`

Split posts.json into train-posts.json and test-posts.json:

```
$ cd data
$ wc -l posts.json
   6461041 posts.json # adjust numbers below based on this number
$ head -n6000000 posts.json >train-posts.json
$ tail -n461041 posts.json >test-posts.json
$ cd ..
```

Then create `data/table.dat` with:
```sh
npm run build-table-data
```

Optionally, you can do some manual testing:

```
$ npm run manual-test

> smltxt@0.1.0 manual-test
> tsx programs/manualTest.ts

loading table ... 1759.1ms

"hello world"
= 0xbdd5f39c115c
bpc: 4.36

analyzing test-posts.json ..............................................
bpc: 5.08
speed: 11.65 MB/s
```

### Phase 3: Inline the table

`src/tableData.ts` embeds `data/table.dat` as a base64 string so that
`SmlTxt.fromPkg()` works without any network or filesystem access. After
rebuilding `data/table.dat`, regenerate `src/tableData.ts`:

```sh
node -e "const fs=require('fs');const b64=fs.readFileSync('data/table.dat').toString('base64');fs.writeFileSync('src/tableData.ts',\`const base64 = \${JSON.stringify(b64)};\\n\\nfunction decodeBase64(s: string): Uint8Array {\\n  if (typeof Buffer !== \\\"undefined\\\") return new Uint8Array(Buffer.from(s, \\\"base64\\\"));\\n  const bin = atob(s);\\n  const out = new Uint8Array(bin.length);\\n  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);\\n  return out;\\n}\\n\\nconst tableData: Uint8Array = decodeBase64(base64);\\nexport default tableData;\\n\`)"
```
