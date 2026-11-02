/**
 * Unit tests for the sitemap helpers (no DB, no Express).
 *
 * What matters here is the protocol limits: a child file must stay under
 * 50,000 URLs and 50 MB (uncompressed) even when every id in its range is a
 * listed item with a long slug, and the shard ranges must partition the ids
 * with no gap and no overlap.
 */

import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  MAX_BYTES_PER_FILE,
  MAX_URLS_PER_FILE,
  SHARD_WIDTH,
  escapeXml,
  parseShardNumber,
  renderSitemapIndex,
  renderUrl,
  renderUrlset,
  MAX_SITEMAPS_PER_INDEX,
  buildIndexLocs,
  normalizeShards,
  shardRange,
} from '../../src/api/util/sitemapXml'
import { ALL_LOCALES } from '../../src/api/util/localePrefix'
import { cawPath } from '../../src/api/util/cawUrl'

const BASE = 'https://example.test'

describe('sitemap shard ranges', () => {
  it('normalizeShards sorts, removes duplicates and drops invalid numbers', () => {
    expect(normalizeShards([])).to.deep.equal([])
    expect(normalizeShards([3, 0, 3, 10, 1])).to.deep.equal([0, 1, 3, 10])
    expect(normalizeShards([-1, 1.5, NaN, 2])).to.deep.equal([2])
  })

  it('buildIndexLocs puts the static file first and never exceeds the index limit', () => {
    expect(buildIndexLocs(BASE, [0, 2], [1])).to.deep.equal([
      `${BASE}/sitemap-static.xml`,
      `${BASE}/sitemap-users-0.xml`,
      `${BASE}/sitemap-users-2.xml`,
      `${BASE}/sitemap-caws-1.xml`,
    ])
    const many = Array.from({ length: MAX_SITEMAPS_PER_INDEX + 10 }, (_, i) => i)
    expect(buildIndexLocs(BASE, many, many)).to.have.length(MAX_SITEMAPS_PER_INDEX)
  })

  it('ranges partition the ids: every id falls in exactly one shard', () => {
    const maxId = 3 * SHARD_WIDTH + 17
    const count = Math.floor(maxId / SHARD_WIDTH) + 1
    for (const id of [0, 1, SHARD_WIDTH - 1, SHARD_WIDTH, 2 * SHARD_WIDTH, maxId]) {
      const hits = []
      for (let n = 0; n < count; n++) {
        const r = shardRange(n)
        if (id >= r.gte && id < r.lt) hits.push(n)
      }
      expect(hits, `id ${id}`).to.have.length(1)
    }
    // adjacent ranges touch without overlapping
    for (let n = 0; n < count - 1; n++) {
      expect(shardRange(n).lt).to.equal(shardRange(n + 1).gte)
    }
  })

  it('a hidden or removed row changes only its own shard', () => {
    // Shard membership depends on the id alone, never on the other rows.
    const idsBefore = [10, 520, 530, 1100]
    const idsAfter = idsBefore.filter((id) => id !== 520)
    const members = (ids: number[], n: number) => {
      const r = shardRange(n)
      return ids.filter((id) => id >= r.gte && id < r.lt)
    }
    expect(members(idsAfter, 0)).to.deep.equal(members(idsBefore, 0))
    expect(members(idsAfter, 2)).to.deep.equal(members(idsBefore, 2))
    expect(members(idsAfter, 1)).to.deep.equal([530])
  })

  it('parseShardNumber accepts only plain decimal digits without leading zeros', () => {
    expect(parseShardNumber('0')).to.equal(0)
    expect(parseShardNumber('12')).to.equal(12)
    for (const bad of [undefined, '', '-1', '1.5', '1e3', ' 1', 'a', '01', '00', '1234567890']) {
      expect(parseShardNumber(bad as any), String(bad)).to.equal(null)
    }
  })
})

describe('sitemap size limits', () => {
  it('a full shard stays under both protocol limits', () => {
    // Worst case: every id in the range is a listed caw, each with a long
    // multi-word slug (cawPath caps the slug length).
    const longContent = 'lorem ipsum dolor sitamet consectetur adipiscing elit sed do eiusmod tempor '.repeat(5)
    const entries = []
    for (let i = 0; i < SHARD_WIDTH; i++) {
      entries.push({
        bare: cawPath({ id: 9_999_999 - i, username: 'a_very_long_username_x', content: longContent }),
        lastmod: new Date('2026-11-02T00:00:00Z'),
        changefreq: 'monthly' as const,
        priority: 0.5,
      })
    }
    const xml = renderUrlset(entries, 'https://a-fairly-long-host-name.example.com')
    const urls = (xml.match(/<url>/g) || []).length
    expect(urls).to.equal(SHARD_WIDTH * ALL_LOCALES.length)
    expect(urls).to.be.lessThan(MAX_URLS_PER_FILE)
    expect(Buffer.byteLength(xml, 'utf8')).to.be.lessThan(MAX_BYTES_PER_FILE)
  })

  it('SHARD_WIDTH × locales leaves headroom under the URL limit', () => {
    expect(SHARD_WIDTH * ALL_LOCALES.length).to.be.lessThan(MAX_URLS_PER_FILE)
  })
})

describe('sitemap rendering', () => {
  it('renderUrl emits one <url> per locale, each with every alternate', () => {
    const xml = renderUrl({ bare: '/users/alice', priority: 0.6 }, BASE)
    expect((xml.match(/<url>/g) || []).length).to.equal(ALL_LOCALES.length)
    // each <url> has ALL_LOCALES alternates plus x-default
    expect((xml.match(/xhtml:link/g) || []).length).to.equal(ALL_LOCALES.length * (ALL_LOCALES.length + 1))
    expect(xml).to.contain(`<loc>${BASE}/users/alice</loc>`)
    expect(xml).to.contain(`<loc>${BASE}/es/users/alice</loc>`)
    expect(xml).to.contain('hreflang="x-default"')
  })

  it('renderUrlset is well-formed and escapes special characters', () => {
    const xml = renderUrlset([{ bare: '/a?x=1&y=<2>' }], BASE)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).to.equal(true)
    expect(xml.trim().endsWith('</urlset>')).to.equal(true)
    expect(xml).to.contain('&amp;y=&lt;2&gt;')
    expect(xml).to.not.contain('&y=<2>')
  })

  it('renderUrlset with no entries is a valid empty urlset', () => {
    const xml = renderUrlset([], BASE)
    expect(xml).to.contain('<urlset')
    expect(xml).to.not.contain('<url>')
  })

  it('renderSitemapIndex lists each child once', () => {
    const locs = [`${BASE}/sitemap-static.xml`, `${BASE}/sitemap-caws-0.xml`, `${BASE}/sitemap-caws-1.xml`]
    const xml = renderSitemapIndex(locs)
    expect(xml).to.contain('<sitemapindex')
    expect((xml.match(/<sitemap>/g) || []).length).to.equal(3)
    for (const l of locs) expect(xml).to.contain(`<loc>${l}</loc>`)
  })

  it('escapeXml handles the five predefined entities', () => {
    expect(escapeXml(`&<>"'`)).to.equal('&amp;&lt;&gt;&quot;&apos;')
  })
})
