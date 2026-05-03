/**
 * One-shot migration: upload local files in public/uploads/{images,videos,encrypted}
 * to Filebase under the same key, then rewrite DB rows that reference
 * `/uploads/<kind>/<filename>` to point at the new MEDIA_PUBLIC_URL_BASE.
 *
 * Run with: npx ts-node src/tools/migrateMediaToFilebase.ts --dry-run
 *           npx ts-node src/tools/migrateMediaToFilebase.ts --commit
 *
 * Idempotent on the upload side (HEAD-skips files already in the bucket).
 * DB rewrite is a substring replace and only runs in --commit mode.
 *
 * Old absolute URLs that DON'T match this install's publicUrl() are left
 * alone — they're either external or from a different install.
 */
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { PrismaClient } from '@prisma/client'
import { publicUrl } from '../api/util/publicUrl'

const FILEBASE_ENDPOINT = 'https://s3.filebase.io'
const FILEBASE_REGION = 'auto'

const KINDS = ['images', 'videos', 'encrypted'] as const

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
  '.enc': 'application/octet-stream',
}

interface Args {
  dryRun: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const dryRun = !argv.includes('--commit')
  if (dryRun && !argv.includes('--dry-run')) {
    console.error('Pass --dry-run to preview or --commit to actually run.')
    process.exit(2)
  }
  return { dryRun }
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

function buildS3(): { s3: S3Client; bucket: string; oldBase: string; newBase: string; prefix: string } {
  const accessKey = process.env.FILEBASE_ACCESS_KEY
  const secret = process.env.FILEBASE_SECRET
  const bucket = process.env.FILEBASE_BUCKET
  if (!accessKey || !secret || !bucket) {
    throw new Error('FILEBASE_ACCESS_KEY, FILEBASE_SECRET, FILEBASE_BUCKET required in env')
  }
  const newBase = process.env.MEDIA_PUBLIC_URL_BASE || `https://${bucket}.s3.filebase.io`
  const prefix = (process.env.FILEBASE_KEY_PREFIX || hostnameOf(publicUrl())).replace(/^\/+|\/+$/g, '')
  return {
    s3: new S3Client({
      endpoint: FILEBASE_ENDPOINT,
      region: FILEBASE_REGION,
      credentials: { accessKeyId: accessKey, secretAccessKey: secret },
    }),
    bucket,
    oldBase: publicUrl(),
    newBase,
    prefix,
  }
}

async function existsInBucket(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (e: any) {
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return false
    throw e
  }
}

async function uploadAll(args: Args, s3: S3Client, bucket: string, prefix: string): Promise<{ uploaded: number; skipped: number; failed: number }> {
  const root = path.join(process.cwd(), 'public', 'uploads')
  let uploaded = 0, skipped = 0, failed = 0

  for (const kind of KINDS) {
    const dir = path.join(root, kind)
    let entries: string[] = []
    try { entries = await readdir(dir) } catch { continue }

    for (const entry of entries) {
      const local = path.join(dir, entry)
      const s = await stat(local).catch(() => null)
      if (!s || !s.isFile()) continue

      const key = prefix ? `${prefix}/${kind}/${entry}` : `${kind}/${entry}`
      const ext = path.extname(entry).toLowerCase()
      const contentType = MIME_BY_EXT[ext] || 'application/octet-stream'

      if (await existsInBucket(s3, bucket, key)) { skipped++; continue }

      if (args.dryRun) {
        console.log(`[dry-run] would upload ${key} (${s.size} bytes, ${contentType})`)
        uploaded++
        continue
      }

      try {
        const body = await readFile(local)
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: body, ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }))
        uploaded++
        if (uploaded % 50 === 0) console.log(`  uploaded ${uploaded}…`)
      } catch (e: any) {
        console.error(`  FAILED ${key}: ${e?.message || e}`)
        failed++
      }
    }
  }
  return { uploaded, skipped, failed }
}

