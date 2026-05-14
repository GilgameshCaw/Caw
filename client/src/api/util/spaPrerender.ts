import type { Request, Response } from 'express'
import path from 'path'
import fs from 'fs'
import { prisma } from '../../prismaClient'
import { publicUrl } from './publicUrl'
import { cawPath, parseCawIdSlug } from './cawUrl'
import { ALL_LOCALES, parseLocaleFromPath, withLocalePrefix } from './localePrefix'

// Protocol-level canonical origin. Every CAW mirror prerenders the same
// public content (caws, profiles, hashtags) and they're all reachable on
// their own host. Without a stable cross-mirror canonical, search engines
// see each mirror as a separate duplicate copy and split ranking signal.
// Pinning canonical + hreflang alternates to a single origin collapses
// all mirrors onto one indexed entry. og:url / og:image still point at
// the serving mirror so social previews reflect where the link came from.
function canonicalOrigin(): string {
  return 'https://caw.social'
}

// nginx routes only crawler User-Agents through to the API; this handler
// reads the URL, fetches the per-route data, and returns the SPA's
// index.html with og:* / twitter:* meta tags swapped in for the static
// defaults. Real users never hit this — they get the static dist/
// directly from nginx.

// Resolve index.html once, with a dev-mode fallback for `npm run dev`.
const PROD_INDEX = path.join(process.cwd(), 'src', 'services', 'FrontEnd', 'dist', 'index.html')
const DEV_INDEX = path.join(process.cwd(), 'src', 'services', 'FrontEnd', 'index.html')
let cachedTemplate: string | null = null
function readTemplate(): string {
  if (cachedTemplate) return cachedTemplate
  const file = fs.existsSync(PROD_INDEX) ? PROD_INDEX : DEV_INDEX
  cachedTemplate = fs.readFileSync(file, 'utf8')
  return cachedTemplate
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}

type Meta = {
  title: string
  description: string
  url: string
  image: string
  ogType?: 'website' | 'article'
  /** Canonical URL — used for <link rel="canonical">. Defaults to `url`
   * when not set. Set explicitly when the requested URL is a non-canonical
   * variant (legacy /caws/:id, stale username, missing slug) so search
   * engines collapse all variants onto the canonical entry. */
  canonical?: string
  /** Actual PNG dimensions for og:image:width / og:image:height. When
   * unset (HEAD probe failed or timed out) we skip those meta tags
   * entirely — they're optional per ogp.me and a wrong value is worse
   * than no value (Facebook/Messenger validate strictly). */
  imageWidth?: number
  imageHeight?: number
  /** Bare path (no locale prefix) of the same content. When set, we
   * emit one <link rel="alternate" hreflang="..."> per supported locale
   * — tells Google "the same content lives at /es/... /fr/... etc.,
   * route Spanish searchers to the /es/ variant." Omit for pages that
   * don't have meaningful per-locale variants. */
  altPath?: string
}

// HEAD-probe the OG image route to learn the rendered PNG's actual
// dimensions. The image route emits X-Image-Width / X-Image-Height
// headers from the PNG's IHDR chunk. We use them to declare accurate
// og:image:width / og:image:height — Facebook + Messenger validate
// these strictly and will SUPPRESS the preview if they don't match.
//
// Timeout is tight (1500ms) because the SPA shell response can't wait
// long: crawlers move on if the page takes too long to return HTML.
// On miss/timeout we just omit the size tags — better to give scrapers
// no hint than the wrong one.
async function probeImageDims(url: string): Promise<{ w: number; h: number } | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const w = Number(res.headers.get('x-image-width'))
    const h = Number(res.headers.get('x-image-height'))
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
    return { w, h }
  } catch {
    return null
  }
}

