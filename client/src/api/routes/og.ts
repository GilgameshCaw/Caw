import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import dns from 'dns/promises'
import net from 'net'
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

// Logo embedded as a data URI so satori doesn't have to make a network
// request on every cold render. Loaded lazily once.
const LOGO_PATH = path.join(process.cwd(), 'public', 'images', 'caw-logo.png')
let logoDataUri: string | null = null
function getLogoDataUri(): string {
  if (logoDataUri) return logoDataUri
  const bytes = fs.readFileSync(LOGO_PATH)
  logoDataUri = `data:image/png;base64,${bytes.toString('base64')}`
  return logoDataUri
}

const W = 1200
const H = 630
const CAW_GOLD = '#ebc046'

// Format counts the way Twitter does: 999, 1.2K, 17K, 1.5M, 1.2B.
// Boundary check uses the rounded value (not the input) so 999_999 doesn't
// show as "1000K" — once it would round to 1.0K of the next magnitude,
// promote to that magnitude. Decimal only when < 10 of the unit.
function fmtCount(n: number): string {
  const fmt = (val: number, suffix: string) => {
    const s = val < 10 ? val.toFixed(1).replace(/\.0$/, '') : Math.round(val).toString()
    return `${s}${suffix}`
  }
  if (n < 1000) return String(n)
  const k = n / 1000
  if (k < 1000 && Math.round(k) < 1000) return fmt(k, 'K')
  const m = n / 1_000_000
  if (m < 1000 && Math.round(m) < 1000) return fmt(m, 'M')
  return fmt(n / 1_000_000_000, 'B')
}

// Branded "CAW" wordmark + logo lockup, mirroring the Sidebar's top-left
// element. Used as a corner badge on every card.
function brandLockup(opts: {
  logoSize?: number
  fontSize?: number
} = {}) {
  const logoSize = opts.logoSize ?? 64
  const fontSize = opts.fontSize ?? 56
  return {
    type: 'div',
    props: {
      style: { display: 'flex', alignItems: 'center', gap: 16 },
      children: [
        {
          type: 'img',
          props: {
            src: getLogoDataUri(),
            width: logoSize,
            height: logoSize,
            style: { objectFit: 'contain' },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize,
              fontWeight: 700, // satori only has the two weights we loaded
              color: CAW_GOLD,
              fontFamily: 'Inter',
              letterSpacing: '-0.01em',
              lineHeight: 1,
            },
            children: 'CAW',
          },
        },
      ],
    },
  }
}

// Default avatars live on disk under the FE's public/. Loaded once, lazy.
const DEFAULT_AVATARS_DIR = path.join(
  process.cwd(),
  'src', 'services', 'FrontEnd', 'public', 'images', 'avatars',
)
const defaultAvatarCache = new Map<number, string | null>()
function loadDefaultAvatarDataUri(id: number): string | null {
  const clamped = Math.max(1, Math.min(100, id))
  if (defaultAvatarCache.has(clamped)) return defaultAvatarCache.get(clamped)!
  try {
    const bytes = fs.readFileSync(path.join(DEFAULT_AVATARS_DIR, `${clamped}.png`))
    const uri = `data:image/png;base64,${bytes.toString('base64')}`
    defaultAvatarCache.set(clamped, uri)
    return uri
  } catch {
    defaultAvatarCache.set(clamped, null)
    return null
  }
}

function defaultAvatarIdFor(user: {
  defaultAvatarId?: number | null
  tokenId?: number
}): number {
  return Math.max(1, Math.min(100, user.defaultAvatarId || ((user.tokenId || 0) % 100) + 1))
}

// Universal "always works" fallback. Resolved once at module init by
// scanning 1.png, 2.png, ... until one reads. Used as the bottom of the
// avatar fallback chain so we *always* have a real image to render —
// even when a user's specifically-assigned default avatar is missing
// from disk. If literally no default reads, we return null and the
// caller hides the avatar slot — but the card still renders.
let universalFallbackAvatar: string | null | undefined
function getUniversalFallbackAvatar(): string | null {
  if (universalFallbackAvatar !== undefined) return universalFallbackAvatar
  for (let i = 1; i <= 100; i++) {
    const uri = loadDefaultAvatarDataUri(i)
    if (uri) {
      universalFallbackAvatar = uri
      return uri
    }
  }
  universalFallbackAvatar = null
  return null
}

