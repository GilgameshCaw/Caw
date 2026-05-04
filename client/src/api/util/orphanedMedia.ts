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
 */
export function urlToBucketKey(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  // Default-avatar PNGs ship with the FE bundle; never delete those.
  if (url.includes('/images/avatars/')) return null
  // We only own /uploads/<images|videos|encrypted>/<filename> paths.
  const match = url.match(/\/uploads\/(images|videos|encrypted)\/([^?#]+)$/)
  if (!match) return null
  const kind = match[1] as 'images' | 'videos' | 'encrypted'
  const filename = match[2]
  // Per-install bucket prefix. Mirror what FilebaseMediaStorage does in
  // mediaStorage.ts so the key here matches the key the upload wrote.
  // SHORTURL_DOMAIN is set in client/.env at install time.
  const prefix = (process.env.FILEBASE_KEY_PREFIX || hostnameOf(process.env.SHORTURL_DOMAIN) || '').replace(/^\/+|\/+$/g, '')
  return prefix ? `${prefix}/${kind}/${filename}` : `${kind}/${filename}`
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
 * services/FrontEnd/src/utils/imageVariants.ts: `<stem>_<width>.webp`.
 * If that helper changes the convention, this enumeration goes stale
 * and the variants leak. We enqueue at mark-time (not enumerate at
 * sweep-time) to avoid a Filebase ListObjects call per sweep, which
 * costs both bandwidth and request budget.
 *
 * Widths covered: 64 (legacy avatar thumb), 96 (current avatar thumb),
 * 2048 (feed lightbox). Marking a URL that has no variant is harmless —
 * the sweep tries to delete and continues on 404.
 */
const VARIANT_WIDTHS = [64, 96, 2048]

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
  if (/_\d+$/.test(stem)) return // already a variant URL — don't re-derive
  for (const w of VARIANT_WIDTHS) {
    await markOrphan(`${stem}_${w}.webp`)
  }
}

/**
 * Mark every URL referenced inside a Caw.imageData blob. The blob is
 * pipe-separated and prefixed with `urls:` per the cawUtils convention
 * (see "imageData: imageUrls.length > 0 ? `urls:${imageUrls.join('|||')}`"
 * in actionHandlers.ts).
 */
export async function markOrphansInImageData(imageData: string | null | undefined): Promise<void> {
  if (!imageData || typeof imageData !== 'string') return
  if (!imageData.startsWith('urls:')) return
  const urls = imageData.slice(5).split('|||')
  for (const u of urls) {
    await markOrphan(u)
  }
}

/**
 * One-shot sweep: delete every key that's past its delete-at timestamp.
 * Returns counts for telemetry. Designed to be called from a periodic
 * job (DataCleaner) — safe to call concurrently because ZREM is atomic.
 */
export async function sweep(opts: { dryRun?: boolean } = {}): Promise<{ deleted: number; failed: number; skipped: number }> {
  let deleted = 0, failed = 0, skipped = 0

  const now = Date.now()
  // Fetch a batch — small batches keep individual sweep cycles bounded.
  const batchSize = 200
  const expired = await redis.zrangebyscore(ZSET_KEY, 0, now, 'LIMIT', 0, batchSize)
  if (expired.length === 0) return { deleted, failed, skipped }

  // Lazy-load the storage backend. orphanedMedia.ts must NOT import
  // mediaStorage at module load — circular if ever invoked from upload
  // path, and we want this file usable from background jobs that don't
  // need the full multer pipeline.
  const { mediaStorage } = await import('./mediaStorage')
  const storage = mediaStorage() as any
  if (typeof storage.delete !== 'function') {
    // LocalMediaStorage doesn't expose delete (yet). Skip silently —
    // local-disk orphans are an OS-level concern, not a Filebase one.
    return { deleted, failed, skipped: expired.length }
  }

  for (const fullKey of expired) {
    // The bucket key is stored verbatim. Reverse-engineer kind +
    // filename from the suffix so we can call the typed put/delete API.
    const m = fullKey.match(/(?:^|\/)(images|videos|encrypted)\/([^/]+)$/)
    if (!m) {
      console.warn('[orphanedMedia] could not parse key:', fullKey)
      // Drop the unparseable entry so it doesn't block subsequent sweeps.
      await redis.zrem(ZSET_KEY, fullKey)
      skipped++
      continue
    }
    const kind = m[1] as 'images' | 'videos' | 'encrypted'
    const filename = m[2]

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

  return { deleted, failed, skipped }
}

/** Read-only inspection helper for ops + tests. */
export async function pendingCount(): Promise<number> {
  return redis.zcard(ZSET_KEY)
}

function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null
  try { return new URL(url).hostname } catch { return null }
}
