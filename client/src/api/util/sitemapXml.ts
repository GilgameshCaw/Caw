import { ALL_LOCALES, withLocalePrefix } from './localePrefix'

// Pure helpers for the sitemap routes (no DB, no Express), so the size and
// URL-count limits can be unit-tested.

export interface UrlEntry {
  /** Bare path (no locale prefix). One <url> is emitted per locale
   * variant — Google's hreflang model treats each as its own indexable
   * URL with sibling alternates. */
  bare: string
  lastmod?: Date
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
  priority?: number
}

/** Sitemap protocol limits per file (sitemaps.org): 50,000 URLs and 50 MB
 * (52,428,800 bytes) uncompressed. Compression does not change them. */
export const MAX_URLS_PER_FILE = 50_000
export const MAX_BYTES_PER_FILE = 52_428_800

/** Width of the id range covered by one child sitemap. A range of W ids holds
 * at most W items, and each item becomes ALL_LOCALES.length <url> entries,
 * every one carrying ALL_LOCALES.length + 1 hreflang alternates that repeat
 * the origin. A typical item is about 62 KB, but the worst case (10-digit id,
 * 50-character slug, 24-character username, with lastmod/changefreq/priority)
 * is about 211 KB for a 240-character origin, so the byte limit, not the URL
 * limit, decides the width:
 *   W = 250 reaches 52.8 MB with a 240-character origin (limit 52.4 MB);
 *   W = 200 reaches 44.4 MB with the longest possible origin (261 characters:
 *   a 253-character host plus "https://").
 * Ids have gaps (rows that are not SUCCESS, or were removed), so most ranges
 * hold far fewer items than W. */
export const SHARD_WIDTH = 200

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function renderUrl(entry: UrlEntry, base: string): string {
  const out: string[] = []
  for (const loc of ALL_LOCALES) {
    const localeForPrefix = loc === 'en' ? null : loc
    const href = `${base}${withLocalePrefix(entry.bare, localeForPrefix)}`
    out.push('  <url>')
    out.push(`    <loc>${escapeXml(href)}</loc>`)
    if (entry.lastmod) out.push(`    <lastmod>${entry.lastmod.toISOString()}</lastmod>`)
    if (entry.changefreq) out.push(`    <changefreq>${entry.changefreq}</changefreq>`)
    if (entry.priority != null) out.push(`    <priority>${entry.priority.toFixed(1)}</priority>`)
    // hreflang alternates — one per supported locale + x-default.
    for (const altLoc of ALL_LOCALES) {
      const altPrefix = altLoc === 'en' ? null : altLoc
      const altHref = `${base}${withLocalePrefix(entry.bare, altPrefix)}`
      const hreflang = altLoc === 'en' ? 'en' : altLoc
      out.push(`    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${escapeXml(altHref)}"/>`)
    }
    out.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(`${base}${entry.bare}`)}"/>`)
    out.push('  </url>')
  }
  return out.join('\n')
}

export function renderUrlset(entries: UrlEntry[], base: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries.map((e) => renderUrl(e, base)),
    '</urlset>',
  ].join('\n')
}

export function renderSitemapIndex(locs: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locs.map((l) => `  <sitemap>\n    <loc>${escapeXml(l)}</loc>\n  </sitemap>`),
    '</sitemapindex>',
  ].join('\n')
}

/** Half-open id range [gte, lt) covered by shard n. */
export function shardRange(n: number, width: number = SHARD_WIDTH): { gte: number; lt: number } {
  return { gte: n * width, lt: (n + 1) * width }
}

/** Cleans the shard numbers the database returned for non-empty ranges
 * (`id / width` of rows that are listed): drops anything that is not a
 * non-negative integer, removes duplicates, sorts ascending. Empty ranges
 * never appear because only ranges that hold a row are returned. */
export function normalizeShards(ns: Iterable<number>): number[] {
  const set = new Set<number>()
  for (const n of ns) if (Number.isInteger(n) && n >= 0) set.add(n)
  return [...set].sort((x, y) => x - y)
}

/** A sitemap index may list at most this many child sitemaps. */
export const MAX_SITEMAPS_PER_INDEX = 50_000

/** Child sitemap URLs for the index, in a stable order. Never more than the
 * protocol allows (the remainder is dropped from the end, i.e. the highest ids
 * of the last kind). */
export function buildIndexLocs(base: string, userShards: number[], cawShards: number[]): string[] {
  const locs = [
    `${base}/sitemap-static.xml`,
    ...userShards.map((n) => `${base}/sitemap-users-${n}.xml`),
    ...cawShards.map((n) => `${base}/sitemap-caws-${n}.xml`),
  ]
  return locs.slice(0, MAX_SITEMAPS_PER_INDEX)
}

/** Parses the shard number from a URL segment. Plain decimal digits without
 * leading zeros, so each shard has exactly one URL. */
export function parseShardNumber(raw: string | undefined): number | null {
  if (!raw || !/^(0|[1-9]\d{0,8})$/.test(raw)) return null
  return Number(raw)
}