// SSRF guard for user-supplied URLs (currently: avatarUrl). Without this,
// a malicious user could set their avatarUrl to http://169.254.169.254/...
// (cloud metadata) or http://localhost:9200 (Elasticsearch) and we'd
// fetch + base64 the response into the rendered OG card. Even though
// extracting useful data from a rasterized PNG is hard, we still don't
// want our box reaching into its own private network on a stranger's
// behalf. Refuse anything that resolves to a non-public IP.
//
// Three checks:
//   1. Protocol must be http: or https:.
//   2. If hostname is a literal IP, it must be public.
//   3. Otherwise resolve via DNS — ALL returned addresses must be public
//      (a single private match means reject; defends against DNS records
//      that splice 127.0.0.1 into a public-looking host).
async function isSafePublicUrl(rawUrl: string): Promise<boolean> {
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const host = parsed.hostname
  if (!host) return false

  // Hostname can be a literal IPv4/IPv6 — check directly. Otherwise resolve.
  const literalFamily = net.isIP(host) // 0 = not an IP, 4 or 6 otherwise
  const ips: string[] = literalFamily ? [host] : []
  if (!literalFamily) {
    try {
      const records = await dns.lookup(host, { all: true })
      for (const r of records) ips.push(r.address)
    } catch {
      return false // DNS failure → can't verify, refuse
    }
  }
  if (ips.length === 0) return false
  for (const ip of ips) if (!isPublicIp(ip)) return false
  return true
}

// True only for IPs we're willing to reach from the server. Excludes:
// loopback (127/8, ::1), link-local (169.254/16, fe80::/10 — covers AWS
// metadata at 169.254.169.254), RFC1918 (10/8, 172.16/12, 192.168/16),
// CGNAT (100.64/10), unspecified (0.0.0.0, ::), private IPv6 (fc00::/7),
// IPv4-mapped IPv6 (::ffff:0:0/96 — block to prevent IPv6-tunnel bypass).
function isPublicIp(ip: string): boolean {
  // IPv4
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0) return false                                  // 0.0.0.0/8
    if (a === 10) return false                                 // 10/8
    if (a === 127) return false                                // loopback
    if (a === 169 && b === 254) return false                   // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return false          // 172.16/12
    if (a === 192 && b === 168) return false                   // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return false         // CGNAT 100.64/10
    if (a >= 224) return false                                 // multicast / reserved
    return true
  }
  // IPv6
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::' || lower === '::1') return false         // unspec + loopback
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return false // fe80::/10 link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false   // fc00::/7 ULA
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4.
    const v4 = lower.match(/^::ffff:([0-9.]+)$/)?.[1]
    if (v4 && net.isIPv4(v4)) return isPublicIp(v4)
    // ::ffff:hex:hex form — extract last 32 bits as v4.
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16)
      const lo = parseInt(hexMapped[2], 16)
      const v4back = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
      return isPublicIp(v4back)
    }
    return true
  }
  return false
}

// Resolve a user's avatar to a data URI satori can render directly. Tries
// custom avatarUrl first, then the user's default avatar (by id or
// tokenId%100), then any default we can read off disk. Returns null only
// when literally nothing on disk works — callers render a placeholder.
//
// Why data URIs and not URLs: satori's <img src="https://..."> path makes
// a network request that can race, time out, or hit DNS issues. A custom
// avatar that 404s used to bake into the card (the disk cache then froze
// a "broken" render in place). Pre-fetching with a 4s budget + falling
// back lets us produce a valid card every time.
async function resolveAvatarDataUri(user: {
  avatarUrl?: string | null
  defaultAvatarId?: number | null
  tokenId?: number
}): Promise<string | null> {
  // 1. Custom avatar — fetch and validate. Tight timeout so we never block
  //    the render on a slow user-uploaded host. Absolute URLs go through
  //    the SSRF guard (refuse private/loopback/metadata IPs); relative
  //    URLs hit our own public origin so they're fine without the check.
  if (user.avatarUrl) {
    const isAbsolute = /^https?:\/\//.test(user.avatarUrl)
    const url = isAbsolute
      ? user.avatarUrl
      : `${publicUrl()}${user.avatarUrl.startsWith('/') ? '' : '/'}${user.avatarUrl}`
    const safe = isAbsolute ? await isSafePublicUrl(url) : true
    if (safe) {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 4000)
        const res = await fetch(url, { signal: ctrl.signal })
        clearTimeout(t)
        if (res.ok) {
          const ct = (res.headers.get('content-type') || '').toLowerCase()
          if (ct.startsWith('image/')) {
            const buf = Buffer.from(await res.arrayBuffer())
            // Sanity-check magic bytes to reject HTML "soft 404s" served as
            // image/* (e.g. a CDN's branded not-found page).
            if (looksLikeImage(buf)) {
              return `data:${ct};base64,${buf.toString('base64')}`
            }
          }
        }
      } catch {
        // Fall through to defaults below.
      }
    }
  }
  // 2. Default avatar from disk, deterministic per user. defaultAvatarId
  //    is set at signup; tokenId%100 is the legacy-user fallback. Either
  //    way the same user gets the same default every render.
  const fromDisk = loadDefaultAvatarDataUri(defaultAvatarIdFor(user))
  if (fromDisk) return fromDisk
  // 3. Universal fallback — first default that reads off disk. Used only
  //    when this user's specific default avatar file is missing.
  return getUniversalFallbackAvatar()
}

