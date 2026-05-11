// Backfill 96px square thumb variants for existing user avatars.
//
// The FE renders avatars at small sizes (feed items, comments, mention
// autocomplete, profile chooser) by deriving the thumb URL from the main
// URL via avatarThumbUrl() — `<id>.<ext>` → `<id>_96.<ext>`. Variants are
// generated client-side at upload time (see uploadAvatar), so any avatar
// uploaded before the variant pipeline existed (or where the thumb upload
// silently failed) currently 404s on the thumb and the renderer falls back
// to downloading the full-size original.
//
// This script walks every User.avatarUrl that points at our own storage,
// fetches the original, generates a 96×96 center-cropped thumb via
// ffmpeg (already on PATH, used elsewhere for OG cards), and writes it
// to storage under `<id>_96.<ext>`. Idempotent — skips any URL whose
// thumb already exists. Skips avatars that don't live in our storage
// (peer-mirror URLs, external avatars), since we can't write to those.
//
// Usage:
//   npx tsx scripts/backfill-avatar-thumbs.ts            # live run
//   npx tsx scripts/backfill-avatar-thumbs.ts --dry-run  # report only
//
// Safe to re-run: nothing destructive, all existence checks are atomic.

import 'dotenv/config'
import { promisify } from 'util'
import { execFile } from 'child_process'
import { writeFile, unlink, mkdtemp, readFile, mkdir, access } from 'fs/promises'
import path from 'path'
import os from 'os'
import { prisma } from '../src/prismaClient'
import { mediaStorage } from '../src/api/util/mediaStorage'
import { publicUrl } from '../src/api/util/publicUrl'

const exec = promisify(execFile)
const DRY_RUN = process.argv.includes('--dry-run')
const THUMB_WIDTH = 96
const FFMPEG_TIMEOUT_MS = 15_000

// Extensions ffmpeg will reliably re-encode for us. .gif is excluded
// intentionally — ffmpeg would extract the first frame and lose
// animation, and animated avatars are rare enough that silently
// breaking them is worse than leaving them on the fallback path.
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

// Mime to set on the variant. The variant route stores the file under
// the BASE extension regardless of payload mime, so we just keep the
// source mime here.
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

type Stats = {
  total: number
  skipped_external: number
  skipped_unsupported_ext: number
  skipped_already_variant: number
  skipped_thumb_exists: number
  skipped_main_missing: number
  generated_backend: number
  generated_local: number
  failed: number
}

type Location = 'backend' | 'local-disk'

function ourHosts(): { backendHost: string; localHost: string } {
  // - localHost  = publicUrl()'s host (e.g. test.caw.social) — files
  //                served by the API server's own nginx off local disk.
  //                Pre-Filebase-migration uploads still live here.
  // - backendHost = MEDIA_PUBLIC_URL_BASE host (e.g. s.caw.social) when
  //                 set, otherwise same as localHost. Filebase-backed
  //                 uploads write here via the s3 client.
  let localHost = ''
  try { localHost = new URL(publicUrl()).host } catch { /* ignore */ }
  let backendHost = localHost
  if (process.env.MEDIA_PUBLIC_URL_BASE) {
    try { backendHost = new URL(process.env.MEDIA_PUBLIC_URL_BASE).host } catch { /* ignore */ }
  }
  return { backendHost, localHost }
}

function classifyUrl(url: string): Location | null {
  // Returns 'backend' for URLs the active mediaStorage() is responsible
  // for, 'local-disk' for legacy URLs hosted by the API server's own
  // nginx off local disk, null for everything else (peer mirrors,
  // external services — we can't write to those).
  if (!url || !url.includes('/uploads/images/')) return null
  let host: string
  try { host = new URL(url).host } catch { return null }
  const { backendHost, localHost } = ourHosts()
  if (host === backendHost) return 'backend'
  if (host === localHost) return 'local-disk'
  return null
}

const LOCAL_IMAGES_DIR = path.join(process.cwd(), 'public', 'uploads', 'images')

async function localFileExists(filename: string): Promise<boolean> {
  try { await access(path.join(LOCAL_IMAGES_DIR, filename)); return true } catch { return false }
}

async function writeLocalVariant(filename: string, body: Buffer): Promise<void> {
  await mkdir(LOCAL_IMAGES_DIR, { recursive: true })
  await writeFile(path.join(LOCAL_IMAGES_DIR, filename), body)
}

function parseFilename(url: string): { stem: string; ext: string; filename: string } | null {
  const filename = url.split('/').pop()
  if (!filename) return null
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  const stem = filename.slice(0, dot)
  const ext = filename.slice(dot).toLowerCase()
  if (/_\d+$/.test(stem)) return null  // already a variant
  return { stem, ext, filename }
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } catch {
    return null
  }
}

