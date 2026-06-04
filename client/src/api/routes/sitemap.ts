import { Router, Request, Response } from 'express'
import { prisma } from '../../prismaClient'
import { publicUrl } from '../util/publicUrl'
import { cawPath } from '../util/cawUrl'
import { ALL_LOCALES, withLocalePrefix } from '../util/localePrefix'

const router = Router()

// Sitemap with hreflang alternates. One URL per (item × locale) listed,
// each with <xhtml:link rel="alternate" hreflang="..."> siblings so
// Google routes searchers to the right locale variant.
//
// Sitemap protocol: max 50k URLs, max 50MB uncompressed per file. We
// produce one file today; when total entries exceed a comfortable
// threshold (~20k caws) split into shards via a sitemap index.
//
// Cache aggressively — sitemaps don't need real-time accuracy. 6h
// max-age means Googlebot pulls a fresh copy ~4×/day, which is plenty.

const CACHE_SECONDS = 6 * 60 * 60   // 6h
const SOFT_LIMIT_URLS = 40000        // headroom under 50k

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

interface UrlEntry {
  /** Bare path (no locale prefix). Sitemap emits one <url> per locale
   * variant — Google's hreflang model treats each as its own indexable
   * URL with sibling alternates. */
  bare: string
  lastmod?: Date
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
  priority?: number
}

function renderUrl(entry: UrlEntry): string {
  const base = publicUrl()
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

router.get('/sitemap.xml', async (_req: Request, res: Response) => {
  try {
    const entries: UrlEntry[] = []

    // Static evergreen pages — single entry per locale set. /home is
    // auth-gated but still indexable as a landing.
    entries.push({ bare: '/', changefreq: 'daily', priority: 1.0 })
    entries.push({ bare: '/explore', changefreq: 'daily', priority: 0.8 })
    entries.push({ bare: '/help', changefreq: 'monthly', priority: 0.3 })

    // Profiles. Order by createdAt desc and cap so we don't blow the
    // 50k URL × N-locale ceiling. Each user becomes N URLs (one per
    // locale) so the effective per-user multiplier is ALL_LOCALES.length.
    const perItemCost = ALL_LOCALES.length
    const profileBudget = Math.floor(SOFT_LIMIT_URLS / perItemCost / 2)
    // username is non-null in the current schema — earlier passes filtered
    // null usernames here, but the column was later tightened to NOT NULL.
    // The line-88 `if (!u.username) continue` defensive check still runs.
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: profileBudget,
      select: { username: true, updatedAt: true },
    })
    for (const u of users) {
      if (!u.username) continue
      entries.push({
        bare: `/users/${u.username}`,
        lastmod: u.updatedAt,
        changefreq: 'weekly',
        priority: 0.6,
      })
    }

    // Caws. SUCCESS only — PENDING is ephemeral and FAILED/HIDDEN are
    // private. Same budgeting as profiles. Use cawPath() so the URL
    // includes the canonical slug.
    const cawBudget = Math.max(0, Math.floor(SOFT_LIMIT_URLS / perItemCost) - users.length)
    const caws = await prisma.caw.findMany({
      where: { status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      take: cawBudget,
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

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
      '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      ...entries.map(renderUrl),
      '</urlset>',
    ].join('\n')

    res.set('Content-Type', 'application/xml; charset=utf-8')
    res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`)
    res.send(xml)
  } catch (err) {
    console.error('[sitemap] failed:', err)
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