async function rewriteDb(args: Args, oldBase: string, newBase: string): Promise<void> {
  // Why substring rewrite (not URL parse): the DB stores fully-formed
  // absolute URLs that look like `${publicUrl()}/uploads/...`. The Filebase
  // public URL has the same `/uploads/<kind>/<filename>` suffix shape (see
  // mediaStorage.ts), so the only thing that needs to change is the host
  // prefix. URLs from other installs (different publicUrl) get left alone,
  // which is the correct behavior — they're not ours to migrate.
  const prisma = new PrismaClient()
  try {
    const oldPrefix = `${oldBase}/uploads/`
    const newPrefix = `${newBase}/uploads/`
    if (oldPrefix === newPrefix) {
      console.log('oldBase === newBase, nothing to rewrite')
      return
    }

    console.log(`\nDB rewrite: replacing "${oldPrefix}" → "${newPrefix}"`)

    const stats: Record<string, { matched: number; updated: number }> = {}

    // User.avatarUrl
    const avatarMatches = await prisma.user.count({ where: { avatarUrl: { startsWith: oldPrefix } } })
    stats['User.avatarUrl'] = { matched: avatarMatches, updated: 0 }
    if (!args.dryRun && avatarMatches > 0) {
      const result = await prisma.$executeRaw`UPDATE "User" SET "avatarUrl" = REPLACE("avatarUrl", ${oldPrefix}, ${newPrefix}) WHERE "avatarUrl" LIKE ${oldPrefix + '%'}`
      stats['User.avatarUrl'].updated = Number(result)
    }

    // User.coverPhotoUrl
    const coverMatches = await prisma.user.count({ where: { coverPhotoUrl: { startsWith: oldPrefix } } })
    stats['User.coverPhotoUrl'] = { matched: coverMatches, updated: 0 }
    if (!args.dryRun && coverMatches > 0) {
      const result = await prisma.$executeRaw`UPDATE "User" SET "coverPhotoUrl" = REPLACE("coverPhotoUrl", ${oldPrefix}, ${newPrefix}) WHERE "coverPhotoUrl" LIKE ${oldPrefix + '%'}`
      stats['User.coverPhotoUrl'].updated = Number(result)
    }

    // Caw.imageData — substring match, since the URL is embedded in a JSON-ish payload
    const cawMatches = await prisma.caw.count({ where: { imageData: { contains: oldPrefix } } })
    stats['Caw.imageData'] = { matched: cawMatches, updated: 0 }
    if (!args.dryRun && cawMatches > 0) {
      const result = await prisma.$executeRaw`UPDATE "Caw" SET "imageData" = REPLACE("imageData", ${oldPrefix}, ${newPrefix}) WHERE "imageData" LIKE ${'%' + oldPrefix + '%'}`
      stats['Caw.imageData'].updated = Number(result)
    }

    // BugReport.imageUrls (pipe-separated)
    const bugMatches = await prisma.bugReport.count({ where: { imageUrls: { contains: oldPrefix } } })
    stats['BugReport.imageUrls'] = { matched: bugMatches, updated: 0 }
    if (!args.dryRun && bugMatches > 0) {
      const result = await prisma.$executeRaw`UPDATE "BugReport" SET "imageUrls" = REPLACE("imageUrls", ${oldPrefix}, ${newPrefix}) WHERE "imageUrls" LIKE ${'%' + oldPrefix + '%'}`
      stats['BugReport.imageUrls'].updated = Number(result)
    }

    console.log(`\nDB rewrite ${args.dryRun ? 'preview' : 'results'}:`)
    for (const [col, s] of Object.entries(stats)) {
      console.log(`  ${col}: matched=${s.matched}${args.dryRun ? '' : `, updated=${s.updated}`}`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  const args = parseArgs()
  console.log(args.dryRun ? '=== DRY RUN ===' : '=== COMMIT MODE ===')

  const { s3, bucket, oldBase, newBase, prefix } = buildS3()
  console.log(`bucket: ${bucket}`)
  console.log(`prefix: ${prefix || '(none — keys at bucket root)'}`)
  console.log(`oldBase (this install): ${oldBase}`)
  console.log(`newBase: ${newBase}`)
  console.log()

  console.log('Phase 1: uploading local files…')
  const result = await uploadAll(args, s3, bucket, prefix)
  console.log(`  uploaded=${result.uploaded} skipped=${result.skipped} failed=${result.failed}`)

  if (result.failed > 0 && !args.dryRun) {
    console.error(`\n${result.failed} file(s) failed to upload — aborting before DB rewrite.`)
    process.exit(3)
  }

  console.log('\nPhase 2: rewriting DB rows…')
  await rewriteDb(args, oldBase, newBase)

  console.log(args.dryRun
    ? '\nDry run complete. Re-run with --commit to apply.'
    : '\nMigration complete.')
}

main().catch(e => { console.error(e); process.exit(1) })