// Quick magic-byte check — covers the formats browsers/satori actually
// render (PNG, JPEG, GIF, WebP). Cheap and correct enough for our purposes.
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true
  return false
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}

// Render an avatar as a real image. resolveAvatarDataUri's three-tier
// chain (custom → user's default → universal fallback) means src is
// effectively always non-null; the null branch only fires in a broken
// install where every default avatar PNG is missing from disk, in
// which case we omit the avatar rather than showing a placeholder.
function avatarNode(opts: {
  src: string | null
  size: number
  username: string
  marginRight?: number
}) {
  if (!opts.src) return null
  return {
    type: 'img',
    props: {
      src: opts.src,
      width: opts.size,
      height: opts.size,
      style: {
        borderRadius: opts.size / 2,
        ...(opts.marginRight ? { marginRight: opts.marginRight } : {}),
      },
    },
  }
}

// Build a profile card (1200x630). Layout:
//   • Avatar (left), name + @handle + bio (right)
//   • Stats row at the bottom: followers · following · caws
//   • CAW logo+wordmark in the top-right corner
function profileCardTree(opts: {
  displayName: string
  username: string
  bio: string
  /** Pre-resolved data URI, or null to render the colored-initial fallback. */
  avatar: string | null
  followerCount: number
  followingCount: number
  cawCount: number
  likesReceivedCount: number
}) {
  const hasDisplayName = !!opts.displayName && opts.displayName.trim() !== ''
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#0A0A0A',
        padding: '56px 64px',
        color: '#ffffff',
        fontFamily: 'Inter',
        position: 'relative',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', position: 'absolute', top: 56, right: 64 },
            children: [brandLockup()],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              flex: 1,
              marginTop: 24,
            },
            children: [
              avatarNode({ src: opts.avatar, size: 320, username: opts.username, marginRight: 56 }),
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: 64, fontWeight: 700, lineHeight: 1.1 },
                        children: hasDisplayName ? opts.displayName : `@${opts.username}`,
                      },
                    },
                    hasDisplayName ? {
                      type: 'div',
                      props: {
                        style: { fontSize: 32, color: '#9ca3af', marginTop: 8 },
                        children: `@${opts.username}`,
                      },
                    } : null,
                    opts.bio ? {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 28,
                          color: '#d1d5db',
                          marginTop: 24,
                          lineHeight: 1.35,
                          maxHeight: 120,
                          overflow: 'hidden',
                        },
                        children: opts.bio,
                      },
                    } : null,
                  ].filter(Boolean),
                },
              },
            ].filter(Boolean) as any,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              gap: 48,
              borderTop: '1px solid #1f2937',
              paddingTop: 24,
            },
            children: [
              statTile(fmtCount(opts.followerCount), opts.followerCount === 1 ? 'Follower' : 'Followers'),
              statTile(fmtCount(opts.followingCount), 'Following'),
              statTile(fmtCount(opts.cawCount), opts.cawCount === 1 ? 'Post' : 'Posts'),
              statTile(fmtCount(opts.likesReceivedCount), 'Likes'),
            ],
          },
        },
      ],
    },
  }
}

function statTile(value: string, label: string) {
  return {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'row', alignItems: 'baseline', gap: 10 },
      children: [
        {
          type: 'div',
          props: {
            style: { fontSize: 36, fontWeight: 700, color: '#ffffff' },
            children: value,
          },
        },
        {
          type: 'div',
          props: {
            style: { fontSize: 26, color: '#9ca3af' },
            children: label,
          },
        },
      ],
    },
  }
}