function buildMetaTags(m: Meta): string {
  const t = escapeHtml(m.title)
  const d = escapeHtml(m.description)
  const u = escapeHtml(m.url)
  const i = escapeHtml(m.image)
  const c = escapeHtml(m.canonical || m.url)
  const ot = m.ogType || 'website'
  const tags = [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    // Canonical points to the one true URL for this content. For caws
    // this collapses /caws/:id, stale usernames, and stale/missing slugs
    // onto a single indexed URL. NOTE: each locale variant has its OWN
    // canonical (the /es/... is canonical for the Spanish indexing).
    `<link rel="canonical" href="${c}">`,
    `<meta property="og:type" content="${ot}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${c}">`,
    `<meta property="og:image" content="${i}">`,
  ]
  // hreflang alternates: one <link rel="alternate"> per supported
  // locale, plus x-default. Tells Google to route Spanish searchers to
  // /es/..., Japanese searchers to /ja/..., etc. Without these, Google
  // either misses the locale variants or treats them as duplicates and
  // splits ranking.
  if (m.altPath) {
    // hreflang alternates must share an origin with the canonical link or
    // Google flags the page in Search Console as having inconsistent
    // signals. Pin them to canonicalOrigin() to match the canonical above.
    const base = canonicalOrigin()
    for (const loc of ALL_LOCALES) {
      const href = `${base}${withLocalePrefix(m.altPath, loc === 'en' ? null : loc)}`
      const hreflang = loc === 'en' ? 'en' : loc
      tags.push(`<link rel="alternate" hreflang="${hreflang}" href="${escapeHtml(href)}">`)
    }
    // x-default = the fallback shown when no other hreflang matches.
    // Bare English path.
    tags.push(`<link rel="alternate" hreflang="x-default" href="${escapeHtml(`${base}${m.altPath}`)}">`)
  }
  // og:image:width / height are optional but high-signal for strict
  // scrapers (Messenger). Emit only when we have real dims from the
  // PNG; never lie — a mismatched value suppresses the preview.
  if (m.imageWidth && m.imageHeight) {
    tags.push(`<meta property="og:image:width" content="${m.imageWidth}">`)
    tags.push(`<meta property="og:image:height" content="${m.imageHeight}">`)
  }
  tags.push(
    // image:type and image:alt are also recommended by ogp.me. type
    // tells scrapers what content-type to expect (skips a sniff).
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:alt" content="${t}">`,
    `<meta property="og:site_name" content="CAW">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
  )
  return tags.join('\n    ')
}

function injectMeta(html: string, meta: Meta): string {
  // Strip existing <title> and <meta name="description"> from the static
  // template (the build always emits these), then drop the new block in
  // before </head>. Cheap string ops — no DOM parsing needed for a 35-line
  // template that we control end-to-end.
  let out = html
  out = out.replace(/<title>[^<]*<\/title>/i, '')
  out = out.replace(/<meta\s+name="description"[^>]*>/i, '')
  // og:* / twitter:* tags from a previous prerender pass would just stack;
  // we drop them too so re-rendering is idempotent.
  out = out.replace(/\s*<meta\s+(?:property|name)="(?:og:[^"]+|twitter:[^"]+)"[^>]*>/gi, '')
  out = out.replace(/\s*<link\s+rel="canonical"[^>]*>/gi, '')
  out = out.replace(/\s*<link\s+rel="alternate"[^>]*hreflang="[^"]+"[^>]*>/gi, '')
  out = out.replace(/<\/head>/i, `    ${buildMetaTags(meta)}\n  </head>`)
  return out
}

// Title + description used to mirror what's already on the OG image
// (handle, bio, post body, etc.), so on Twitter / Discord / iMessage the
// preview rendered the same info twice — once as text below the card,
// once burned into the image. Collapse all of them to a single brand
// title + empty description so the image carries the per-page detail.
const BRAND_TITLE = 'CAW — Decentralized & Censorship Resistant'

// OG image URL with optional ?locale=<code> so the rendered card chrome
// (Followers / Following / Posts / Likes labels, hashtag "N caws on
// CAW" line) matches the locale variant the social share lands in.
// Card body / username / post text stays in source language; only the
// chrome translates.
function localizedOgImage(path: string, locale: string | null): string {
  const base = `${publicUrl()}${path}`
  if (!locale) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}locale=${encodeURIComponent(locale)}`
}

async function profileMeta(username: string, locale: string | null): Promise<Meta | null> {
  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: { username: true },
  })
  if (!user) return null
  const altPath = `/users/${user.username}`
  const canonicalPath = withLocalePrefix(altPath, locale)
  return {
    title: BRAND_TITLE,
    description: '',
    url: `${publicUrl()}${canonicalPath}`,
    canonical: `${canonicalOrigin()}${canonicalPath}`,
    image: localizedOgImage(`/api/og/image/profile/${user.username}`, locale),
    ogType: 'website',
    altPath,
  }
}

