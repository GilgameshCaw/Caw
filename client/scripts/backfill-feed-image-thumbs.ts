// Backfill 320px and 640px inline variants for existing feed images.
//
// New uploads write _320 / _640 / _2048 alongside the 1024 main (see
// uploadFeedImage). Anything posted before that pipeline shipped only
// has the 1024 main and the _2048 lightbox, so the FE's <img srcset>
// candidates 404 down to the largest available — which is the 1024 main
// even on a mobile two-up cell where 320 would suffice.
//
// This script walks every /uploads/images/ URL referenced in Caw.content
// and ShortUrl.originalUrl, fetches the existing 1024 main, and produces
// the two missing inline variants via ffmpeg (down-sample only, never
// upscale). Skips URLs whose variants already exist. Two-location aware
// like backfill-avatar-thumbs.ts — writes to the storage backend for
// MEDIA_PUBLIC_URL_BASE-hosted files, writes directly to public/uploads/
// images/ for legacy local-disk files served by the API's own nginx.
//
// Usage:
//   npx tsx scripts/backfill-feed-image-thumbs.ts            # live run
//   npx tsx scripts/backfill-feed-image-thumbs.ts --dry-run  # report only

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
const FFMPEG_TIMEOUT_MS = 20_000
const VARIANT_WIDTHS = [320, 640] as const

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

type Stats = {
  urls_seen: number
  unique_urls: number
  skipped_external: number
  skipped_unsupported_ext: number
  skipped_already_variant: number
  skipped_main_missing: number
  variants_generated_backend: number
  variants_generated_local: number
  variants_already_exist: number
  variants_skipped_source_too_small: number
  failed: number
}

type Location = 'backend' | 'local-disk'

function ourHosts(): { backendHost: string; localHost: string } {
  let localHost = ''
  try { localHost = new URL(publicUrl()).host } catch { /* ignore */ }
  let backendHost = localHost
  if (process.env.MEDIA_PUBLIC_URL_BASE) {
    try { backendHost = new URL(process.env.MEDIA_PUBLIC_URL_BASE).host } catch { /* ignore */ }
  }
  return { backendHost, localHost }
}

function classifyUrl(url: string): Location | null {
  if (!url || !url.includes('/uploads/images/')) return null
  let host: string
  try { host = new URL(url).host } catch { return null }
  const { backendHost, localHost } = ourHosts()
  if (host === backendHost) return 'backend'
  if (host === localHost) return 'local-disk'
  return null
}

function parseFilename(url: string): { stem: string; ext: string; filename: string } | null {
  const filename = url.split('/').pop()?.split('?')[0]
  if (!filename) return null
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  const stem = filename.slice(0, dot)
  const ext = filename.slice(dot).toLowerCase()
  if (/_\d+$/.test(stem)) return null  // already a variant
  return { stem, ext, filename }
}

const LOCAL_IMAGES_DIR = path.join(process.cwd(), 'public', 'uploads', 'images')

async function localFileExists(filename: string): Promise<boolean> {
  try { await access(path.join(LOCAL_IMAGES_DIR, filename)); return true } catch { return false }
}

async function writeLocalVariant(filename: string, body: Buffer): Promise<void> {
  await mkdir(LOCAL_IMAGES_DIR, { recursive: true })
  await writeFile(path.join(LOCAL_IMAGES_DIR, filename), body)
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

// Probe an image's dimensions via ffprobe. Returns null on parse
// failure; callers treat that as "couldn't tell" and keep going.
async function probeDimensions(buf: Buffer, ext: string): Promise<{ w: number; h: number } | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'feed-probe-'))
  const inPath = path.join(dir, `in${ext}`)
  try {
    await writeFile(inPath, buf)
    const { stdout } = await exec('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      inPath,
    ], { timeout: FFMPEG_TIMEOUT_MS })
    const [w, h] = stdout.trim().split('x').map(n => parseInt(n, 10))
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null
    return { w, h }
  } catch {
    return null
  } finally {
    await unlink(inPath).catch(() => {})
  }
}

