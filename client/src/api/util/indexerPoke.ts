// api/util/indexerPoke.ts
//
// Fire-and-forget helper: publish a Redis message on `caw:index-token` so
// NftTransferWatcher can immediately run findOrCreateUser() out-of-band for
// a tokenId that isn't in the DB yet. The request handler stays free of any
// chain read; it returns 202 instantly and lets the indexer do the work.
//
// A poke failure must NEVER break the request — Redis errors are swallowed
// and logged at warn level only.
import { redis } from '../../lib/redisClient'
import Redis from 'ioredis'

let _publisher: Redis | null = null

function getPublisher(): Redis {
  if (!_publisher) {
    _publisher = redis
    _publisher.on('error', (err: Error) => {
      console.warn('[indexerPoke] Redis publisher error:', err.message)
    })
  }
  return _publisher
}

/**
 * Publish to `caw:index-token` so NftTransferWatcher can index the tokenId
 * immediately rather than waiting for its next poll cycle.
 *
 * Call synchronously (no await) in request handlers — it is intentionally
 * fire-and-forget. Non-positive / NaN tokenIds are ignored.
 */
export function pokeIndexTokenId(tokenId: number): void {
  if (!tokenId || !Number.isFinite(tokenId) || tokenId <= 0) return
  getPublisher()
    .publish('caw:index-token', String(tokenId))
    .catch((err: Error) => {
      console.warn(`[indexerPoke] publish failed for tokenId=${tokenId}:`, err.message)
    })
}
