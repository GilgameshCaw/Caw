import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { prisma } from '../../prismaClient'
import { publicUrl } from '../util/publicUrl'

const router = Router()

// Disk cache for rendered PNGs. Lives under public/uploads (already
// gitignored + served by the API's static handler) but we resolve from
// the running CWD so dev and pm2 both find the same dir.
const CACHE_DIR = path.join(process.cwd(), 'public', 'uploads', 'og-cache')
fs.mkdirSync(CACHE_DIR, { recursive: true })

// Fonts loaded once at module init. Satori requires the bytes; loading
// per-request would burn ~10ms on every miss.
const FONTS_DIR = path.join(process.cwd(), 'public', 'fonts')
let fontRegular: Buffer | null = null
let fontBold: Buffer | null = null
function loadFonts() {
  if (!fontRegular) fontRegular = fs.readFileSync(path.join(FONTS_DIR, 'Inter-Regular.ttf'))
  if (!fontBold) fontBold = fs.readFileSync(path.join(FONTS_DIR, 'Inter-Bold.ttf'))
  return [
    { name: 'Inter', data: fontRegular, weight: 400 as const, style: 'normal' as const },
    { name: 'Inter', data: fontBold, weight: 700 as const, style: 'normal' as const },
  ]
}

const W = 1200
const H = 630

// Resolve a user's avatar to an absolute URL satori can fetch.
// Mirrors client/src/services/FrontEnd/src/utils/defaultAvatar.ts.
function resolveAvatarUrl(user: {
  avatarUrl?: string | null
  defaultAvatarId?: number | null
  tokenId?: number
}): string {
  if (user.avatarUrl) {
    if (/^https?:\/\//.test(user.avatarUrl)) return user.avatarUrl
    return `${publicUrl()}${user.avatarUrl.startsWith('/') ? '' : '/'}${user.avatarUrl}`
  }
  const id = user.defaultAvatarId
    || (user.tokenId ? (user.tokenId % 100) + 1 : 1)
  const clamped = Math.max(1, Math.min(100, id))
  return `${publicUrl()}/images/avatars/${clamped}.png`
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}

// Build a profile card (1200x630) — large avatar left, name + handle + bio right.
function profileCardTree(opts: {
  displayName: string
  username: string
  bio: string
  avatarUrl: string
}) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        height: '100%',
        backgroundColor: '#0A0A0A',
        padding: '64px',
        color: '#ffffff',
        fontFamily: 'Inter',
      },
      children: [
        {
          type: 'img',
          props: {
            src: opts.avatarUrl,
            width: 360,
            height: 360,
            style: { borderRadius: '180px', marginRight: '64px' },
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flex: 1 },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: 72, fontWeight: 700, lineHeight: 1.1 },
                  children: opts.displayName || `@${opts.username}`,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 36, color: '#9ca3af', marginTop: 8 },
                  children: `@${opts.username}`,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 32, color: '#d1d5db', marginTop: 32, lineHeight: 1.35 },
                  children: opts.bio,
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 24,
                    color: '#6b7280',
                    marginTop: 'auto',
                    paddingTop: 32,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                  },
                  children: 'CAW',
                },
              },
            ],
          },
        },
      ],
    },
  }
}

// Build a single-caw card — small avatar + handle on top, post text dominates.
function cawCardTree(opts: {
  displayName: string
  username: string
  text: string
  avatarUrl: string
}) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#0A0A0A',
        padding: '64px',
        color: '#ffffff',
        fontFamily: 'Inter',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'row', alignItems: 'center' },
            children: [
              {
                type: 'img',
                props: {
                  src: opts.avatarUrl,
                  width: 96,
                  height: 96,
                  style: { borderRadius: '48px', marginRight: '24px' },
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 36, fontWeight: 700, lineHeight: 1.1 },
                        children: opts.displayName || `@${opts.username}`,
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 28, color: '#9ca3af', marginTop: 4 },
                        children: `@${opts.username}`,
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: 48,
              lineHeight: 1.3,
              marginTop: 48,
              flex: 1,
              color: '#f3f4f6',
            },
            children: opts.text,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: 24,
              color: '#6b7280',
              fontWeight: 700,
              letterSpacing: '0.1em',
              marginTop: 16,
            },
            children: 'CAW',
          },
        },
      ],
    },
  }
}

