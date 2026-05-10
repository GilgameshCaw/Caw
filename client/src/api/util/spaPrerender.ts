import type { Request, Response } from 'express'
import path from 'path'
import fs from 'fs'
import { prisma } from '../../prismaClient'
import { publicUrl } from './publicUrl'

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
}

function buildMetaTags(m: Meta): string {
  const t = escapeHtml(m.title)
  const d = escapeHtml(m.description)
  const u = escapeHtml(m.url)
  const i = escapeHtml(m.image)
  const ot = m.ogType || 'website'
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<meta property="og:type" content="${ot}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${u}">`,
    `<meta property="og:image" content="${i}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:site_name" content="CAW">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
  ].join('\n    ')
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
  out = out.replace(/<\/head>/i, `    ${buildMetaTags(meta)}\n  </head>`)
  return out
}

// Title + description used to mirror what's already on the OG image
// (handle, bio, post body, etc.), so on Twitter / Discord / iMessage the
// preview rendered the same info twice — once as text below the card,
// once burned into the image. Collapse all of them to a single brand
// title + empty description so the image carries the per-page detail.
const BRAND_TITLE = 'CAW — Decentralized & Censorship Resistant'

async function profileMeta(username: string): Promise<Meta | null> {
  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: { username: true },
  })
  if (!user) return null
  return {
    title: BRAND_TITLE,
    description: '',
    url: `${publicUrl()}/users/${user.username}`,
    image: `${publicUrl()}/api/og/image/profile/${user.username}`,
    ogType: 'website',
  }
}

async function hashtagMeta(tag: string): Promise<Meta | null> {
  const name = tag.toLowerCase().replace(/^#/, '')
  if (!name) return null
  return {
    title: BRAND_TITLE,
    description: '',
    url: `${publicUrl()}/hashtags/${encodeURIComponent(name)}`,
    image: `${publicUrl()}/api/og/image/hashtag/${encodeURIComponent(name)}`,
    ogType: 'website',
  }
}

async function cawMeta(idStr: string): Promise<Meta | null> {
  const id = Number(idStr)
  if (!Number.isFinite(id) || id <= 0) return null
  const caw = await prisma.caw.findUnique({
    where: { id },
    select: { id: true, status: true },
  })
  // PENDING is publicly visible (the FE shows pending posts in author
  // feeds and the share button surfaces them right after submit), so
  // OG crawlers must see them too. The /api/og/image/caw/:id route
  // already renders PENDING — this gate was the missing piece, which
  // caused fresh caws to fall through to the default share image
  // until the indexer flipped them to SUCCESS minutes later.
  // FAILED / HIDDEN stay private (return null → default meta).
  if (!caw || (caw.status !== 'SUCCESS' && caw.status !== 'PENDING')) return null
  return {
    title: BRAND_TITLE,
    description: '',
    url: `${publicUrl()}/caws/${caw.id}`,
    image: `${publicUrl()}/api/og/image/caw/${caw.id}`,
    ogType: 'article',
  }
}

function defaultMeta(reqPath: string): Meta {
  return {
    title: BRAND_TITLE,
    description: '',
    url: `${publicUrl()}${reqPath}`,
    image: `${publicUrl()}/api/og/image/default`,
    ogType: 'website',
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
    let meta: Meta | null = null

    let m = reqPath.match(/^\/users\/([^/]+)\/?$/)
    if (m) meta = await profileMeta(decodeURIComponent(m[1]))

    if (!meta) {
      m = reqPath.match(/^\/caws\/(\d+)\/?$/)
      if (m) meta = await cawMeta(m[1])
    }

    if (!meta) {
      m = reqPath.match(/^\/hashtags\/([^/]+)\/?$/)
      if (m) meta = await hashtagMeta(decodeURIComponent(m[1]))
    }

    // /address/:address and everything else falls back to the default card.
    if (!meta) meta = defaultMeta(reqPath)

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
