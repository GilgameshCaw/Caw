import { Router, Request, Response } from 'express'
import { prisma } from '../../prismaClient'
import { publicUrl } from '../util/publicUrl'
import { cawPath } from '../util/cawUrl'
import {
  type UrlEntry,
  SHARD_WIDTH,
  buildIndexLocs,
  normalizeShards,
  parseShardNumber,
  renderSitemapIndex,
  renderUrlset,
  shardRange,
} from '../util/sitemapXml'

const router = Router()

// Sitemap with hreflang alternates. One URL per (item × locale) listed,
// each with <xhtml:link rel="alternate" hreflang="..."> siblings so
// Google routes searchers to the right locale variant.
//
// Sitemap protocol: max 50k URLs, max 50MB uncompressed per file. Every item
// becomes ALL_LOCALES.length <url> entries (about 2.8 KB each, more with a long
// origin or slug), so a single file would reach 50 MB at roughly 850 items. /sitemap.xml is therefore a
// sitemap index that points at child files:
//
//   /sitemap-static.xml        evergreen pages
//   /sitemap-users-<n>.xml     profiles with id in [n*W, (n+1)*W)
//   /sitemap-caws-<n>.xml      SUCCESS caws with id in [n*W, (n+1)*W)
//
// Children are cut by id range, not by count or recency: a row that is later
// hidden or removed only changes its own range, and every other child file
// keeps exactly the same content. W is SHARD_WIDTH (see util/sitemapXml.ts).
//
// Cache aggressively — sitemaps don't need real-time accuracy. 6h
// max-age means Googlebot pulls a fresh copy ~4×/day, which is plenty.

const CACHE_SECONDS = 6 * 60 * 60   // 6h

function sendXml(res: Response, xml: string): void {
  res.set('Content-Type', 'application/xml; charset=utf-8')
  res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`)
  res.send(xml)
}

// Shard numbers that hold at least one listed row, per kind. Users are all
// listed; caws only when SUCCESS (PENDING is ephemeral, FAILED/HIDDEN are
// private). Ids have gaps, so a range can be empty and must not be listed.
async function listedShards(): Promise<{ users: number[]; caws: number[] }> {
  const [u, c] = await Promise.all([
    prisma.$queryRaw<{ n: number }[]>`SELECT DISTINCT (id / ${SHARD_WIDTH}::int) AS n FROM "User"`,
    prisma.$queryRaw<{ n: number }[]>`SELECT DISTINCT (id / ${SHARD_WIDTH}::int) AS n FROM "Caw" WHERE status = 'SUCCESS'`,
  ])
  return {
    users: normalizeShards(u.map((r) => Number(r.n))),
    caws: normalizeShards(c.map((r) => Number(r.n))),
  }
}

router.get('/sitemap.xml', async (_req: Request, res: Response) => {
  try {
    const { users, caws } = await listedShards()
    sendXml(res, renderSitemapIndex(buildIndexLocs(publicUrl(), users, caws)))
  } catch (err) {
    console.error('[sitemap] index failed:', err)
    res.status(500).end()
  }
})

router.get('/sitemap-static.xml', (_req: Request, res: Response) => {
  // /home is auth-gated but still indexable as a landing.
  const entries: UrlEntry[] = [
    { bare: '/', changefreq: 'daily', priority: 1.0 },
    { bare: '/explore', changefreq: 'daily', priority: 0.8 },
    { bare: '/help', changefreq: 'monthly', priority: 0.3 },
  ]
  sendXml(res, renderUrlset(entries, publicUrl()))
})

router.get(/^\/sitemap-(users|caws)-([^/]+)\.xml$/, async (req: Request, res: Response) => {
  try {
    const kind = (req.params as any)[0] as 'users' | 'caws'
    const n = parseShardNumber((req.params as any)[1])
    if (n == null) { res.status(404).end(); return }

    const range = shardRange(n)
    const entries: UrlEntry[] = []

    if (kind === 'users') {
      const users = await prisma.user.findMany({
        where: { id: { gte: range.gte, lt: range.lt } },
        orderBy: { id: 'asc' },
        select: { username: true, updatedAt: true },
      })
      for (const u of users) {
        // username is non-null in the current schema; the check is defensive.
        if (!u.username) continue
        entries.push({
          bare: `/users/${u.username}`,
          lastmod: u.updatedAt,
          changefreq: 'weekly',
          priority: 0.6,
        })
      }
    } else {
      // Use cawPath() so the URL includes the canonical slug.
      const caws = await prisma.caw.findMany({
        where: { status: 'SUCCESS', id: { gte: range.gte, lt: range.lt } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          content: true,
          createdAt: true,
          user: { select: { username: true } },
        },
      })
      for (const c of caws) {
        if (!c.user?.username) continue
        entries.push({
          bare: cawPath({ id: c.id, username: c.user.username, content: c.content }),
          lastmod: c.createdAt,
          changefreq: 'monthly',
          priority: 0.5,
        })
      }
    }

    // An empty range is not listed in the index; a direct request gets 404
    // rather than an empty (invalid) urlset.
    if (entries.length === 0) { res.status(404).end(); return }
    sendXml(res, renderUrlset(entries, publicUrl()))
  } catch (err) {
    console.error('[sitemap] child failed:', err)
    res.status(500).end()
  }
})

router.get('/robots.txt', (_req: Request, res: Response) => {
  const lines = [
    'User-agent: *',
    'Allow: /',
    // Block search-engine-useless surfaces. /admin and /moderation are
    // auth-gated; explicit Disallow saves Googlebot crawl budget.
    'Disallow: /admin/',
    'Disallow: /moderation/',
    'Disallow: /api/',
    '',
    `Sitemap: ${publicUrl()}/sitemap.xml`,
  ]
  res.set('Content-Type', 'text/plain; charset=utf-8')
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(lines.join('\n'))
})

export default router