// Hashtag card — large #tag, with usage count below.
function hashtagCardTree(opts: { tag: string; usageCount: number }) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        backgroundColor: '#0A0A0A',
        color: '#ffffff',
        fontFamily: 'Inter',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: 140, fontWeight: 700, lineHeight: 1 },
                  children: `#${opts.tag}`,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 36, color: '#9ca3af', marginTop: 24 },
                  children: opts.usageCount > 0
                    ? `${opts.usageCount.toLocaleString()} ${opts.usageCount === 1 ? 'caw' : 'caws'} on CAW`
                    : 'on CAW',
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 24,
                    color: '#6b7280',
                    marginTop: 64,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                  },
                  children: 'CAW',
                },
              },
            ],
          },
        },
      ],
    },
  }
}

// Default card — just a CAW logo / wordmark, used for unknown routes.
function defaultCardTree() {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        backgroundColor: '#0A0A0A',
        color: '#ffffff',
        fontFamily: 'Inter',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: 200, fontWeight: 700, letterSpacing: '0.1em' },
                  children: 'CAW',
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 36, color: '#9ca3af', marginTop: 16 },
                  children: 'Decentralized Social Clearing House',
                },
              },
            ],
          },
        },
      ],
    },
  }
}

async function renderToPng(tree: any): Promise<Buffer> {
  const fonts = loadFonts()
  const svg = await satori(tree as any, { width: W, height: H, fonts })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng()
  return png
}

async function serveCachedOrRender(
  res: any,
  cacheKey: string,
  build: () => Promise<Buffer>,
) {
  const file = path.join(CACHE_DIR, `${cacheKey}.png`)
  try {
    if (fs.existsSync(file)) {
      res.set('Content-Type', 'image/png')
      res.set('Cache-Control', 'public, max-age=86400')
      return res.sendFile(file)
    }
    const png = await build()
    fs.writeFileSync(file, png)
    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(png)
  } catch (err) {
    console.error(`[og] render failed for ${cacheKey}:`, err)
    return res.status(500).end()
  }
}

router.get('/image/profile/:username', async (req, res) => {
  const username = String(req.params.username).toLowerCase()
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      tokenId: true, username: true, displayName: true, bio: true,
      avatarUrl: true, defaultAvatarId: true,
    },
  })
  if (!user) return res.redirect(302, '/api/og/image/default')

  // Cache key includes a hash of the inputs so name/bio/avatar edits invalidate.
  const inputHash = crypto.createHash('sha1')
    .update([user.displayName, user.bio, user.avatarUrl, user.defaultAvatarId].join('|'))
    .digest('hex').slice(0, 8)
  const cacheKey = `profile-${user.tokenId}-${inputHash}`

  return serveCachedOrRender(res, cacheKey, () => renderToPng(profileCardTree({
    displayName: user.displayName || '',
    username: user.username,
    bio: truncate(user.bio || '', 140),
    avatarUrl: resolveAvatarUrl(user),
  })))
})

router.get('/image/caw/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || id <= 0) return res.redirect(302, '/api/og/image/default')

  const caw = await prisma.caw.findUnique({
    where: { id },
    select: {
      id: true, content: true, status: true,
      user: {
        select: {
          tokenId: true, username: true, displayName: true,
          avatarUrl: true, defaultAvatarId: true,
        },
      },
    },
  })
  // Only render cards for posts a stranger could see. PENDING/FAILED stays
  // private (matches the GET /api/caws/:id visibility rule).
  if (!caw || caw.status !== 'SUCCESS') return res.redirect(302, '/api/og/image/default')

  // Posts are immutable so no input hash needed.
  const cacheKey = `caw-${caw.id}`
  return serveCachedOrRender(res, cacheKey, () => renderToPng(cawCardTree({
    displayName: caw.user.displayName || '',
    username: caw.user.username,
    text: truncate(caw.content || '', 280),
    avatarUrl: resolveAvatarUrl(caw.user),
  })))
})

router.get('/image/hashtag/:tag', async (req, res) => {
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '')
  if (!tag || !/^[\w-]+$/.test(tag)) return res.redirect(302, '/api/og/image/default')
  const hashtag = await prisma.hashtag.findUnique({
    where: { name: tag },
    select: { name: true, usageCount: true },
  })
  // Cache key includes count so the card updates as the tag grows. Bucketed
  // so we don't blow the cache every single new caw — bumps every order of
  // magnitude (1 → 10 → 100 → 1000 → ...).
  const count = hashtag?.usageCount ?? 0
  const bucket = count === 0 ? 0 : Math.floor(Math.log10(count))
  const cacheKey = `hashtag-${tag}-${bucket}`
  return serveCachedOrRender(res, cacheKey, () => renderToPng(hashtagCardTree({
    tag, usageCount: count,
  })))
})

router.get('/image/default', async (_req, res) => {
  return serveCachedOrRender(res, 'default', () => renderToPng(defaultCardTree()))
})

export default router
