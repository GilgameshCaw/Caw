// Orphan media GC. Tracks media files that are no longer referenced
// (post hidden, avatar replaced, etc.) and deletes them from Filebase
// after a 7-day grace period.
//
// Why a 7-day grace:
//   - Hide is permanent (recorded on-chain, can't be undone — see the
//     hide-confirmation copy in FeedItem.tsx), so revertibility isn't
//     the concern. The grace is for indexer lag and in-flight clients.
//   - Indexer lag: a hide action might race with someone else loading
//     the post. Keeping the file briefly avoids 404s in that window.
//   - Cheap insurance — Filebase storage is metered but not expensive,
//     and a recoverable mistake beats an unrecoverable one.
//
// Design (option B from the planning conversation):
//   - Redis sorted set keyed by delete-after-timestamp
//     ZADD orphan_media <delete_at_ms> <bucket_key>
//   - Sweep job polls ZRANGEBYSCORE 0 <now>, deletes the keys from
//     Filebase, then ZREM-s them from the set.
//   - No DB schema change — keeps the testnet-friendly approach the user
//     asked for. If we ever need an audit trail, swap in a MediaAsset
//     table; the API of this module stays identical.
//
// We track BUCKET KEYS (the Filebase path), not URLs. Parsing the URL
// to a key happens on the way in. Keys are stable; URLs depend on the
// MEDIA_PUBLIC_URL_BASE config which can change.

import Redis from 'ioredis'
import { prisma } from '../../prismaClient'
import { mediaStorage, type MediaKind } from './mediaStorage'

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