// Down-sample to WIDTH on the long edge, preserving aspect (no crop).
// Caller must pre-check that the source is bigger than WIDTH — we never
// upscale (the "thumb" would just be a re-encode the same size as the
// main, costing storage with no bandwidth win).
async function makeVariant(buf: Buffer, ext: string, width: number): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'feed-variant-'))
  const inPath = path.join(dir, `in${ext}`)
  const outPath = path.join(dir, `out${ext}`)
  try {
    await writeFile(inPath, buf)
    // Long-edge cap. Whichever of iw/ih is larger gets set to WIDTH;
    // the other side scales proportionally via -1.
    const filter = `scale=w='if(gt(iw,ih),${width},-1)':h='if(gt(iw,ih),-1,${width})':flags=lanczos`
    await exec('ffmpeg', [
      '-y',
      '-i', inPath,
      '-vf', filter,
      '-frames:v', '1',
      '-update', '1',
      outPath,
    ], { timeout: FFMPEG_TIMEOUT_MS })
    return await readFile(outPath)
  } catch (err: any) {
    console.warn(`  ffmpeg failed (${width}px): ${err?.message || err}`)
    return null
  } finally {
    await unlink(inPath).catch(() => {})
    await unlink(outPath).catch(() => {})
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"'{}|\\^`[\]]+/g

function extractImageUrls(text: string | null | undefined): string[] {
  if (!text) return []
  const out: string[] = []
  const matches = text.match(URL_PATTERN)
  if (!matches) return out
  for (const u of matches) {
    if (!u.includes('/uploads/images/')) continue
    out.push(u)
  }
  return out
}

async function collectAllUrls(): Promise<Set<string>> {
  const urls = new Set<string>()

  // Caw.content — the dominant source. We pull in chunks because
  // total content body across the whole table is much bigger than the
  // working set we want in memory at once.
  const PAGE = 1000
  let cursor = 0
  for (;;) {
    const rows = await prisma.caw.findMany({
      select: { id: true, content: true },
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: PAGE,
    })
    if (rows.length === 0) break
    for (const r of rows) {
      for (const u of extractImageUrls(r.content)) urls.add(u)
      cursor = r.id
    }
  }

  // ShortUrl.originalUrl — direct image short-URLs that resolve to
  // /uploads/images/. The render path is the same; same backfill need.
  const shortUrls = await prisma.shortUrl.findMany({
    where: { originalUrl: { contains: '/uploads/images/' } },
    select: { originalUrl: true },
  })
  for (const r of shortUrls) urls.add(r.originalUrl)

  return urls
}

async function main(): Promise<void> {
  console.log(`[backfill-feed-image-thumbs] starting ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`)
  console.log(`  publicUrl=${publicUrl()}  MEDIA_PUBLIC_URL_BASE=${process.env.MEDIA_PUBLIC_URL_BASE || '(none)'}`)
  console.log(`  storage backend=${process.env.MEDIA_STORAGE_BACKEND || 'local'}`)
  console.log(`  variant widths=${VARIANT_WIDTHS.join(',')}`)

  const storage = mediaStorage()
  const stats: Stats = {
    urls_seen: 0,
    unique_urls: 0,
    skipped_external: 0,
    skipped_unsupported_ext: 0,
    skipped_already_variant: 0,
    skipped_main_missing: 0,
    variants_generated_backend: 0,
    variants_generated_local: 0,
    variants_already_exist: 0,
    variants_skipped_source_too_small: 0,
    failed: 0,
  }

  console.log('  scanning Caw.content + ShortUrl.originalUrl …')
  const urls = await collectAllUrls()
  stats.unique_urls = urls.size
  console.log(`  found ${urls.size} unique image URLs to consider`)

  let processed = 0
  for (const url of urls) {
    stats.urls_seen++
    processed++
    if (processed % 100 === 0) console.log(`  …${processed}/${urls.size}`)

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
      continue
    }

    // Lazy-fetch the main + probe dimensions only when we know at
    // least one variant is missing. Avoids redundant work when both
    // variants already exist for an image.
    let mainBuf: Buffer | null = null
    let sourceLongEdge: number | null = null

    for (const w of VARIANT_WIDTHS) {
      const variantName = `${stem}_${w}${ext}`

      const exists = where === 'backend'
        ? await storage.baseExists('images', variantName)
        : await localFileExists(variantName)
      if (exists) {
        stats.variants_already_exist++
        continue
      }

      const mainExists = where === 'backend'
        ? await storage.baseExists('images', filename)
        : await localFileExists(filename)
      if (!mainExists) {
        stats.skipped_main_missing++
        console.log(`  main missing on ${where} (${filename})`)
        break
      }

      if (!mainBuf) {
        mainBuf = await fetchBuffer(url)
        if (!mainBuf) {
          console.warn(`  fetch failed: ${url}`)
          stats.failed++
          break
        }
        const dims = await probeDimensions(mainBuf, ext)
        sourceLongEdge = dims ? Math.max(dims.w, dims.h) : null
      }

      // Don't generate a variant that's >= the source's long edge —
      // it would just be a re-encoded copy of the main. Lets small
      // images (avatars accidentally posted as feed content, screenshots
      // already at thumb resolution) skip cheaply.
      if (sourceLongEdge !== null && w >= sourceLongEdge) {
        stats.variants_skipped_source_too_small++
        continue
      }

      if (DRY_RUN) {
        console.log(`  would generate ${variantName} on ${where} (source long edge=${sourceLongEdge ?? '?'})`)
        if (where === 'backend') stats.variants_generated_backend++; else stats.variants_generated_local++
        continue
      }

      const variant = await makeVariant(mainBuf, ext, w)
      if (!variant) {
        stats.failed++
        continue
      }

      try {
        if (where === 'backend') {
          await storage.putVariant(filename, variantName, variant, EXT_TO_MIME[ext] || 'application/octet-stream')
          stats.variants_generated_backend++
        } else {
          await writeLocalVariant(variantName, variant)
          stats.variants_generated_local++
        }
        console.log(`  wrote ${variantName} on ${where} (${(variant.length / 1024).toFixed(1)}KB)`)
      } catch (err: any) {
        console.error(`  write failed (${variantName}): ${err?.message || err}`)
        stats.failed++
      }
    }
  }

  console.log('\n[backfill-feed-image-thumbs] done')
  console.log(JSON.stringify(stats, null, 2))
}

main()
  .then(() => prisma.$disconnect())
  .catch(err => { console.error(err); prisma.$disconnect().finally(() => process.exit(1)) })
