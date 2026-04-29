#!/usr/bin/env node
/**
 * VPS feasibility check for WASM image processing.
 *
 * Why this script exists: native sharp (and any other libvips-backed lib)
 * fails on QEMU virtual CPUs that don't expose linux-x64 v2 microarchitecture.
 * Pure-WASM encoders dodge that — they run on whatever can run a JS engine.
 *
 * Why we hand-load WASM bytes: @jsquash assumes a browser env and tries to
 * `fetch()` its .wasm files. Node's fetch can't load relative paths, so we
 * compile the WebAssembly.Module ourselves and pass it via init(). The
 * init() helpers are only exported from the per-format submodules
 * (`@jsquash/jpeg/decode`), not the package root.
 *
 * Usage:
 *   yarn add -D @jsquash/jpeg @jsquash/png @jsquash/webp @jsquash/resize
 *   node scripts/test-wasm-image.mjs <input-image-path>
 */
import { readFile, writeFile, stat } from 'fs/promises'
import path from 'path'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)

const input = process.argv[2]
if (!input) {
  console.error('Usage: node test-wasm-image.mjs <input-path>')
  process.exit(1)
}

async function loadWasm(specifier) {
  const wasmPath = require_.resolve(specifier)
  const bytes = await readFile(wasmPath)
  return WebAssembly.compile(bytes)
}

const t0 = Date.now()
const buf = await readFile(input)
const ext = path.extname(input).toLowerCase().slice(1)

let decoded
if (ext === 'jpg' || ext === 'jpeg') {
  const { init, default: decode } = await import('@jsquash/jpeg/decode.js')
  await init(await loadWasm('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'))
  decoded = await decode(buf)
} else if (ext === 'png') {
  // png module uses a single combined codec — different shape.
  const { default: decode, init } = await import('@jsquash/png/decode.js')
  if (init) await init(await loadWasm('@jsquash/png/codec/squoosh_png_bg.wasm'))
  decoded = await decode(buf)
} else if (ext === 'webp') {
  const { init, default: decode } = await import('@jsquash/webp/decode.js')
  await init(await loadWasm('@jsquash/webp/codec/dec/webp_dec.wasm'))
  decoded = await decode(buf)
} else {
  console.error(`Unsupported input format: ${ext}`)
  process.exit(1)
}

console.log(`decoded ${ext} → ${decoded.width}×${decoded.height} (${Date.now() - t0}ms)`)

const { default: resize, initResize } = await import('@jsquash/resize')
await initResize(await loadWasm('@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm'))
const targetWidth = 64
const targetHeight = Math.round(decoded.height * (targetWidth / decoded.width))
const resized = await resize(decoded, { width: targetWidth, height: targetHeight })
console.log(`resized → ${resized.width}×${resized.height} (${Date.now() - t0}ms total)`)

const { init: encInit, default: encode } = await import('@jsquash/webp/encode.js')
await encInit(await loadWasm('@jsquash/webp/codec/enc/webp_enc.wasm'))
const out = await encode(resized, { quality: 85 })

const outPath = `${input}.test_64.webp`
await writeFile(outPath, Buffer.from(out))
const { size } = await stat(outPath)

console.log(`wrote ${outPath} (${size} bytes, ${Date.now() - t0}ms total)`)
console.log('\nWASM encoder works on this CPU. Backfill script is unblocked.')