async function makeThumb(buf: Buffer, ext: string): Promise<Buffer | null> {
  // ffmpeg pipeline: scale so the shorter side is THUMB_WIDTH px, then
  // center-crop to a THUMB_WIDTH×THUMB_WIDTH square. Identical math to
  // the canvas pipeline in compressImage('thumb') + cropToSquare(), so
  // the visual output matches what new uploads produce.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avatar-thumb-'))
  const inPath = path.join(dir, `in${ext}`)
  const outPath = path.join(dir, `out${ext}`)
  try {
    await writeFile(inPath, buf)
    const filter = `scale=w='if(gt(iw,ih),-1,${THUMB_WIDTH})':h='if(gt(iw,ih),${THUMB_WIDTH},-1)':flags=lanczos,crop=${THUMB_WIDTH}:${THUMB_WIDTH}`
    await exec('ffmpeg', [
      '-y',
      '-i', inPath,
      '-vf', filter,
      '-frames:v', '1',
      '-update', '1',  // single-image output (silences image2-muxer warning for jpg/png)
      outPath,
    ], { timeout: FFMPEG_TIMEOUT_MS })
    return await readFile(outPath)
  } catch (err: any) {
    console.warn(`  ffmpeg failed: ${err?.message || err}`)
    return null
  } finally {
    await unlink(inPath).catch(() => {})
    await unlink(outPath).catch(() => {})
  }
}

async function main(): Promise<void> {
  console.log(`[backfill-avatar-thumbs] starting ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`)
  console.log(`  publicUrl=${publicUrl()}  MEDIA_PUBLIC_URL_BASE=${process.env.MEDIA_PUBLIC_URL_BASE || '(none)'}`)
  console.log(`  storage backend=${process.env.MEDIA_STORAGE_BACKEND || 'local'}`)

  const storage = mediaStorage()
  const stats: Stats = {
    total: 0,
    skipped_external: 0,
    skipped_unsupported_ext: 0,
    skipped_already_variant: 0,
    skipped_thumb_exists: 0,
    skipped_main_missing: 0,
    generated_backend: 0,
    generated_local: 0,
    failed: 0,
  }

  const users = await prisma.user.findMany({
    where: { avatarUrl: { not: null } },
    select: { id: true, username: true, avatarUrl: true },
    orderBy: { id: 'asc' },
  })
  console.log(`  ${users.length} users with avatarUrl`)

  for (const u of users) {
    stats.total++
    const url = u.avatarUrl!

    const where = classifyUrl(url)
    if (!where) {
      stats.skipped_external++
      continue
    }

    const parsed = parseFilename(url)
    if (!parsed) {
      stats.skipped_already_variant++
      continue
    }
    const { stem, ext, filename } = parsed

    if (!SUPPORTED_EXT.has(ext)) {
      stats.skipped_unsupported_ext++
      console.log(`  ${u.username}: unsupported ext ${ext} (${filename})`)
      continue
    }

    const variantName = `${stem}_${THUMB_WIDTH}${ext}`

    // Existence checks per location:
    //   - 'backend' files: ask the storage adapter (filebase HeadObject
    //     or local fs.access).
    //   - 'local-disk' files: check the local images dir directly. The
    //     storage adapter doesn't know about these — they pre-date the
    //     filebase migration and are still served by the API's nginx.
    let mainExists: boolean
    let thumbExists: boolean
    if (where === 'backend') {
      thumbExists = await storage.baseExists('images', variantName)
      mainExists = thumbExists ? true : await storage.baseExists('images', filename)
    } else {
      thumbExists = await localFileExists(variantName)
      mainExists = thumbExists ? true : await localFileExists(filename)
    }

    if (thumbExists) {
      stats.skipped_thumb_exists++
      continue
    }
    if (!mainExists) {
      stats.skipped_main_missing++
      console.log(`  ${u.username}: main missing on ${where} (${filename})`)
      continue
    }

    if (DRY_RUN) {
      console.log(`  ${u.username}: would generate ${variantName} on ${where}`)
      if (where === 'backend') stats.generated_backend++; else stats.generated_local++
      continue
    }

    const buf = await fetchBuffer(url)
    if (!buf) {
      console.warn(`  ${u.username}: fetch failed for ${url}`)
      stats.failed++
      continue
    }

    const thumb = await makeThumb(buf, ext)
    if (!thumb) {
      stats.failed++
      continue
    }

    try {
      if (where === 'backend') {
        await storage.putVariant(filename, variantName, thumb, EXT_TO_MIME[ext] || 'application/octet-stream')
        stats.generated_backend++
      } else {
        await writeLocalVariant(variantName, thumb)
        stats.generated_local++
      }
      console.log(`  ${u.username}: wrote ${variantName} on ${where} (${(thumb.length / 1024).toFixed(1)}KB)`)
    } catch (err: any) {
      console.error(`  ${u.username}: write failed: ${err?.message || err}`)
      stats.failed++
    }
  }

  console.log('\n[backfill-avatar-thumbs] done')
  console.log(JSON.stringify(stats, null, 2))
}

main()
  .then(() => prisma.$disconnect())
  .catch(err => { console.error(err); prisma.$disconnect().finally(() => process.exit(1)) })