async function hashtagMeta(tag: string, locale: string | null): Promise<Meta | null> {
  const name = tag.toLowerCase().replace(/^#/, '')
  if (!name) return null
  const altPath = `/hashtags/${encodeURIComponent(name)}`
  const canonicalPath = withLocalePrefix(altPath, locale)
  return {
    title: BRAND_TITLE,
    description: '',
    url: `${publicUrl()}${canonicalPath}`,
    canonical: `${canonicalOrigin()}${canonicalPath}`,
    image: localizedOgImage(`/api/og/image/hashtag/${encodeURIComponent(name)}`, locale),
    ogType: 'website',
    altPath,
  }
}

async function cawMeta(id: number, requestedPath: string, locale: string | null): Promise<Meta | null> {
  if (!Number.isFinite(id) || id <= 0) return null
  const caw = await prisma.caw.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      content: true,
      user: { select: { username: true } },
    },
  })
  // PENDING is publicly visible (the FE shows pending posts in author
  // feeds and the share button surfaces them right after submit), so
  // OG crawlers must see them too. FAILED / HIDDEN stay private.
  if (!caw || (caw.status !== 'SUCCESS' && caw.status !== 'PENDING')) return null
  const bareCanonical = cawPath({
    id: caw.id,
    username: caw.user?.username ?? null,
    content: caw.content,
  })
  // Each locale has its own canonical entry. Spanish-locale URL canonicals
  // to itself (so /es/users/maria/caw/123-slug is the canonical for the
  // Spanish index), and the alternates list all locale siblings.
  const canonicalPath = withLocalePrefix(bareCanonical, locale)
  return {
    title: BRAND_TITLE,
    description: '',
    // og:url renders the canonical so social previews always link to the
    // canonical form even when shared from a stale URL.
    url: `${publicUrl()}${requestedPath}`,
    canonical: `${canonicalOrigin()}${canonicalPath}`,
    image: `${publicUrl()}/api/og/image/caw/${caw.id}`,
    ogType: 'article',
    altPath: bareCanonical,
  }
}

function defaultMeta(reqPath: string, restPath: string, locale: string | null): Meta {
  const meta: Meta = {
    title: BRAND_TITLE,
    description: '',
    url: `${publicUrl()}${reqPath}`,
    image: `${publicUrl()}/api/og/image/default`,
    ogType: 'website',
  }
  // Home feed is the only unmatched route we cross-mirror canonicalize.
  // /address/<addr> and other catch-alls intentionally fall through with
  // no canonical (they're per-mirror or unindexable). restPath strips
  // the locale prefix, so "/", "/es", "/ja/" all collapse to "/" here.
  if (restPath === '/' || restPath === '') {
    const canonicalPath = withLocalePrefix('/', locale)
    meta.canonical = `${canonicalOrigin()}${canonicalPath}`
    meta.altPath = '/'
  }
  return meta
}

// Path → static-card slug. Keep in sync with STATIC_PAGE_TITLES in
// client/src/api/routes/og.ts. Each entry matches an exact bare path
// (the locale prefix has already been stripped by parseLocaleFromPath
// before we look up here). Paths with sub-routes that should share one
// card (e.g. /staking, /staking/activity, /staking/unstake) live in the
// STATIC_PAGE_PREFIXES table below.
const STATIC_PAGE_PATHS: Record<string, string> = {
  '/help': 'help',
  '/help/faq': 'help-faq',
  '/help/history': 'help-history',
  '/help/manifesto': 'help-manifesto',
  '/help/gettingstarted': 'help-gettingstarted',
  '/help/howto': 'help-gettingstarted',
  '/help/developers': 'help-developers',
  '/help/resources': 'help-resources',
  '/usernames': 'usernames',
  '/explore': 'explore',
  '/settings': 'settings',
  '/settings/account': 'settings-account',
  '/settings/notifications': 'settings-notifications',
  '/settings/language': 'settings-language',
  '/settings/muted': 'settings-muted',
  '/settings/session-keys': 'settings-session-keys',
  '/notifications': 'notifications',
  '/bookmarks': 'bookmarks',
  '/scheduled': 'scheduled',
  '/faucet': 'faucet',
  '/welcome': 'welcome',
}

// Path prefix → static-card slug. Used when a whole sub-tree should
// resolve to the same card (e.g. /staking/* → "CAW Staking",
// /messages/* → "Messages"). Longest prefix wins on overlap; ordering
// here is insertion order, and Object.entries preserves it, so list the
// more specific prefixes first if you ever add overlapping entries.
const STATIC_PAGE_PREFIXES: Array<[string, string]> = [
  ['/staking/', 'staking'],
  ['/messages/', 'messages'],
  ['/search/', 'search'],
]