const ZSET_KEY = 'orphan_media'
const GRACE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Convert a public media URL to its bucket-side key. Handles both the
 * Filebase-fronted shape (https://s.<host>/uploads/<kind>/<file>) and
 * the legacy local-disk shape (https://<api-host>/uploads/<kind>/<file>).
 *
 * Returns null for URLs we don't recognize (external URLs, default
 * avatars, gravatar, etc.) — those aren't ours to delete.
 *
 * Delegates the prefix to MediaStorage.bucketKeyFor so the key here
 * matches exactly what put() wrote. Computing the prefix locally would
 * drift the moment FilebaseMediaStorage's resolution changes.
 */
export function urlToBucketKey(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  // Default-avatar PNGs ship with the FE bundle; never delete those.
  if (url.includes('/images/avatars/')) return null
  // We only own /uploads/<images|videos|encrypted>/<filename> paths.
  const match = url.match(/\/uploads\/(images|videos|encrypted)\/([^?#]+)$/)
  if (!match) return null
  const kind = match[1] as MediaKind
  const filename = match[2]
  return mediaStorage().bucketKeyFor(kind, filename)
}

/**
 * Mark a URL for delayed deletion. No-op for URLs that don't resolve to
 * one of our bucket keys, so callers don't have to filter.
 */
export async function markOrphan(url: string | null | undefined): Promise<void> {
  const key = urlToBucketKey(url)
  if (!key) return
  const deleteAt = Date.now() + GRACE_MS
  try {
    await redis.zadd(ZSET_KEY, deleteAt, key)
  } catch (e) {
    console.warn('[orphanedMedia] markOrphan failed (non-fatal):', e)
  }
}

/**
 * Mark a base URL plus its known size-suffixed variants for delayed
 * deletion. Used for avatar replacement (main + 96px thumb) and feed
 * images (main + 2048px lightbox).
 *
 * Variant naming MUST mirror appendWidthSuffix() in
 * services/FrontEnd/src/utils/imageVariants.ts and POST /upload/variant:
 * `<stem>_<width><ext>`, keeping the base's extension. `<stem>_<width>.webp`
 * is also marked for a non-webp base, the older convention. If that helper
 * changes the convention, this enumeration goes stale and the variants leak.
 * We enqueue at mark-time (not enumerate at sweep-time) to avoid a Filebase
 * ListObjects call per sweep, which costs both bandwidth and request budget.
 *
 * Widths covered: 64 (legacy avatar thumb), 96 (current avatar thumb),
 * 320 / 640 (feed srcset), 2048 (feed lightbox). Marking a URL that has no
 * variant is harmless — the sweep tries to delete and continues on 404.
 */
const VARIANT_WIDTHS = [64, 96, 320, 640, 2048]

export async function markOrphanWithVariants(url: string | null | undefined): Promise<void> {
  if (!url || typeof url !== 'string') return
  await markOrphan(url)
  // Skip variant marking for URLs that don't fit the variant convention
  // — same skip rules as appendWidthSuffix().
  if (!url.includes('/uploads/images/')) return
  if (url.includes('/images/avatars/')) return
  const dot = url.lastIndexOf('.')
  if (dot < 0) return
  const stem = url.slice(0, dot)
  const ext = url.slice(dot)
  if (/_\d+$/.test(stem)) return // already a variant URL — don't re-derive
  for (const w of VARIANT_WIDTHS) {
    await markOrphan(`${stem}_${w}${ext}`)
    if (ext !== '.webp') await markOrphan(`${stem}_${w}.webp`)
  }
}

/**
 * Mark every URL referenced inside a Caw.imageData blob, with the feed
 * variants the FE uploads next to each image. The blob is
 * pipe-separated and prefixed with `urls:` per the cawUtils convention
 * (see "imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}`"
 * in actionHandlers.ts).
 */
export async function markOrphansInImageData(imageData: string | null | undefined): Promise<void> {
  if (!imageData || typeof imageData !== 'string') return
  if (!imageData.startsWith('urls:')) return
  const urls = imageData.slice(5).split('|||')
  for (const u of urls) {
    await markOrphanWithVariants(u)
  }
}

/**
 * Whether a file is still referenced somewhere live, checked right before
 * the sweep deletes it.
 *
 * A mark only says that ONE reference went away. Nothing records who
 * uploaded a file, and post image URLs are taken from the post text
 * (actionHandlers.ts), so the same file can sit in someone else's live post,
 * avatar or poll: hiding a post that pasted another user's image URL, or
 * setting another user's image as your avatar and then changing it, used to
 * delete that user's file after the grace period.
 *
 * Matches on `<kind>/<stem>`, with a variant's `_<width>` dropped, so a
 * reference to the base keeps its variants too. Over-matching only keeps a
 * file longer.
 */
export async function isStillReferenced(kind: MediaKind, filename: string): Promise<boolean> {
  const dot = filename.lastIndexOf('.')
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).replace(/_\d+$/, '')
  const needle = `${kind}/${stem}`
  const has = { contains: needle }

  const caw = await prisma.caw.findFirst({
    where: {
      status: { not: 'HIDDEN' },
      OR: [{ imageData: has }, { videoData: has }, { content: has }],
    },
    select: { id: true },
  })
  if (caw) return true

  const user = await prisma.user.findFirst({
    where: { OR: [{ avatarUrl: has }, { coverPhotoUrl: has }] },
    select: { id: true },
  })
  if (user) return true

  const scheduled = await prisma.scheduledCaw.findFirst({
    where: {
      status: { in: ['pending', 'processing'] },
      OR: [{ imageData: has }, { content: has }],
    },
    select: { id: true },
  })
  if (scheduled) return true

  const conversation = await prisma.conversation.findFirst({
    where: { avatarUrl: has },
    select: { id: true },
  })
  if (conversation) return true

  const polls = await prisma.$queryRaw<unknown[]>`
    SELECT 1 FROM "Poll"
    WHERE strpos(array_to_string("optionImages", ' '), ${needle}) > 0
    LIMIT 1`
  return polls.length > 0
}

/**
 * Remove one mark without letting a Redis error end the sweep: the keys after
 * it still get processed, and the mark stays for the next sweep. Returns false
 * when the ZREM failed.
 */
async function dropMark(fullKey: string): Promise<boolean> {
  try {
    await redis.zrem(ZSET_KEY, fullKey)
    return true
  } catch (e: any) {
    console.warn(`[orphanedMedia] could not drop mark ${fullKey}:`, e?.message || e)
    return false
  }
}

/**
 * One-shot sweep: delete every key that's past its delete-at timestamp.
 * Returns counts for telemetry. Designed to be called from a periodic
 * job (DataCleaner) — safe to call concurrently because ZREM is atomic.
 */
export async function sweep(opts: { dryRun?: boolean } = {}): Promise<{ deleted: number; failed: number; skipped: number; kept: number }> {
  let deleted = 0, failed = 0, skipped = 0, kept = 0

  const now = Date.now()
  // Fetch a batch — small batches keep individual sweep cycles bounded.
  const batchSize = 200
  const expired = await redis.zrangebyscore(ZSET_KEY, 0, now, 'LIMIT', 0, batchSize)
  if (expired.length === 0) return { deleted, failed, skipped, kept }

  const storage = mediaStorage()

  for (const fullKey of expired) {
    // The bucket key is stored verbatim. Reverse-engineer kind +
    // filename from the suffix so we can call the typed put/delete API.
    const m = fullKey.match(/(?:^|\/)(images|videos|encrypted)\/([^/]+)$/)
    if (!m) {
      console.warn('[orphanedMedia] could not parse key:', fullKey)
      // Drop the unparseable entry so it doesn't block subsequent sweeps.
      if (!(await dropMark(fullKey))) { failed++; continue }
      skipped++
      continue
    }
    const kind = m[1] as 'images' | 'videos' | 'encrypted'
    const filename = m[2]

    // Still in use elsewhere: drop the mark, keep the file. On a DB error,
    // leave the mark and try again next sweep rather than delete blind.
    let referenced: boolean
    try {
      referenced = await isStillReferenced(kind, filename)
    } catch (e: any) {
      console.warn(`[orphanedMedia] reference check failed for ${fullKey}:`, e?.message || e)
      failed++
      continue
    }
    if (referenced) {
      if (!opts.dryRun && !(await dropMark(fullKey))) { failed++; continue }
      kept++
      continue
    }

    if (opts.dryRun) {
      console.log(`[orphanedMedia] would delete: ${fullKey}`)
      deleted++
      continue
    }

    try {
      await storage.delete(kind, filename)
      await redis.zrem(ZSET_KEY, fullKey)
      deleted++
    } catch (e: any) {
      // Don't ZREM on failure — a transient error means we'll retry on
      // the next sweep. Permanent errors (key never existed) will keep
      // failing, which is visible in logs and tells the operator to
      // intervene.
      console.warn(`[orphanedMedia] delete failed for ${fullKey}:`, e?.message || e)
      failed++
    }
  }

  return { deleted, failed, skipped, kept }
}

/** Read-only inspection helper for ops + tests. */
export async function pendingCount(): Promise<number> {
  return redis.zcard(ZSET_KEY)
}
