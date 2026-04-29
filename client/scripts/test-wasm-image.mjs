#!/usr/bin/env node
/**
 * VPS feasibility check for WASM image processing.
 *
 * Why this script exists: native sharp (and any other libvips-backed lib)
 * fails on QEMU virtual CPUs that don't expose linux-x64 v2 microarchitecture.
 * Pure-WASM encoders dodge that — they run on whatever can run a JS engine.
 *
 * What it does: takes a real uploaded image, decodes it, resizes to 64px,
 * re-encodes as WebP, writes the result. If this finishes without error
 * on the VPS, the backfill script (next step) is unblocked.
 *
 * Usage:
 *   yarn add -D @jsquash/jpeg @jsquash/png @jsquash/webp @jsquash/resize
 *   node scripts/test-wasm-image.mjs <input-image-path>
 */
import { readFile, writeFile, stat } from 'fs/promises'
import path from 'path'

const input = process.argv[2]
if (!input) {
  console.error('Usage: node test-wasm-image.mjs <input-path>')
  process.exit(1)
}

const t0 = Date.now()
const buf = await readFile(input)
const ext = path.extname(input).toLowerCase().slice(1)

// Pick the right decoder by extension. WASM packages are loaded lazily so
// we don't pay the .wasm parse cost for formats we won't use.
let decoded
if (ext === 'jpg' || ext === 'jpeg') {
  const jpeg = await import('@jsquash/jpeg')
  decoded = await jpeg.decode(buf)
} else if (ext === 'png') {
  const png = await import('@jsquash/png')
  decoded = await png.decode(buf)
} else if (ext === 'webp') {
  const webp = await import('@jsquash/webp')
  decoded = await webp.decode(buf)
} else {
  console.error(`Unsupported input format: ${ext}`)
  process.exit(1)
}

console.log(`decoded ${ext} → ${decoded.width}×${decoded.height} (${Date.now() - t0}ms)`)

const resize = (await import('@jsquash/resize')).default
const targetWidth = 64
const targetHeight = Math.round(decoded.height * (targetWidth / decoded.width))
const resized = await resize(decoded, { width: targetWidth, height: targetHeight })
console.log(`resized → ${resized.width}×${resized.height} (${Date.now() - t0}ms total)`)

const webp = await import('@jsquash/webp')
const out = await webp.encode(resized, { quality: 85 })

const outPath = `${input}.test_64.webp`
await writeFile(outPath, Buffer.from(out))
const { size } = await stat(outPath)

console.log(`wrote ${outPath} (${size} bytes, ${Date.now() - t0}ms total)`)
console.log('\nWASM encoder works on this CPU. Backfill script is unblocked.')
