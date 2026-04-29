#!/usr/bin/env node
/**
 * One-time backfill: generate _64.webp thumb variants for every user
 * avatar that was uploaded before the variant system shipped.
 *
 * Why server-side (not browser-driven): with 771 existing uploads on the
 * VPS, a browser tool would require keeping a tab open and round-tripping
 * each file over the home connection twice. Pure-WASM image processing
 * works on this VPS's QEMU CPU (verified by test-wasm-image.mjs), so we
 * can do it in-place.
 *
 * Why avatars only: small avatars are what render dozens-at-a-time in
 * feeds and lists — that's the win. Feed images render one or two at
 * a time and the user already has the bandwidth committed for the
 * post they're reading.
 *
 * Idempotent: skips any avatar where the _64 variant already exists.
 * Safe to re-run mid-backfill, after deploys, etc.
 *
 * Usage:
 *   node scripts/backfill-avatar-thumbs.mjs [--dry-run]
 */
import { readFile, writeFile, stat } from 'fs/promises'
import path from 'path'
import { createRequire } from 'module'
import { PrismaClient } from '@prisma/client'

const require_ = createRequire(import.meta.url)
const dryRun = process.argv.includes('--dry-run')

async function loadWasm(specifier) {
  const wasmPath = require_.resolve(specifier)
  return WebAssembly.compile(await readFile(wasmPath))
}

const UPLOAD_ROOT = path.join(process.cwd(), 'public', 'uploads', 'images')

// Lazy-init the WASM modules — pay the parse cost once, share across all
// images. The init helpers are exported from per-format submodules.
let initialized = false
let jpegDecode, pngDecode, webpDecode, webpEncode, resize

async function initEncoders() {
  if (initialized) return
  const jpeg = await import('@jsquash/jpeg/decode.js')
  await jpeg.init(await loadWasm('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'))
  jpegDecode = jpeg.default

  const png = await import('@jsquash/png/decode.js')
  await png.init(await loadWasm('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'))
  pngDecode = png.default

  const webpDec = await import('@jsquash/webp/decode.js')
  await webpDec.init(await loadWasm('@jsquash/webp/codec/dec/webp_dec.wasm'))
  webpDecode = webpDec.default

  const webpEnc = await import('@jsquash/webp/encode.js')
  await webpEnc.init(await loadWasm('@jsquash/webp/codec/enc/webp_enc.wasm'))
  webpEncode = webpEnc.default

  const resizeMod = await import('@jsquash/resize')
  await resizeMod.initResize(await loadWasm('@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm'))
  resize = resizeMod.default

  initialized = true
}

/**
 * Sniff the actual format from magic bytes — file extensions lie. Some
 * users have uploaded PNGs with .jpg extensions and JPEGs with .png
 * extensions, presumably by saving from one app and uploading from
 * another with a forced extension.
 */
function sniffFormat(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  return null
}

async function decodeBuffer(buf) {
  const fmt = sniffFormat(buf)
  switch (fmt) {
    case 'jpeg': return jpegDecode(buf)
    case 'png':  return pngDecode(buf)
    case 'webp': return webpDecode(buf)
    default:     throw new Error(`Unsupported format (sniff: ${fmt ?? 'unknown'})`)
  }
}

/**
 * Strip the publicUrl prefix from a stored avatar URL and return the
 * filename portion. Returns null if the URL doesn't point at our local
 * /uploads/images/ store (e.g. external IPFS link, full S3 URL).
 */
function localFilename(url) {
  if (!url) return null
  const match = url.match(/\/uploads\/images\/([a-z0-9_]+\.[a-z]+)$/i)
  return match ? match[1] : null
}

async function generateThumb(filename) {
  const fullPath = path.join(UPLOAD_ROOT, filename)
  const dot = filename.lastIndexOf('.')
  const stem = filename.slice(0, dot)
  const thumbPath = path.join(UPLOAD_ROOT, `${stem}_64.webp`)

  // Skip if thumb already exists.
  try {
    await stat(thumbPath)
    return { skipped: true }
  } catch {}

  // Skip if source missing (DB pointed at a deleted file).
  let buf
  try {
    buf = await readFile(fullPath)
  } catch {
    return { missing: true }
  }

  const decoded = await decodeBuffer(buf)
  const targetWidth = 64
  const targetHeight = Math.max(1, Math.round(decoded.height * (targetWidth / decoded.width)))
  const resized = await resize(decoded, { width: targetWidth, height: targetHeight })
  const encoded = await webpEncode(resized, { quality: 85 })

  if (dryRun) return { wouldWrite: encoded.byteLength }

  await writeFile(thumbPath, Buffer.from(encoded))
  return { wrote: encoded.byteLength }
}

async function main() {
  await initEncoders()
  const prisma = new PrismaClient()

  // Pull every user with a custom avatar — defaultAvatarId-only users have
  // no file to thumb.
  const users = await prisma.user.findMany({
    where: { avatarUrl: { not: null } },
    select: { tokenId: true, username: true, avatarUrl: true },
  })

  console.log(`${users.length} users with avatarUrl`)
  if (dryRun) console.log('--dry-run: not writing files\n')

  const stats = { wrote: 0, skipped: 0, missing: 0, external: 0, error: 0, bytes: 0 }
  const t0 = Date.now()

  for (const user of users) {
    const filename = localFilename(user.avatarUrl)
    if (!filename) { stats.external++; continue }

    try {
      const r = await generateThumb(filename)
      if (r.skipped) stats.skipped++
      else if (r.missing) stats.missing++
      else if (r.wouldWrite) { stats.wrote++; stats.bytes += r.wouldWrite }
      else { stats.wrote++; stats.bytes += r.wrote }
    } catch (err) {
      console.error(`@${user.username} (${filename}): ${err.message}`)
      stats.error++
    }
  }

  await prisma.$disconnect()

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\nDone in ${elapsed}s`)
  console.log(`  wrote:    ${stats.wrote} (${(stats.bytes / 1024).toFixed(0)} KB total)`)
  console.log(`  skipped:  ${stats.skipped} (already had thumb)`)
  console.log(`  missing:  ${stats.missing} (DB url → no file on disk)`)
  console.log(`  external: ${stats.external} (URL not in /uploads/images/)`)
  console.log(`  error:    ${stats.error}`)
}

main().catch(err => { console.error(err); process.exit(1) })