// Build a single-caw card — avatar + handle top-left, brand lockup
// top-right, post text dominates. Caps text at ~3 lines so it doesn't
// overflow into the chrome.
function cawCardTree(opts: {
  displayName: string
  username: string
  text: string
  /** Pre-resolved data URI, or null to render the colored-initial fallback. */
  avatar: string | null
}) {
  const hasDisplayName = !!opts.displayName && opts.displayName.trim() !== ''
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#0A0A0A',
        padding: '56px 64px',
        color: '#ffffff',
        fontFamily: 'Inter',
      },
      children: [
        // Top row: author left, brand lockup right
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'row', alignItems: 'center' },
                  children: [
                    avatarNode({ src: opts.avatar, size: 96, username: opts.username, marginRight: 24 }),
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', flexDirection: 'column' },
                        children: [
                          {
                            type: 'div',
                            props: {
                              style: { fontSize: 36, fontWeight: 700, lineHeight: 1.1 },
                              children: hasDisplayName ? opts.displayName : `@${opts.username}`,
                            },
                          },
                          hasDisplayName ? {
                            type: 'div',
                            props: {
                              style: { fontSize: 26, color: '#9ca3af', marginTop: 4 },
                              children: `@${opts.username}`,
                            },
                          } : null,
                        ].filter(Boolean),
                      },
                    },
                  ].filter(Boolean) as any,
                },
              },
              brandLockup({ logoSize: 56, fontSize: 44 }),
            ],
          },
        },
        // Post text — capped height so a long caw can't push the lockup
        // off-screen. Satori clips overflow when overflow:hidden is set.
        {
          type: 'div',
          props: {
            style: {
              fontSize: 48,
              lineHeight: 1.3,
              marginTop: 48,
              color: '#f3f4f6',
              maxHeight: 380,
              overflow: 'hidden',
              display: 'flex',
            },
            children: opts.text,
          },
        },
      ],
    },
  }
}

// Hashtag card — big #tag (white), usage count below, brand lockup at
// the bottom. Lockup uses the same logo + gold wordmark as the page.
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
        position: 'relative',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: 64,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: 160, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em' },
                  children: `#${opts.tag}`,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 40, color: '#9ca3af', marginTop: 24 },
                  children: opts.usageCount > 0
                    ? `${opts.usageCount.toLocaleString()} ${opts.usageCount === 1 ? 'caw' : 'caws'} on CAW`
                    : 'on CAW',
                },
              },
            ],
          },
        },
        // Brand lockup pinned to the bottom-center.
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute',
              bottom: 48,
              left: 0,
              right: 0,
              justifyContent: 'center',
            },
            children: [brandLockup({ logoSize: 56, fontSize: 48 })],
          },
        },
      ],
    },
  }
}

// Default card — big logo + CAW wordmark in brand color, tagline below.
// Used for the homepage and any route not handled above.
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
                  style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 32 },
                  children: [
                    {
                      type: 'img',
                      props: {
                        src: getLogoDataUri(),
                        width: 200,
                        height: 200,
                        style: { objectFit: 'contain' },
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 220,
                          fontWeight: 700,
                          color: CAW_GOLD,
                          letterSpacing: '-0.02em',
                          lineHeight: 1,
                        },
                        children: 'CAW',
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 36, color: '#9ca3af', marginTop: 32 },
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
      followerCount: true, followingCount: true,
      cawCount: true, likesReceivedCount: true,
    },
  })
  if (!user) return res.redirect(302, '/api/og/image/default')

  // Cache key includes a hash of the inputs so name/bio/avatar/count edits
  // invalidate. Counts are bucketed by the formatted display value so we
  // don't blow the cache on every new follower — the card only changes
  // when the displayed number changes (e.g. 999 → 1K).
  const followersDisp = fmtCount(user.followerCount)
  const followingDisp = fmtCount(user.followingCount)
  const cawsDisp = fmtCount(user.cawCount)
  const likesDisp = fmtCount(user.likesReceivedCount)
  const inputHash = crypto.createHash('sha1')
    .update([
      user.displayName, user.bio, user.avatarUrl, user.defaultAvatarId,
      followersDisp, followingDisp, cawsDisp, likesDisp,
    ].join('|'))
    .digest('hex').slice(0, 8)
  const cacheKey = `profile-${user.tokenId}-${inputHash}`

  return serveCachedOrRender(res, cacheKey, async () => {
    const avatar = await resolveAvatarDataUri(user)
    return renderToPng(profileCardTree({
      displayName: user.displayName || '',
      username: user.username,
      bio: truncate(user.bio || '', 140),
      avatar,
      followerCount: user.followerCount,
      followingCount: user.followingCount,
      cawCount: user.cawCount,
      likesReceivedCount: user.likesReceivedCount,
    }))
  })
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
  return serveCachedOrRender(res, cacheKey, async () => {
    const avatar = await resolveAvatarDataUri(caw.user)
    return renderToPng(cawCardTree({
      displayName: caw.user.displayName || '',
      username: caw.user.username,
      // ~200 chars fits ≈3 lines at 48px on a 1072px-wide content column —
      // any longer and the text crowds the chrome. The maxHeight clip in
      // cawCardTree is the belt-and-suspenders.
      text: truncate(caw.content || '', 200),
      avatar,
    }))
  })
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