function staticPageMeta(restPath: string, reqPath: string, locale: string | null): Meta | null {
  // Strip a single trailing slash so "/help" and "/help/" both match. We
  // don't normalize multi-slash because the matched URL is what we want
  // canonical'd to itself for now.
  const trimmed = restPath.length > 1 && restPath.endsWith('/')
    ? restPath.slice(0, -1)
    : restPath
  let slug = STATIC_PAGE_PATHS[trimmed]
  if (!slug) {
    // Also match the literal path of a prefix base (e.g. "/staking"
    // itself maps to the staking card, not just "/staking/activity").
    for (const [prefix, s] of STATIC_PAGE_PREFIXES) {
      const base = prefix.slice(0, -1) // "/staking/" → "/staking"
      if (trimmed === base || trimmed.startsWith(prefix)) {
        slug = s
        break
      }
    }
  }
  if (!slug) return null
  const altPath = trimmed
  const canonicalPath = withLocalePrefix(altPath, locale)
  return {
    title: BRAND_TITLE,
    description: '',
    url: `${publicUrl()}${reqPath}`,
    canonical: `${canonicalOrigin()}${canonicalPath}`,
    image: `${publicUrl()}/api/og/image/static/${slug}`,
    ogType: 'website',
    altPath,
  }
}

// Paths the catch-all should NOT swallow even though they aren't /api/*.
// /uploads/* is a static handler that calls next() on misses; we don't want
// to serve an HTML SPA shell for a missing image. /s/* is the short-URL
// redirector. /socket.io/* is upgraded by the WS layer.
const SKIP_PREFIXES = ['/uploads/', '/s/', '/socket.io/']

export async function spaPrerender(req: Request, res: Response): Promise<void> {
  try {
    const reqPath = req.path
    if (SKIP_PREFIXES.some(p => reqPath.startsWith(p))) {
      res.status(404).end()
      return
    }
    // Parse the optional locale prefix once. Routes match on the bare
    // path; canonical and og:url get the locale prefix re-applied.
    const { locale, restPath } = parseLocaleFromPath(reqPath)
    let meta: Meta | null = null

    let m = restPath.match(/^\/users\/([^/]+)\/?$/)
    if (m) meta = await profileMeta(decodeURIComponent(m[1]), locale)

    if (!meta) {
      // Canonical caw URL: /users/<username>/caw/<id>-<slug>. The slug
      // suffix is decorative — the leading numeric id is what looks up
      // the caw. canonical-redirect logic in the FE snaps stale URLs.
      m = restPath.match(/^\/users\/([^/]+)\/caw\/([^/]+)\/?$/)
      if (m) {
        const id = parseCawIdSlug(m[2])
        if (id != null) meta = await cawMeta(id, reqPath, locale)
      }
    }

    if (!meta) {
      // Legacy /caws/:id share-link target. Same content, different
      // surface URL — meta.canonical points to the new shape so
      // crawlers index only the canonical form.
      m = restPath.match(/^\/caws\/(\d+)\/?$/)
      if (m) meta = await cawMeta(Number(m[1]), reqPath, locale)
    }

    if (!meta) {
      m = restPath.match(/^\/hashtags\/([^/]+)\/?$/)
      if (m) meta = await hashtagMeta(decodeURIComponent(m[1]), locale)
    }

    // Static-page cards (help/staking/settings/etc.). Cheap synchronous
    // table lookup — no DB hit. Runs after the entity matchers so a real
    // /users/<staking-username-collision> would never get clobbered.
    if (!meta) meta = staticPageMeta(restPath, reqPath, locale)

    // /address/:address and everything else falls back to the default card.
    if (!meta) meta = defaultMeta(reqPath, restPath, locale)

    // Probe the image's actual rendered dimensions so og:image:width /
    // og:image:height match reality. Strict scrapers (Messenger) treat
    // a wrong size as a reason to suppress the preview. Best-effort —
    // a HEAD-probe miss just means we omit those two meta tags.
    const dims = await probeImageDims(meta.image)
    if (dims) {
      meta.imageWidth = dims.w
      meta.imageHeight = dims.h
    }

    const html = injectMeta(readTemplate(), meta)
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=300')
    res.send(html)
  } catch (err) {
    console.error('[spaPrerender] failed:', err)
    // Last-ditch: send the static template unmodified rather than 500ing
    // a crawler (which might mark the URL as broken).
    try {
      res.set('Content-Type', 'text/html; charset=utf-8')
      res.send(readTemplate())
    } catch {
      res.status(500).end()
    }
  }
}
