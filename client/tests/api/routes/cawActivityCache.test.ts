/**
 * Response caches of /api/users/:tokenId/caw-activity and
 * /api/system/caw-activity-all.
 *
 * The FE builds from/to with new Date().toISOString() on every load
 * (CawActivity.tsx), so a key made from the raw values never repeats: nothing
 * is served from the cache, and on the system route — which had no eviction —
 * every request left an entry behind until the process restarted.
 *
 * cacheWindow and evictExpired are the two pieces the routes use for that, and
 * are tested directly (no DB).
 */

import { describe, it } from 'mocha'
import { expect } from 'chai'
import { cacheWindow, evictExpired } from '../../../src/api/routes/caw-activity'

const TTL_MS = 30_000
const DAY = 86_400_000

/** from/to the way CawActivity.tsx builds them for a 30-day range. */
function feRange(nowMs: number) {
  return { from: new Date(nowMs - 30 * DAY), to: new Date(nowMs) }
}

describe('caw-activity cacheWindow', () => {
  it('gives two FE loads a few ms apart the same window', () => {
    const t = Date.UTC(2026, 9, 30, 12, 0, 5, 123)
    const a = feRange(t)
    const b = feRange(t + 7)
    expect(cacheWindow(a.from, a.to)).to.deep.equal(cacheWindow(b.from, b.to))
  })

  it('only widens the requested range, by less than one step on each side', () => {
    const { from, to } = feRange(Date.UTC(2026, 9, 30, 12, 0, 5, 123))
    const w = cacheWindow(from, to)
    const f = new Date(w.fromIso).getTime()
    const e = new Date(w.toIso).getTime()
    expect(f).to.be.at.most(from.getTime())
    expect(from.getTime() - f).to.be.below(TTL_MS)
    expect(e).to.be.at.least(to.getTime())
    expect(e - to.getTime()).to.be.below(TTL_MS)
  })

  it('leaves values already on a step unchanged', () => {
    const from = new Date(Date.UTC(2026, 9, 1))
    const to = new Date(Date.UTC(2026, 9, 31))
    expect(cacheWindow(from, to)).to.deep.equal({ fromIso: from.toISOString(), toIso: to.toISOString() })
  })

  it('moves to the next window once the step has passed', () => {
    const t = Date.UTC(2026, 9, 30, 12, 0, 5)
    const a = feRange(t)
    const b = feRange(t + TTL_MS)
    expect(cacheWindow(a.from, a.to)).to.not.deep.equal(cacheWindow(b.from, b.to))
  })
})

describe('caw-activity evictExpired', () => {
  it('drops expired entries and keeps fresh and in-flight ones', () => {
    const now = Date.now()
    const cache = new Map<string, { expiresAt: number; body: any; inFlight?: Promise<any> }>([
      ['expired', { expiresAt: now - 1, body: {} }],
      ['fresh', { expiresAt: now + TTL_MS, body: {} }],
      ['inFlight', { expiresAt: 0, body: null, inFlight: new Promise(() => {}) }],
    ])
    evictExpired(cache)
    expect([...cache.keys()]).to.deep.equal(['fresh', 'inFlight'])
  })
})
