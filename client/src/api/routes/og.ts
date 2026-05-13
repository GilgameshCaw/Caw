import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { prisma } from '../../prismaClient'
import { publicUrl } from '../util/publicUrl'
import { isSafePublicUrl } from '../util/ssrfGuard'
import { stripPollMarker } from '../../tools/pollMarker'
import { t as i18nT } from '../util/i18n'
import { hasLocale } from '../util/localePrefix'

const router = Router()

// Disk cache for rendered PNGs. Lives under public/uploads (already
// gitignored + served by the API's static handler) but we resolve from
// the running CWD so dev and pm2 both find the same dir.
const CACHE_DIR = path.join(process.cwd(), 'public', 'uploads', 'og-cache')
fs.mkdirSync(CACHE_DIR, { recursive: true })

// Fonts loaded once at module init. Satori requires the bytes; loading
// per-request would burn ~10ms on every miss.
//
// Inter covers Latin / Latin-Extended / common punctuation. Noto Sans
// JP is loaded as a FALLBACK so caws written in Japanese, Chinese, or
// Korean (or that mix CJK with Latin — common for hashtags) render
// real glyphs instead of "NO GLYPH" boxes. Satori walks the array in
// order per character: if Inter doesn't have the codepoint, it falls
// back to Noto. The CJK font is ~16MB per weight — held resident in
// memory after first load (no disk I/O on subsequent renders) but
// adds ~500ms to the very first render after a cold start.
//
// To extend coverage to other scripts (Cyrillic, Arabic, Hebrew, …),
// drop more Noto subset fonts into public/fonts/ and add them to the
// fallback list. Order matters only for Latin glyphs that exist in
// multiple loaded fonts — Inter must come first so the brand font
// wins for the body copy.
const FONTS_DIR = path.join(process.cwd(), 'public', 'fonts')
let fontRegular: Buffer | null = null
let fontBold: Buffer | null = null
let fontJpRegular: Buffer | null = null
let fontJpBold: Buffer | null = null
let fontEmoji: Buffer | null = null
function loadFonts() {
  if (!fontRegular) fontRegular = fs.readFileSync(path.join(FONTS_DIR, 'Inter-Regular.ttf'))
  if (!fontBold) fontBold = fs.readFileSync(path.join(FONTS_DIR, 'Inter-Bold.ttf'))
  // CJK fallback — best-effort. If the file's missing we just skip it
  // and CJK chars render as "NO GLYPH" boxes (the pre-fix behavior).
  // Logged once so the operator knows the font needs to be installed.
  if (fontJpRegular === null) {
    try { fontJpRegular = fs.readFileSync(path.join(FONTS_DIR, 'NotoSansJP-Regular.otf')) }
    catch { console.warn('[og] NotoSansJP-Regular.otf missing — CJK chars will render as boxes') }
  }
  if (fontJpBold === null) {
    try { fontJpBold = fs.readFileSync(path.join(FONTS_DIR, 'NotoSansJP-Bold.otf')) } catch { /* logged above */ }
  }
  // (No emoji font in the regular fallback list — satori doesn't
  // support COLR/COLRv1 color tables, only solid-color glyphs. We
  // handle emoji via renderToPng's loadAdditionalAsset callback,
  // which serves Twemoji SVGs per codepoint.)
  const fonts = [
    { name: 'Inter', data: fontRegular, weight: 400 as const, style: 'normal' as const },
    { name: 'Inter', data: fontBold, weight: 700 as const, style: 'normal' as const },
  ]
  if (fontJpRegular) fonts.push({ name: 'Noto Sans JP', data: fontJpRegular, weight: 400 as const, style: 'normal' as const })
  if (fontJpBold)    fonts.push({ name: 'Noto Sans JP', data: fontJpBold,    weight: 700 as const, style: 'normal' as const })
  return fonts
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

// Card canvas. Width was 1200 (the OG-spec default) but at that size
// the card felt sparse — half the platforms (Telegram, iMessage,
// Discord) crop or letterbox to a more square aspect anyway. 860 is
// denser, reads as one block, and still hits the OG-image minimum
// dimensions every platform respects.
const W = 860
const H = 630
const CAW_GOLD = '#ebc046'

// Subtle background variants — caw_id mod 4 picks one. Differences are
// only visible side-by-side; keeps every card looking like CAW while
// breaking up grid monotony when several share to the same channel.
const CARD_BG_VARIANTS = ['#030d14', '#180A0A', '#0E0E18', '#150E15', '#140314', '#040c07', '#151001']
function cardBgFor(cawId: number): string {
  return CARD_BG_VARIANTS[Math.abs(cawId) % CARD_BG_VARIANTS.length]
}

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

// Hard cap for HTML / video bytes we'll pull during OG resolution.
// Prevents a malicious link from making us download a 1GB file just to
// scrape og:image. 1MB is plenty for any sane page <head>.
const HTML_FETCH_BYTES_CAP = 1_000_000
const VIDEO_FETCH_BYTES_CAP = 50_000_000  // 50MB; first-frame extraction
                                          // doesn't need the whole file
                                          // but most caw videos fit in this.

// Fetch an external resource with size + timeout caps. Returns the body
// or null on timeout / size cap / non-2xx. SSRF-checked for absolute
// URLs; relative URLs are caller-validated.
async function fetchBoundedBytes(rawUrl: string, capBytes: number, timeoutMs = 4000): Promise<{ buf: Buffer; contentType: string } | null> {
  const isAbsolute = /^https?:\/\//.test(rawUrl)
  const url = isAbsolute ? rawUrl : `${publicUrl()}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
  if (isAbsolute && !(await isSafePublicUrl(url))) return null
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const cl = Number(res.headers.get('content-length') || 0)
    if (cl > 0 && cl > capBytes) return null
    // Stream-read with a running cap so we don't load oversized bodies
    // into memory just to discard them.
    const reader = res.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > capBytes) { reader.cancel().catch(() => {}); return null }
      chunks.push(value)
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)))
    return { buf, contentType: (res.headers.get('content-type') || '').toLowerCase() }
  } catch {
    return null
  }
}

// Scrape an HTML page for an og:image / twitter:image URL. Tiny regex
// over the first ~1MB — we don't need a real parser since these meta
// tags live in the head and are short. Returns the resolved image data
// URI or null if the page has no preview image (or the preview image
// itself fails to fetch).
//
// Two paths:
//   • response is text/html → parse meta tags, fetch the image they
//     point at
//   • response is image/* → use it directly. Common with short URLs
//     that wrap an image link — `https://test.caw.social/s/abc` (no
//     extension) might 302 to `https://cdn/foo.jpg`, and short URLs
//     are how we store ALL arbitrary URLs in caws.
async function scrapeOgImageFromUrl(pageUrl: string): Promise<string | null> {
  const fetched = await fetchBoundedBytes(pageUrl, HTML_FETCH_BYTES_CAP, 4000)
  if (!fetched) return null
  // Direct-image case: response IS the image, no HTML scraping needed.
  if (fetched.contentType.startsWith('image/') && looksLikeImage(fetched.buf)) {
    return `data:${fetched.contentType};base64,${fetched.buf.toString('base64')}`
  }
  if (!fetched.contentType.startsWith('text/html')) return null
  const html = fetched.buf.toString('utf-8')
  // Permissive regex covers both attribute orderings (property/name first
  // OR content first) and quote styles. og:image takes precedence;
  // twitter:image is the fallback.
  const tryTags = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ]
  let imgUrl: string | null = null
  for (const re of tryTags) {
    const m = html.match(re)
    if (m) { imgUrl = m[1]; break }
  }
  if (!imgUrl) return null
  // Resolve relative og:image against the page URL.
  try {
    const resolved = new URL(imgUrl, pageUrl).toString()
    return await fetchImageDataUri(resolved)
  } catch {
    return null
  }
}

// Extract the first frame of a video URL as a JPEG data URI. Requires
// `ffmpeg` on PATH; degrades to null if ffmpeg is missing or extraction
// fails. Caches per video URL on disk so we don't re-run ffmpeg for
// the same source.
const VIDEO_FRAME_CACHE = path.join(CACHE_DIR, 'video-frames')
fs.mkdirSync(VIDEO_FRAME_CACHE, { recursive: true })
let ffmpegMissingLogged = false
async function extractVideoFirstFrame(videoUrl: string): Promise<string | null> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)

  // Disk cache key: hash of URL → jpg file.
  const key = crypto.createHash('sha1').update(videoUrl).digest('hex').slice(0, 16)
  const outPath = path.join(VIDEO_FRAME_CACHE, `${key}.jpg`)
  try {
    if (fs.existsSync(outPath)) {
      const buf = fs.readFileSync(outPath)
      return `data:image/jpeg;base64,${buf.toString('base64')}`
    }
  } catch { /* fall through */ }

  // Pull the bytes (size-capped) so ffmpeg reads from a local temp file
  // — much more reliable than streaming a remote URL through ffmpeg
  // directly (which can deadlock on slow servers).
  const fetched = await fetchBoundedBytes(videoUrl, VIDEO_FETCH_BYTES_CAP, 8000)
  if (!fetched) return null
  if (!fetched.contentType.startsWith('video/')) return null

  const tmpIn = path.join(VIDEO_FRAME_CACHE, `${key}.in`)
  try {
    fs.writeFileSync(tmpIn, fetched.buf)
    // -ss 0.5 grabs a frame half a second in (skipping a possible
    // black opening frame). -vframes 1 takes a single frame; -q:v 3
    // is medium-high JPEG quality. Timeout caps the whole call.
    await exec('ffmpeg', [
      '-y',           // overwrite output
      '-ss', '0.5',
      '-i', tmpIn,
      '-vframes', '1',
      '-q:v', '3',
      outPath,
    ], { timeout: 8000 })
    if (!fs.existsSync(outPath)) return null
    const buf = fs.readFileSync(outPath)
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  } catch (err: any) {
    if (err?.code === 'ENOENT' && !ffmpegMissingLogged) {
      console.warn('[og] ffmpeg not on PATH — video first-frame extraction disabled. apt install ffmpeg on the host.')
      ffmpegMissingLogged = true
    }
    return null
  } finally {
    try { fs.unlinkSync(tmpIn) } catch { /* ignore */ }
  }
}

// Pre-fetch an external image into a data URI satori can render
// directly. Tight 4s timeout (we'd rather fall back to the next-best
// image than block the OG render). Absolute URLs go through the SSRF
// guard; relative URLs are caller-validated and hit our own origin.
// Returns null when the URL doesn't safely resolve to image bytes.
//
// Two relative-path shapes are accepted:
//   /uploads/images/<8hex>.<ext>      (user uploads from POST /api/upload)
//   /images/avatars/<n>.png           (committed default avatars)
// Anything else is rejected without a fetch — prevents path traversal /
// internal-route exfiltration via a poisoned avatarUrl or imageData.
async function fetchImageDataUri(rawUrl: string): Promise<string | null> {
  const isAbsolute = /^https?:\/\//.test(rawUrl)
  const RELATIVE_OK = /^\/(?:uploads\/images\/[a-f0-9]{8}\.(?:jpg|jpeg|png|gif|webp)|images\/avatars\/\d+\.png)(?:[?#].*)?$/
  const url = isAbsolute
    ? rawUrl
    : `${publicUrl()}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
  const safe = isAbsolute ? await isSafePublicUrl(url) : RELATIVE_OK.test(rawUrl)
  if (!safe) return null
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (!ct.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    // Magic-byte check rejects HTML "soft 404s" served with image/*.
    if (!looksLikeImage(buf)) return null
    // Satori can't decode WebP — converts crash with "u is not
    // iterable" inside its image preprocessor. Re-encode to PNG via
    // ffmpeg before handing off; same dep we already use for video
    // first-frame extraction so no extra install burden.
    if (ct.includes('webp') || (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)) {
      const png = await transcodeWebpToPng(buf)
      if (!png) return null
      return `data:image/png;base64,${png.toString('base64')}`
    }
    return `data:${ct};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

// Re-encode a WebP buffer to PNG via ffmpeg. Returns null if ffmpeg
// is missing or the conversion fails. Caller falls back to next tier.
async function transcodeWebpToPng(webpBuf: Buffer): Promise<Buffer | null> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)
  const key = crypto.createHash('sha1').update(webpBuf).digest('hex').slice(0, 16)
  const tmpIn = path.join(VIDEO_FRAME_CACHE, `${key}.webp`)
  const tmpOut = path.join(VIDEO_FRAME_CACHE, `${key}.png`)
  try {
    if (fs.existsSync(tmpOut)) return fs.readFileSync(tmpOut)
    fs.writeFileSync(tmpIn, webpBuf)
    await exec('ffmpeg', ['-y', '-i', tmpIn, tmpOut], { timeout: 6000 })
    if (!fs.existsSync(tmpOut)) return null
    return fs.readFileSync(tmpOut)
  } catch (err: any) {
    if (err?.code === 'ENOENT' && !ffmpegMissingLogged) {
      console.warn('[og] ffmpeg not on PATH — webp images will be skipped from share cards.')
      ffmpegMissingLogged = true
    }
    return null
  } finally {
    try { fs.unlinkSync(tmpIn) } catch { /* ignore */ }
  }
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
  // 1. Custom avatar — fetch and validate via the shared helper.
  if (user.avatarUrl) {
    const fetched = await fetchImageDataUri(user.avatarUrl)
    if (fetched) return fetched
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
// Decode an image's intrinsic dimensions from its bytes — used to
// preserve aspect ratio on image-only cards (so a landscape photo
// doesn't get center-cropped to a square). Supports PNG, JPEG, GIF,
// WebP. Returns null on any decode failure (caller falls back to a
// square render).
function imageDimensionsFromBuf(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A then IHDR chunk at byte 16
  // (length=4) with width @ 16 and height @ 20 (big-endian uint32).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  // JPEG: scan for SOFn marker (FF C0..FF C3 / FF C5..FF C7 / etc.).
  // Marker payload starts with 2 bytes length, 1 byte precision, then
  // height (16-bit BE), then width.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i < buf.length - 8) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      // SOFn markers (excluding DHT C4, JPG C8, DAC CC).
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = buf.readUInt16BE(i + 5)
        const w = buf.readUInt16BE(i + 7)
        return { w, h }
      }
      // Skip to next marker. Length includes the 2 length bytes.
      const segLen = buf.readUInt16BE(i + 2)
      i += 2 + segLen
    }
    return null
  }
  // GIF: width @ 6, height @ 8 (little-endian uint16).
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
  }
  // WebP (VP8 / VP8L / VP8X) — RIFF...WEBP.
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    // VP8X (lossy/lossless extended): width-1 @ 24..26, height-1 @ 27..29 (LE 24-bit)
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { w, h }
    }
    // VP8 (lossy) — first 3 bytes of frame are sync, then 7-bit width @ 26, 7-bit height @ 28
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
      const w = buf.readUInt16LE(26) & 0x3fff
      const h = buf.readUInt16LE(28) & 0x3fff
      return { w, h }
    }
  }
  return null
}

// Decode dimensions from a `data:image/...;base64,<bytes>` URI. Returns
// null when the URI isn't a base64 data URL we can decode.
function dataUriDimensions(uri: string): { w: number; h: number } | null {
  try {
    const m = uri.match(/^data:[^;,]+;base64,(.+)$/)
    if (!m) return null
    // Only need the first ~40 bytes for dimension headers — decode a
    // small prefix to keep it cheap on big images.
    const prefix = m[1].slice(0, 80)
    const buf = Buffer.from(prefix, 'base64')
    return imageDimensionsFromBuf(buf)
  } catch { return null }
}

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
// Pick a heading font size that won't overflow the profile card's text
// column. Used for both displayName and @username headings — the long-
// handle case (no displayName, 15+ char username) was clipping past the
// brand lockup. Step function instead of true measurement because satori
// has no glyph-metrics API; numbers tuned visually against Inter Bold.
function headingFontSize(s: string): number {
  const len = (s || '').length
  if (len <= 10) return 64
  if (len <= 13) return 56
  if (len <= 16) return 48
  if (len <= 20) return 40
  return 36
}

function profileCardTree(opts: {
  displayName: string
  username: string
  bio: string
  /** Pre-resolved data URI. Always non-null in practice — see resolveAvatarDataUri's
   *  fallback chain. null only happens in a broken install where every default
   *  avatar PNG is missing from disk; the avatar slot is then omitted. */
  avatar: string | null
  followerCount: number
  followingCount: number
  cawCount: number
  likesReceivedCount: number
  /** Locale for the card chrome labels. null = English (default). */
  locale?: string | null
}) {
  // Local t() that captures the locale once so the call sites read clean.
  const tt = (key: string, vars?: { count?: number }) =>
    i18nT(opts.locale ?? null, key, vars)
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
                        // Dynamic font size: long handles/names overflow the
                        // text column AND collide with the top-right brand
                        // lockup. Step the size down based on char count so
                        // a 15-char username fits without truncation.
                        // Available text-column width (after avatar + brand
                        // lockup carve-out) is ~210px on the top row; Inter
                        // Bold averages ~0.55em per char.
                        style: { fontSize: headingFontSize(hasDisplayName ? opts.displayName : `@${opts.username}`), fontWeight: 700, lineHeight: 1.1 },
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
              statTile(fmtCount(opts.followerCount), tt('og.profile.stat.follower', { count: opts.followerCount })),
              statTile(fmtCount(opts.followingCount), tt('og.profile.stat.following')),
              statTile(fmtCount(opts.cawCount), tt('og.profile.stat.post', { count: opts.cawCount })),
              statTile(fmtCount(opts.likesReceivedCount), tt('og.profile.stat.likes')),
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

// ── Caw card layout constants (all derived from the 1200×630 canvas) ──
//
// Visual structure:
//   [yellow strip][margin][text column                  ][image][margin]
//                          line 1: "CAW – <hostname>" (gold, bold)
//                          line 2: "Display Name (@username) on CAW" (white, bold)
//                          line 3: content (narrow, ≤ 68% width)
//                          line 4: content (narrow, ≤ 68% width)
//                          line 5+ content (wide,  ≤ 94% width) — cut at
//                                  8 content lines, or 5 when a poll is
//                                  shown so the poll bars fit at bottom.
//
// The square image (media or avatar) sits in the top-right corner at
// 18% width. Lines 1–4 must fit alongside it, hence the 68% narrow cap.
// Lines past 4 use the full 94% width since the image no longer overlaps.
//
// Card height is dynamic: we measure the rendered tree and tell satori
// to render to that exact height. Floor at CARD_MIN_H so a one-word caw
// isn't a sliver; cap at CARD_MAX_H (the 1200×630 OG default) so a long
// caw doesn't blow past the standard preview slot.
const CARD_STRIP_W = Math.round(W * 0.015)      // 18 — left yellow strip
const CARD_MARGIN  = Math.round(W * 0.015)      // 18 — outer margin (left/right)
// Top/bottom margin is wider than left/right so the text + stats stack
// breathes against the card edges. Twitter's preview crops a few pixels
// off each side; the extra vertical air keeps the chrome line / stats
// row from kissing the crop boundary.
const CARD_MARGIN_Y = CARD_MARGIN * 2            // 36 — outer margin (top/bottom)
const CARD_IMG_SZ  = Math.round(W * 0.18)       // 216 — square image in top-right
const CARD_NARROW_W = Math.round(W * 0.68)      // 816 — text column when image overlaps
const CARD_TEXT_X   = CARD_STRIP_W + CARD_MARGIN
// Wide content lines render below the corner image, so they get the
// full available width — everything between the text column's left
// edge and the right outer margin. No image-overlap concern.
const CARD_WIDE_W   = W - CARD_TEXT_X - CARD_MARGIN
const CARD_MIN_H    = 280
const CARD_MAX_H    = H

// Single text size everywhere — header, byline, content all 30px so
// the card reads like one document, not three competing zones. With
// content-text smaller, more lines fit per card; bumped the budgets
// from 8 / 5 lines to a more generous count (see planCawCard).
const CARD_HEADER_FS = 30
const CARD_BYLINE_FS = 30
const CARD_BODY_FS   = 30
const CARD_LINE_H    = 1.4
const CARD_HEADER_PX = Math.round(CARD_HEADER_FS * CARD_LINE_H)  // 42
const CARD_BYLINE_PX = Math.round(CARD_BYLINE_FS * CARD_LINE_H)  // 42
const CARD_BODY_PX   = Math.round(CARD_BODY_FS * CARD_LINE_H)    // 42
const CARD_GAP_NARROW = 16  // between byline and first content line
const CARD_GAP_WIDE   = 4   // between narrow block and wide block
const CARD_GAP_POLL   = 20  // between content and poll
const CARD_IMG_PAD    = 16  // bottom-cushion below corner image

// Poll bars sized so up to 4 fit comfortably under content. Bar
// height bumped 20% over the original (43 vs 36) for a chunkier feel
// — narrow caw cards look anemic when the bars are skinny next to a
// big square corner image.
const POLL_BAR_H        = 43
const POLL_BAR_GAP      = 6
const POLL_LABEL_FS     = 22
const POLL_LABEL_PAD_X  = 14
const POLL_TRACK_BG     = '#1f2937'
const POLL_FILL         = '#3b3522'  // muted gold so it reads but doesn't fight the strip
const POLL_FILL_WIN     = CAW_GOLD

// Inter at body size — approximate average glyph width. Used to
// estimate wrap points without dragging in a real font-shaping lib.
// Slightly under-shoots so the wrapped lines have a hair of slack and
// satori never has to break a word mid-render.
// Inter at body size — average glyph advance is closer to 0.55em for
// ALL caps and 0.50em for lowercase. Body copy is mostly lowercase, so
// 0.52 is the actual average glyph width for Inter at body size. We
// used to overshoot enough that a "narrow"-budget line bled past the
// column edge into the corner image, so this bumped to 0.60 (10%
// slack). Now back to 0.55 — combined with the smaller right pad
// below, lines fill the column without intruding into the image, and
// fewer get punted to the wide section as a result.
const CHAR_W_RATIO = 0.55
// Hard pixel padding on the narrow column to leave a visible gap from
// the right edge of the text to the left edge of the image. Without
// this, even a perfectly-budgeted line touches the image. 12 is the
// minimum that still reads as deliberate space rather than a bug.
const CARD_NARROW_RIGHT_PAD = 12
function approxCharsPerPx(fontSize: number, widthPx: number): number {
  return Math.floor(widthPx / (fontSize * CHAR_W_RATIO))
}

// Strip characters Inter can't render — emoji, exotic unicode, control
// chars. Without this, satori draws "NO GLYPH" rectangles for every
// missing codepoint. Cheap allowlist: ASCII printable + Latin-1
// supplement + Latin Extended-A/B + a few common punctuation marks
// (en-dash, em-dash, curly quotes, ellipsis). Anything else gets dropped.
function stripUnrenderable(s: string): string {
  if (!s) return ''
  // Emoji are rendered via satori's loadAdditionalAsset -> Twemoji
  // SVGs (see renderToPng). Inter / Noto JP don't have the glyphs
  // and satori doesn't read COLR fonts, so this asset path is the
  // one that produces real images. We keep emoji codepoints in the
  // text and let satori swap them for SVGs at render time.
  // Only drop invisibles that mess up wrap counts (zero-width
  // space / formatting / variation selectors / control chars).
  const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F]/g
  let cleaned = s.replace(INVISIBLE, '')
  // Insert a hair-space between consecutive emoji so they don't
  // render touching. Satori inlines Twemoji SVGs with no horizontal
  // margin and Twemoji glyphs already fill their bounding box, so
  // back-to-back emoji read as one smushed blob ("\u{1F4AF}\u{1F4AF}\u{1F4AF}"
  // -> "100100100"). U+200A is narrow enough not to perceptibly
  // affect Latin text spacing.
  cleaned = cleaned.replace(/(\p{Extended_Pictographic})(?=\p{Extended_Pictographic})/gu, '$1\u200A')
  // Collapse runs of whitespace; preserve explicit newlines.
  return cleaned.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim()
}

// Hostname for the protocol header line, e.g. "test.caw.social". Falls
// back to the bare brand when publicUrl isn't a valid absolute URL
// (dev / mis-config). Cached after first resolution.
let cachedHostname: string | null = null
function getHostname(): string {
  if (cachedHostname !== null) return cachedHostname
  try { cachedHostname = new URL(publicUrl()).host } catch { cachedHostname = '' }
  return cachedHostname
}

// Insert single spaces BEFORE hashtags / cashtags / bare links when
// they're glued to preceding text (e.g. "post.#thing", "check
// thishttps://link"). Without this, wrap treats the whole thing as
// one word AND the gold token visually butts up against the gray
// copy. Idempotent — multiple spaces collapse in the wrap pass.
//
// We only pad the LEADING side. Trying to pad the trailing side with
// `(#tag)(?=[A-Za-z])` is wrong: the greedy `\w+` already consumed
// every alphanum the lookahead would need, so the engine backtracks
// one char and inserts the space INSIDE the tag (turning `#CAW` into
// `#CA W`). Trailing punctuation / spaces in the source are
// sufficient — and the tokenizer's NBSP-padding adds visual breathing
// room on the rendered side.
function padTaggedTokens(s: string): string {
  if (!s) return ''
  return s
    .replace(/(?<!\s)(#[\w-]+)/g, ' $1')
    .replace(/(?<!\s)(\$[A-Za-z][A-Za-z0-9_]{0,9})/g, ' $1')
    .replace(/(?<!\s)(https?:\/\/)/g, ' $1')
}

// Tokenize a line into colored segments. Hashtags (#foo), cashtags
// ($BAR), and bare links get the brand gold so they don't blend into
// the body copy. Everything else is the default body color.
//
// Why per-line tokenization (and not per-document): we already wrapped
// to plain strings before this step, so the per-line char budget stays
// honest. Tokenizing at the document level would let a token straddle
// a wrap boundary and the budget calc would need to know about token
// widths during wrap — way more state for marginal benefit.
// Tokens that get inline gold color: hashtags, $cashtags, links.
// Emoji also get split into their own segments (color stays default)
// so satori's loadAdditionalAsset path fires reliably for each one;
// emoji buried inside a long Latin run sometimes don't get
// substituted otherwise.
const LINE_TOKEN_RE = /(#[\w-]+|\$[A-Za-z][A-Za-z0-9_]{0,9}|https?:\/\/[^\s]+|\p{Extended_Pictographic})/gu
interface LineSegment { text: string; color: 'default' | 'gold' }
function tokenizeLine(line: string): LineSegment[] {
  if (!line) return []
  const segments: LineSegment[] = []
  let last = 0
  const PICTO = /^\p{Extended_Pictographic}$/u
  for (const m of line.matchAll(LINE_TOKEN_RE)) {
    const start = m.index ?? 0
    if (start > last) segments.push({ text: line.slice(last, start), color: 'default' })
    // Emoji match the same regex (so they get split into their own
    // segments) but stay default-colored — only #/$/links go gold.
    const isEmoji = PICTO.test(m[0])
    segments.push({ text: m[0], color: isEmoji ? 'default' : 'gold' })
    last = start + m[0].length
  }
  if (last < line.length) segments.push({ text: line.slice(last), color: 'default' })
  // Merge runs of same-color segments so satori doesn't break a
  // continuous gray stretch into multiple inline blocks. Emoji
  // segments stay UNMERGED — each emoji needs its own segment so
  // satori's loadAdditionalAsset substitutes one Twemoji SVG per
  // codepoint cleanly.
  const merged: LineSegment[] = []
  for (const seg of segments) {
    const isEmoji = PICTO.test(seg.text)
    const prev = merged[merged.length - 1]
    const prevIsEmoji = prev ? PICTO.test(prev.text) : false
    if (prev && prev.color === seg.color && !isEmoji && !prevIsEmoji) prev.text += seg.text
    else merged.push({ ...seg })
  }
  // Replace ASCII spaces ADJACENT to color boundaries with non-breaking
  // spaces so satori doesn't strip them when placing the segments in a
  // flex row. Without this, `"hello " + "#world"` renders as
  // `hello#world` because each segment's leading/trailing whitespace
  // gets collapsed by the flex layout. Internal spaces stay regular
  // (only the boundary-adjacent ones matter for visual separation).
  for (let i = 0; i < merged.length; i++) {
    if (i > 0)            merged[i].text = merged[i].text.replace(/^ /, ' ')
    if (i < merged.length - 1) merged[i].text = merged[i].text.replace(/ $/, ' ')
  }
  return merged
}

// Render one wrapped line as a flex row of colored segments. Returns a
// single satori node that occupies one line of `lineHeight * fontSize`.
// Empty or whitespace-only lines render as a zero-content div so the
// vertical gap survives.
function lineNode(line: string, opts: {
  fontSize: number
  bodyColor: string
  goldColor: string
  maxWidth: number
  key: string
}) {
  const segs = tokenizeLine(line)
  return {
    type: 'div',
    key: opts.key,
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'nowrap',
        maxWidth: opts.maxWidth,
        // Empty lines (blank paragraphs in the source) need a forced
        // height so the vertical gap survives in the rendered card.
        // Without this, an empty <div> collapses to 0px and "a\n\nb"
        // renders the same as "a\nb".
        minHeight: Math.round(opts.fontSize * CARD_LINE_H),
        // Lines pre-wrapped to budget; let satori clip if the
        // approximation overshoots a hair (rather than line-break mid-row).
        overflow: 'hidden',
      },
      children: segs.length > 0
        ? segs.map((seg, i) => ({
            type: 'div',
            key: `s${i}`,
            props: {
              style: {
                display: 'flex',
                color: seg.color === 'gold' ? opts.goldColor : opts.bodyColor,
                fontSize: opts.fontSize,
                // Each segment renders as a single inline run — never
                // wrap inside it. Without nowrap, satori treats the
                // segment as a flex item that can break to a new
                // visual line if its parent gets crowded, which is how
                // we ended up with `#CA` / `W` on two lines.
                whiteSpace: 'nowrap',
              },
              // Preserve trailing spaces inside segments by rendering
              // the raw string — flex rows collapse adjacent text in a
              // single div but won't trim within one.
              children: seg.text,
            },
          }))
        : [{ type: 'div', props: { style: { display: 'flex' }, children: '' } }],
    },
  }
}

// Word-wrap text into a line array bounded by per-line max chars. First
// `narrowLines` lines wrap at narrow width, remainder at wide. Anything
// past `totalLines` is ellipsised onto the last visible line.
//
// Greedy word-fill — same algorithm browsers use, but driven by a char
// budget instead of a real glyph measurement. Long words that exceed
// the char budget are hard-broken so we don't overflow the column.
function wrapCawContent(
  text: string,
  narrowChars: number,
  wideChars: number,
  narrowLines: number,
  totalLines: number,
): string[] {
  const lines: string[] = []
  if (!text) return lines
  // Normalize whitespace; preserve explicit newlines as line breaks.
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n')

  const breakWord = (word: string, max: number): string[] => {
    const out: string[] = []
    let i = 0
    while (i < word.length) { out.push(word.slice(i, i + max)); i += max }
    return out
  }

  for (const para of paragraphs) {
    if (lines.length >= totalLines) break
    const words = para.split(/\s+/).filter(Boolean)
    if (words.length === 0) { lines.push(''); continue }
    let current = ''
    for (const rawWord of words) {
      if (lines.length >= totalLines) break
      const max = lines.length < narrowLines ? narrowChars : wideChars
      // Hard-break any single word that's longer than a full line.
      const pieces = rawWord.length > max ? breakWord(rawWord, max) : [rawWord]
      for (const piece of pieces) {
        if (lines.length >= totalLines) break
        const candidate = current ? `${current} ${piece}` : piece
        if (candidate.length <= max) {
          current = candidate
        } else {
          lines.push(current)
          current = piece
        }
      }
    }
    if (current && lines.length < totalLines) {
      lines.push(current)
      current = ''
    }
  }

  // Ellipsis overflow: if we ran out of room mid-text, trim the last
  // visible line and stick a … on it.
  // Detection: if the original text contained more chars than what we
  // rendered (sum of line lengths + spaces between them), there's
  // truncation to mark.
  const renderedChars = lines.reduce((n, l) => n + l.length, 0) + Math.max(0, lines.length - 1)
  const stripped = text.replace(/\s+/g, ' ').trim()
  if (renderedChars < stripped.length && lines.length > 0) {
    const last = lines[lines.length - 1]
    const max = lines.length <= narrowLines ? narrowChars : wideChars
    // Trim to fit "…" within the same char budget.
    if (last.length >= max) {
      lines[lines.length - 1] = last.slice(0, max - 1).trimEnd() + '…'
    } else {
      lines[lines.length - 1] = last.trimEnd() + '…'
    }
  }
  return lines
}

interface PollOption {
  label: string
  votes: number
}

// Plan a caw card: returns the satori tree AND the height we want to
// render at. Splitting plan from render lets the caller pass the same
// height to satori's canvas dimensions, so the dark background sizes
// down with the content (instead of always filling 1200×630). The poll
// presence cuts content to 5 lines so the bars fit without overflow.
function planCawCard(opts: {
  displayName: string
  username: string
  text: string
  cornerImage: string | null
  poll?: { options: PollOption[]; totalVotes: number } | null
  /** Background color — caller picks per-caw via cardBgFor(cawId) so
   *  variants are deterministic across renders. */
  backgroundColor: string
  /** Posted-at date. Rendered as "· Mon DD" suffix on the byline. */
  postedAt?: Date | null
  /** Pre-bucketed display strings for the bottom stat row. Caller is
   *  responsible for fmtCount-style bucketing — these strings land
   *  on the card unchanged. */
  stats?: { likes: string; recaws: string; replies: string; views: string }
}): { tree: any; height: number } {
  // Pad tags + URLs with spaces BEFORE strip + wrap so the wrap sees
  // them as separate words and the tokenizer can color them inline.
  const padded = padTaggedTokens(opts.text || '')
  const cleanText  = stripUnrenderable(padded)
  const hasDisplayName = !!opts.displayName && opts.displayName.trim() !== ''
  const cleanDisplay = stripUnrenderable(opts.displayName || '')
  const cleanUsername = stripUnrenderable(opts.username || '')
  const cleanShownName = hasDisplayName && cleanDisplay ? cleanDisplay : ''

  // Image-only post: no readable text, but we have an image. Switch
  // to a stacked layout — header + byline at the top, then the image
  // (full text-area width) below. Reads more like a photo card than
  // a text card with a tiny corner thumbnail.
  if (cleanText.length === 0 && opts.cornerImage && (!opts.poll || opts.poll.options.length === 0)) {
    return planImageOnlyCard({ ...opts, cleanShownName, cleanUsername, stats: opts.stats })
  }
  // "· Mon DD" suffix when we have a postedAt. Twitter-style — current
  // year is implicit, prior years not shown either since OG cards mostly
  // get shared close to the post date. Rendered next to the domain on
  // line 1 (chrome together) so a long display name on line 2 doesn't
  // get truncated to make room for the date.
  const dateText = opts.postedAt
    ? `· ${opts.postedAt.toLocaleString('en-US', { month: 'short', day: 'numeric' })}`
    : ''
  // Name part stays bold. Truncated with `…` to fit the narrow column
  // so a long display name never crosses into the top-right image and
  // looks like it overflows the card. The date no longer lives on this
  // line, so the full narrow width is available.
  const fullName = cleanShownName
    ? `${cleanShownName} (@${cleanUsername}) on CAW`
    : `@${cleanUsername} on CAW`
  const bylineCharBudget = approxCharsPerPx(CARD_BYLINE_FS, CARD_NARROW_W)
  const namePart = fullName.length > bylineCharBudget && bylineCharBudget > 4
    ? fullName.slice(0, bylineCharBudget - 1).trimEnd() + '…'
    : fullName

  const host = getHostname()
  const headerText = host ? `CAW – ${host}` : 'CAW – Decentralized Network'

  // Wrap the body. Header + byline take 2 lines; we cap the total
  // (text + blanks) at 10 lines, so content gets up to 8 lines —
  // INCLUDING blank lines from the source. With a poll we leave more
  // room for the bars (5 content lines max).
  // Empty paragraphs from the source render as blank lines and count
  // toward this cap, so a caw with multiple paragraph breaks naturally
  // gets less rendered prose.
  const totalContentLines = opts.poll && opts.poll.options.length > 0 ? 5 : 8
  const wideChars = approxCharsPerPx(CARD_BODY_FS, CARD_WIDE_W)

  // Up to 4 poll options, ordered by votes desc — needed for height calc.
  const pollOptions = (opts.poll?.options ?? []).slice().sort((a, b) => b.votes - a.votes).slice(0, 4)
  const totalVotes = opts.poll?.totalVotes ?? pollOptions.reduce((n, o) => n + o.votes, 0)
  const pollHeight = pollOptions.length > 0
    ? pollOptions.length * POLL_BAR_H + (pollOptions.length - 1) * POLL_BAR_GAP + 28  // 28 = "N votes" footer
    : 0

  // Two-pass wrap. First we wrap with the DEFAULT narrow width to get
  // a rough text-block height; that determines how big the corner
  // image grows. If the image grew past its default size, the narrow
  // column is squeezed and we re-wrap. Cards where the image stays at
  // CARD_IMG_SZ skip the second pass.
  const computeNarrowChars = (imgPx: number) => {
    const narrowPx = W - CARD_STRIP_W - CARD_MARGIN - imgPx - CARD_NARROW_RIGHT_PAD - CARD_MARGIN
    return approxCharsPerPx(CARD_BODY_FS, Math.max(200, narrowPx))
  }
  // Will the bottom stat row render? (any non-zero count.)
  const hasStats = !!opts.stats && (
    (opts.stats.likes && opts.stats.likes !== '0') ||
    (opts.stats.recaws && opts.stats.recaws !== '0') ||
    (opts.stats.replies && opts.stats.replies !== '0') ||
    (opts.stats.views && opts.stats.views !== '0')
  )
  const STATS_ROW_H = 16 + 30  // marginTop + ~one line of 22px text + cushion
  const computeHeight = (narrowLines: number, wideLines: number) => {
    let h = CARD_MARGIN_Y + CARD_HEADER_PX + CARD_BYLINE_PX
    if (narrowLines > 0) h += narrowLines * CARD_BODY_PX
    if (wideLines > 0)   h += wideLines * CARD_BODY_PX
    if (pollHeight > 0)  h += CARD_GAP_POLL + pollHeight
    if (hasStats)        h += STATS_ROW_H
    h += CARD_MARGIN_Y
    return h
  }
  // Image grows with text height, but the layout is fixed at 3 narrow
  // lines + the rest wide. So the image must NEVER extend past the
  // bottom of those 3 narrow lines, otherwise the wide content below
  // overlaps the image. Cap at: chrome (header + byline) + 3 body
  // lines, minus the top margin (image starts at top margin).
  const IMG_MAX_BY_LAYOUT = CARD_HEADER_PX + CARD_BYLINE_PX + 3 * CARD_BODY_PX - CARD_IMG_PAD
  const IMG_MAX_BY_WIDTH = Math.round(W * 0.24)
  const IMG_MAX = Math.min(IMG_MAX_BY_LAYOUT, IMG_MAX_BY_WIDTH)
  const computeImgSize = (cardHeight: number) => {
    if (!opts.cornerImage) return 0
    const fromHeight = cardHeight - 2 * CARD_MARGIN_Y
    return Math.min(Math.max(CARD_IMG_SZ, fromHeight), IMG_MAX)
  }

  // Layout is fixed at 3 narrow lines + the rest wide. The image is
  // CAPPED so its bottom never extends past line 3 of the narrow
  // section (see IMG_MAX above), which means wide content below it
  // never overlaps. Two-pass wrap re-runs after the image grows in
  // case the narrow column needs to shrink to fit the wider image.
  const NARROW_LINES = 3

  // Pass 1: default narrow width.
  let narrowChars = computeNarrowChars(CARD_IMG_SZ)
  let contentLines = wrapCawContent(cleanText, narrowChars, wideChars, NARROW_LINES, totalContentLines)
  let narrowContent = contentLines.slice(0, NARROW_LINES)
  let wideContent = contentLines.slice(NARROW_LINES, totalContentLines)
  let textHeight = computeHeight(narrowContent.length, wideContent.length)
  let imageSlotMinHeight = opts.cornerImage ? CARD_MARGIN_Y + CARD_IMG_SZ + CARD_IMG_PAD : 0
  let height = Math.min(CARD_MAX_H, Math.max(textHeight, imageSlotMinHeight, CARD_MIN_H))
  let imgSize = computeImgSize(height)

  // Pass 2: image grew → narrow column shrinks → re-wrap with the
  // tighter narrow budget. Image size stays from pass 1 so the layout
  // doesn't oscillate.
  if (imgSize > CARD_IMG_SZ) {
    narrowChars = computeNarrowChars(imgSize)
    contentLines = wrapCawContent(cleanText, narrowChars, wideChars, NARROW_LINES, totalContentLines)
    narrowContent = contentLines.slice(0, NARROW_LINES)
    wideContent = contentLines.slice(NARROW_LINES, totalContentLines)
    textHeight = computeHeight(narrowContent.length, wideContent.length)
    imageSlotMinHeight = CARD_MARGIN_Y + imgSize + CARD_IMG_PAD
    height = Math.min(CARD_MAX_H, Math.max(textHeight, imageSlotMinHeight, CARD_MIN_H))
  }
  // Render-time narrow column width — the visible cap for header /
  // byline / narrow content lines.
  const narrowRenderW = W - CARD_STRIP_W - CARD_MARGIN - imgSize - CARD_NARROW_RIGHT_PAD - CARD_MARGIN

  return {
    height,
    tree: {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: '100%',
          height: '100%',
          backgroundColor: opts.backgroundColor,
          color: '#ffffff',
          fontFamily: 'Inter',
          position: 'relative',
        },
        children: [
          // Left yellow strip — full height of THIS card.
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                position: 'absolute',
                top: 0,
                left: 0,
                width: CARD_STRIP_W,
                height,
                backgroundColor: CAW_GOLD,
              },
            },
          },
          // Top-right corner image (square, center-cropped).
          opts.cornerImage ? {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                position: 'absolute',
                top: CARD_MARGIN_Y,
                right: CARD_MARGIN,
                width: imgSize,
                height: imgSize,
                borderRadius: 12,
                overflow: 'hidden',
                backgroundColor: '#1a1a1a',
              },
              children: [
                {
                  type: 'img',
                  props: {
                    src: opts.cornerImage,
                    width: imgSize,
                    height: imgSize,
                    style: { objectFit: 'cover' },
                  },
                },
              ],
            },
          } : null,
          // Text column.
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                position: 'absolute',
                top: CARD_MARGIN_Y,
                left: CARD_TEXT_X,
                right: CARD_MARGIN,
                bottom: CARD_MARGIN_Y,
              },
              children: [
                // Line 1: protocol header (host) + optional date suffix.
                // Date lives here (chrome together) so the byline below
                // gets the full narrow width for the author name.
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'baseline',
                      fontSize: CARD_HEADER_FS,
                      lineHeight: CARD_LINE_H,
                      maxWidth: narrowRenderW,
                      whiteSpace: 'nowrap',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            fontWeight: 700,
                            color: CAW_GOLD,
                            whiteSpace: 'nowrap',
                          },
                          children: headerText,
                        },
                      },
                      dateText ? {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            flexDirection: 'row',
                            alignItems: 'baseline',
                            marginLeft: 10,
                            whiteSpace: 'nowrap',
                          },
                          children: [
                            {
                              type: 'div',
                              props: {
                                style: {
                                  display: 'flex',
                                  fontSize: CARD_HEADER_FS,
                                  fontWeight: 400,
                                  color: '#9ca3af',
                                  whiteSpace: 'nowrap',
                                },
                                children: '·',
                              },
                            },
                            {
                              type: 'div',
                              props: {
                                style: {
                                  display: 'flex',
                                  fontSize: Math.round(CARD_HEADER_FS * 0.75),
                                  fontWeight: 400,
                                  color: '#9ca3af',
                                  whiteSpace: 'nowrap',
                                  marginLeft: 6,
                                },
                                // Strip the leading `· ` since we now
                                // render the dot as its own segment.
                                children: dateText.replace(/^[ ]?·\s*/, ''),
                              },
                            },
                          ],
                        },
                      } : null,
                    ].filter(Boolean) as any,
                  },
                },
                // Line 2: byline (author name only). The date used to
                // live here too — it moved to line 1 so a long display
                // name no longer competes with it for the narrow column.
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'row',
                      fontSize: CARD_BYLINE_FS,
                      lineHeight: CARD_LINE_H,
                      // No margin between header and byline — at the
                      // unified 30px text size, line-height alone gives
                      // the right breathing room and the whole header
                      // stack reads as one paragraph.
                      maxWidth: narrowRenderW,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            fontWeight: 700,
                            color: '#ffffff',
                            whiteSpace: 'nowrap',
                          },
                          children: namePart,
                        },
                      },
                      // (Date suffix moved to line 1 next to the domain.)
                    ],
                  },
                },
                // Narrow content (alongside image). Inline tokenization
                // colors hashtags / cashtags / links gold so they pop
                // off the body copy.
                narrowContent.length > 0 ? {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      fontSize: CARD_BODY_FS,
                      lineHeight: CARD_LINE_H,
                      // No top margin — header / byline / content all
                      // share the same line-height so the whole text
                      // block reads as one paragraph.
                      maxWidth: narrowRenderW,
                    },
                    children: narrowContent.map((line, i) => lineNode(line, {
                      fontSize: CARD_BODY_FS,
                      bodyColor: '#f3f4f6',
                      goldColor: CAW_GOLD,
                      maxWidth: narrowRenderW,
                      key: `n${i}`,
                    })),
                  },
                } : null,
                // Wide content (below image).
                wideContent.length > 0 ? {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      fontSize: CARD_BODY_FS,
                      lineHeight: CARD_LINE_H,
                      marginTop: narrowContent.length > 0 ? CARD_GAP_WIDE : CARD_GAP_NARROW,
                      maxWidth: CARD_WIDE_W,
                    },
                    children: wideContent.map((line, i) => lineNode(line, {
                      fontSize: CARD_BODY_FS,
                      bodyColor: '#f3f4f6',
                      goldColor: CAW_GOLD,
                      maxWidth: CARD_WIDE_W,
                      key: `w${i}`,
                    })),
                  },
                } : null,
                // Poll bars at the bottom (if any). Width narrows to
                // 75% of the wide column when the content is short
                // (≤ 2 lines) so a one-line caw + small poll doesn't
                // look like a wall of bars.
                pollOptions.length > 0 ? pollNode(pollOptions, totalVotes, contentLines.length > 0, contentLines.length) : null,
                // Stat row at the very bottom — replies / recaws /
                // likes / views. Hides any zero-count stat so a
                // brand-new caw doesn't show "0 0 0 0".
                opts.stats ? statsRow(opts.stats) : null,
              ].filter(Boolean) as any,
            },
          },
        ].filter(Boolean) as any,
      },
    },
  }
}

// Bottom stat row. Compact, gray, near the body color so the eye
// reads it as metadata rather than competing with the body copy.
// Each stat is icon + count; counts come pre-bucketed (1.2K not 1247).
// Stat-row icons. Match the FeedItem footer:
//   • Reply  — heroicons HiOutlineChat
//   • Recaw  — the project's recaw.svg (Layer_2 paths only)
//   • Like   — heroicons HiOutlineHeart
//   • View   — heroicons HiOutlineEye
// Embedded as inline SVG strings so satori can render them via
// <img src=data:image/svg+xml;...> at the exact pixel size of the
// surrounding text. `currentColor` is replaced at build time with
// the gray we use for the row.
const STAT_ICON_COLOR = '#9ca3af'
function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`
}
function statsRow(stats: { likes: string; recaws: string; replies: string; views: string }) {
  // SVG sources — paths copied from heroicons outline (24x24) and the
  // project's recaw.svg. Stroke uses the row's text color so they
  // visually match the gray count number next to them.
  const c = STAT_ICON_COLOR
  const replyIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`
  const recawIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-miterlimit="10"><path d="M1.2,9l3.2-3.1c0.1-0.1,0.2-0.1,0.3,0L7.8,9"/><path d="M4.6,5.9l0,10.5c0,0,0,3.4,3,3.4h5.8"/><path d="M22.5,16.6l-3.2,3.1c-0.1,0.1-0.2,0.1-0.3,0l-3.1-3.1"/><path d="M19.2,19.7l0-10.5c0,0,0-3.4-3-3.4h-5.8"/></svg>`
  const likeIcon  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`
  const viewIcon  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`

  const items: Array<{ src: string; value: string }> = []
  if (stats.replies && stats.replies !== '0') items.push({ src: svgDataUri(replyIcon), value: stats.replies })
  if (stats.recaws  && stats.recaws  !== '0') items.push({ src: svgDataUri(recawIcon), value: stats.recaws })
  if (stats.likes   && stats.likes   !== '0') items.push({ src: svgDataUri(likeIcon),  value: stats.likes })
  if (stats.views   && stats.views   !== '0') items.push({ src: svgDataUri(viewIcon),  value: stats.views })
  if (items.length === 0) return null

  const ICON_PX = 22
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        // marginTop: auto pushes the row to the bottom of the parent
        // flex column. So on a short caw the space between the body
        // text and the stat row grows; on a tall caw the row sits
        // right under the content as before. Either way, the stats
        // anchor to the visual bottom of the card.
        marginTop: 'auto',
        // Right-align the stats so they sit under the corner image
        // rather than competing with the body text on the left.
        justifyContent: 'flex-end',
        gap: 28,
        fontSize: 22,
        color: STAT_ICON_COLOR,
        alignItems: 'center',
      },
      children: items.map((it, i) => ({
        type: 'div',
        key: `st${i}`,
        props: {
          style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 },
          children: [
            {
              type: 'img',
              props: {
                src: it.src,
                width: ICON_PX,
                height: ICON_PX,
                style: { display: 'flex' },
              },
            },
            { type: 'div', props: { style: { display: 'flex' }, children: it.value } },
          ],
        },
      })),
    },
  }
}

// Image-only layout: no body text, just the header / byline lines at
// the top and a big square image below. Image takes the full text-
// column width (everything between the strip+margin and the right
// margin). Card height = chrome + image + margin. Reads as a photo
// card rather than a tiny corner thumbnail with empty text space.
function planImageOnlyCard(opts: {
  cleanShownName: string
  cleanUsername: string
  cornerImage: string | null
  backgroundColor: string
  postedAt?: Date | null
  stats?: { likes: string; recaws: string; replies: string; views: string }
}): { tree: any; height: number } {
  // Reuse the standard canvas width for consistency with text cards.
  // The aspect-ratio cap below keeps the card from going taller than
  // a 1.5:1 (W/H) ratio so OG previews don't letterbox awkwardly.
  const cardW = W
  const dateText = opts.postedAt
    ? `${String.fromCharCode(0xa0)}· ${opts.postedAt.toLocaleString('en-US', { month: 'short', day: 'numeric' })}`
    : ''
  const fullName = opts.cleanShownName
    ? `${opts.cleanShownName} (@${opts.cleanUsername}) on CAW`
    : `@${opts.cleanUsername} on CAW`
  const imageW = cardW - CARD_TEXT_X - CARD_MARGIN
  // Card aspect must be >= 1.5 (W/H) so OG previews never letterbox
  // weird on platforms that prefer landscape. Compute the maximum
  // image height that keeps the WHOLE card at >= 1.5 aspect:
  //   card_h = chrome + image_h + margin
  //   card_w / card_h >= 1.5  →  image_h <= card_w/1.5 - chrome - margin
  const chromePx = CARD_MARGIN_Y + CARD_HEADER_PX + CARD_BYLINE_PX + 12
  const maxImageH = Math.round(cardW / 1.5) - chromePx - CARD_MARGIN_Y
  const dims = opts.cornerImage ? dataUriDimensions(opts.cornerImage) : null
  let imageH = Math.min(imageW, maxImageH)
  if (dims && dims.w > 0 && dims.h > 0) {
    const aspect = dims.h / dims.w  // < 1 for landscape, > 1 for portrait
    const naturalH = Math.round(imageW * aspect)
    imageH = Math.min(naturalH, maxImageH)
  }
  imageH = Math.max(imageH, 200)
  // Trim 10% off the image height — image-only cards looked a touch
  // tall for the share-card slot. Image gets cropped (objectFit:
  // cover) so the photo's center stays in frame.
  imageH = Math.round(imageH * 0.9)
  const host = getHostname()
  const headerText = host ? `CAW – ${host}` : 'CAW – Decentralized Network'
  // Reserve room for the stat row at the bottom (only when any
  // non-zero stat exists). Same constants as the text-card path.
  const hasStats = !!opts.stats && (
    (opts.stats.likes && opts.stats.likes !== '0') ||
    (opts.stats.recaws && opts.stats.recaws !== '0') ||
    (opts.stats.replies && opts.stats.replies !== '0') ||
    (opts.stats.views && opts.stats.views !== '0')
  )
  const STATS_ROW_H = 16 + 30
  const height = CARD_MARGIN_Y + CARD_HEADER_PX + CARD_BYLINE_PX + 12 + imageH + (hasStats ? STATS_ROW_H : 0) + CARD_MARGIN_Y

  return {
    height,
    tree: {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: '100%',
          height: '100%',
          backgroundColor: opts.backgroundColor,
          color: '#ffffff',
          fontFamily: 'Inter',
          position: 'relative',
        },
        children: [
          // Yellow strip.
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                position: 'absolute',
                top: 0,
                left: 0,
                width: CARD_STRIP_W,
                height,
                backgroundColor: CAW_GOLD,
              },
            },
          },
          // Stacked text + image.
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                position: 'absolute',
                top: CARD_MARGIN_Y,
                left: CARD_TEXT_X,
                right: CARD_MARGIN,
                bottom: CARD_MARGIN_Y,
              },
              children: [
                // Line 1: protocol header (host) + optional date suffix.
                // Mirror text-card layout — date sits next to the domain.
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'baseline',
                      fontSize: CARD_HEADER_FS,
                      lineHeight: CARD_LINE_H,
                      whiteSpace: 'nowrap',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: { display: 'flex', fontWeight: 700, color: CAW_GOLD, whiteSpace: 'nowrap' },
                          children: headerText,
                        },
                      },
                      dateText ? {
                        type: 'div',
                        props: {
                          style: { display: 'flex', flexDirection: 'row', alignItems: 'baseline', marginLeft: 10, whiteSpace: 'nowrap' },
                          children: [
                            {
                              type: 'div',
                              props: {
                                style: { display: 'flex', fontSize: CARD_HEADER_FS, fontWeight: 400, color: '#9ca3af', whiteSpace: 'nowrap' },
                                children: '·',
                              },
                            },
                            {
                              type: 'div',
                              props: {
                                style: {
                                  display: 'flex',
                                  fontSize: Math.round(CARD_HEADER_FS * 0.75),
                                  fontWeight: 400,
                                  color: '#9ca3af',
                                  whiteSpace: 'nowrap',
                                  marginLeft: 6,
                                },
                                children: dateText.replace(/^[ ]?·\s*/, ''),
                              },
                            },
                          ],
                        },
                      } : null,
                    ].filter(Boolean) as any,
                  },
                },
                // Line 2: byline (author name only).
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      flexDirection: 'row',
                      fontSize: CARD_BYLINE_FS,
                      lineHeight: CARD_LINE_H,
                      whiteSpace: 'nowrap',
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: { display: 'flex', fontWeight: 700, color: '#ffffff', whiteSpace: 'nowrap' },
                          children: fullName,
                        },
                      },
                    ],
                  },
                },
                // Image — square, full text-column width, slight gap
                // below the byline.
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      width: imageW,
                      height: imageH,
                      marginTop: 12,
                      borderRadius: 12,
                      overflow: 'hidden',
                      backgroundColor: '#1a1a1a',
                    },
                    children: [
                      {
                        type: 'img',
                        props: {
                          src: opts.cornerImage,
                          width: imageW,
                          height: imageH,
                          style: { objectFit: 'cover' },
                        },
                      },
                    ],
                  },
                },
                // Stat row anchored to the card bottom — same shape
                // as the text-card path (marginTop: auto pushes it
                // past any extra vertical space).
                opts.stats ? statsRow(opts.stats) : null,
              ].filter(Boolean) as any,
            },
          },
        ],
      },
    },
  }
}

// Render the poll-bars block. Bars stretch to the wide content width so
// they read clearly even on narrow cards. Winner gets gold fill;
// runners-up get a muted gold so the eye lands on the leader.
function pollNode(options: PollOption[], totalVotes: number, hasContentAbove: boolean, contentLineCount: number) {
  const safeTotal = Math.max(1, totalVotes)
  // Only highlight a unique leader. If two or more options tie at the
  // top (or no votes yet), nobody gets the gold fill — otherwise every
  // bar lights up and the eye has nowhere to land.
  const winnerVotes = options[0]?.votes ?? 0
  const winnerCount = options.filter(o => o.votes === winnerVotes).length
  const hasUniqueWinner = winnerVotes > 0 && winnerCount === 1
  // Short caws (≤ 2 content lines) look unbalanced when the poll
  // stretches the full wide-column. Pull it in to 75% so the card
  // visually clusters tighter.
  const pollMaxWidth = contentLineCount <= 2
    ? Math.round(CARD_WIDE_W * 0.75)
    : CARD_WIDE_W
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        marginTop: hasContentAbove ? CARD_GAP_POLL : CARD_GAP_NARROW,
        maxWidth: pollMaxWidth,
        width: pollMaxWidth,
      },
      children: [
        ...options.map((opt, i) => {
          const pct = Math.max(0, Math.min(100, Math.round((opt.votes / safeTotal) * 100)))
          const isWinner = hasUniqueWinner && opt.votes === winnerVotes
          return {
            type: 'div',
            key: `pb${i}`,
            props: {
              style: {
                display: 'flex',
                position: 'relative',
                height: POLL_BAR_H,
                marginTop: i === 0 ? 0 : POLL_BAR_GAP,
                backgroundColor: POLL_TRACK_BG,
                borderRadius: 6,
                overflow: 'hidden',
              },
              children: [
                // Fill bar (absolute so the label sits on top).
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      bottom: 0,
                      width: `${pct}%`,
                      backgroundColor: isWinner ? POLL_FILL_WIN : POLL_FILL,
                    },
                  },
                },
                // Label (left) + percent (right).
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      position: 'absolute',
                      top: 0,
                      left: POLL_LABEL_PAD_X,
                      right: POLL_LABEL_PAD_X,
                      bottom: 0,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: POLL_LABEL_FS,
                      color: isWinner ? '#000000' : '#f3f4f6',
                      fontWeight: 600,
                    },
                    children: [
                      {
                        type: 'div',
                        props: {
                          style: {
                            display: 'flex',
                            overflow: 'hidden',
                            whiteSpace: 'nowrap',
                            textOverflow: 'ellipsis',
                            maxWidth: '70%',
                          },
                          children: stripUnrenderable(opt.label) || `Option ${i + 1}`,
                        },
                      },
                      {
                        type: 'div',
                        props: {
                          style: { display: 'flex' },
                          children: `${pct}%`,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }
        }),
        // Vote count footer.
        {
          type: 'div',
          key: 'pf',
          props: {
            style: {
              fontSize: 18,
              color: '#9ca3af',
              marginTop: 6,
            },
            children: `${totalVotes.toLocaleString()} ${totalVotes === 1 ? 'vote' : 'votes'}`,
          },
        },
      ],
    },
  }
}

// Hashtag card — big #tag (white), usage count below, brand lockup at
// the bottom. Lockup uses the same logo + gold wordmark as the page.
function hashtagCardTree(opts: { tag: string; usageCount: number; locale?: string | null }) {
  const tt = (key: string, vars?: { count?: number }) =>
    i18nT(opts.locale ?? null, key, vars)
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
                    ? i18nT(opts.locale ?? null, 'og.hashtag.caws_on_caw', {
                        count: opts.usageCount,
                        display: opts.usageCount.toLocaleString(),
                      })
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

// Shared brand subhead — appears under the CAW wordmark on the default
// card AND every static-page card. Kept in sync with BRAND_TITLE in
// spaPrerender.ts (which is the og:title text social platforms render
// alongside the image). Change them together.
const BRAND_SUBHEAD = 'Decentralized & Censorship Resistant'

// Slug → English page title shown as the H2 on the static-page share card.
// Slugs map 1:1 to URL paths in spaPrerender.ts. Keep this list and the
// spaPrerender path table in lockstep.
//
// Future: thread these through the i18n catalog so /es/help/manifesto
// renders the Spanish heading. Untranslated for v1 because the tab labels
// themselves aren't in the en.json under a clean key per tab — adding
// them is a separate change.
const STATIC_PAGE_TITLES: Record<string, string> = {
  'help': 'Help & Resources',
  'help-faq': 'Frequently Asked Questions',
  'help-history': 'History',
  'help-manifesto': 'Manifesto',
  'help-gettingstarted': 'Getting Started',
  'help-developers': 'For Developers',
  'help-resources': 'Resources',
  'staking': 'CAW Staking',
  'usernames': 'Profile Marketplace',
  'explore': 'Explore',
  'settings': 'Settings',
  'settings-account': 'Account',
  'settings-notifications': 'Notifications',
  'settings-language': 'Language',
  'settings-muted': 'Muted Content',
  'settings-session-keys': 'Quick Sign',
  'notifications': 'Notifications',
  'bookmarks': 'Bookmarks',
  'scheduled': 'Scheduled Posts',
  'messages': 'Messages',
  'search': 'Search Results',
  'faucet': 'Testnet Faucet',
  'welcome': 'Welcome to CAW',
}

// Static-page card — same chrome as the default card (CAW logo + wordmark
// + brand subhead) with one extra line: the page title. Used for routes
// where there's no dynamic per-entity data (help/staking/settings/etc.).
function staticCardTree(opts: { title: string }) {
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
                        width: 160,
                        height: 160,
                        style: { objectFit: 'contain' },
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 180,
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
                  style: { fontSize: 32, color: '#9ca3af', marginTop: 24 },
                  children: BRAND_SUBHEAD,
                },
              },
              // Per-page H2 — the whole reason this card exists. Sized large
              // enough to read in a Twitter card but small enough that the
              // brand chrome still anchors the visual.
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 72,
                    fontWeight: 700,
                    color: '#ffffff',
                    marginTop: 40,
                    letterSpacing: '-0.01em',
                    textAlign: 'center',
                  },
                  children: opts.title,
                },
              },
            ],
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
                  children: BRAND_SUBHEAD,
                },
              },
            ],
          },
        },
      ],
    },
  }
}

async function renderToPng(tree: any, height: number = H): Promise<Buffer> {
  const fonts = loadFonts()
  const svg = await satori(tree as any, {
    width: W,
    height,
    fonts,
    // Satori asks us to resolve any character it can't render with
    // the loaded fonts. For emoji it passes code='emoji' and the
    // grapheme; we serve a Twemoji SVG (free, MIT, Twitter's color
    // emoji set). The COLR/CPAL Noto Emoji we tried first isn't
    // supported by satori — only solid-color or image-based glyphs.
    loadAdditionalAsset: async (code: string, segment: string) => {
      if (code === 'emoji') return await loadTwemojiSvg(segment)
      return ''
    },
  } as any)
  // Render at 2x source resolution. Satori produces an SVG at the
  // logical card size (W × height); Resvg rasterizes at 2*W wide.
  // Downstream platforms (Twitter, Telegram, etc.) display the
  // image at smaller sizes anyway, so a 2x source survives a
  // bilinear downscale much better than a 1x render that gets
  // blown up by HiDPI displays. ~1ms cost per render, ~2-3x file
  // size — both well within budget for OG cards.
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } }).render().asPng()
  return png
}

// Twemoji disk cache (one SVG per codepoint sequence). Twemoji files
// live on jsdelivr at /gh/twitter/twemoji@latest/assets/svg/<codepoints>.svg
// — codepoints are hyphen-joined hex, with fe0f variation selectors
// stripped because Twemoji's filenames omit them.
const TWEMOJI_CACHE = path.join(CACHE_DIR, 'twemoji')
fs.mkdirSync(TWEMOJI_CACHE, { recursive: true })
async function loadTwemojiSvg(emoji: string): Promise<string> {
  const codepoints: string[] = []
  for (const ch of emoji) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp === 0xfe0f) continue
    codepoints.push(cp.toString(16))
  }
  if (codepoints.length === 0) return ''
  const slug = codepoints.join('-')
  const cacheFile = path.join(TWEMOJI_CACHE, `${slug}.svg`)
  try {
    if (fs.existsSync(cacheFile)) {
      const buf = fs.readFileSync(cacheFile)
      return `data:image/svg+xml;base64,${buf.toString('base64')}`
    }
    const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/${slug}.svg`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return ''
    fs.writeFileSync(cacheFile, buf)
    return `data:image/svg+xml;base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

// Read PNG width/height from the IHDR chunk. Per the PNG spec the file
// starts with an 8-byte signature, then a 4-byte length, then "IHDR",
// then width (uint32 BE) at byte 16 and height (uint32 BE) at byte 20.
// Returns null on any failure — we don't want a header read to break
// the render itself.
function readPngDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null
  // Cheap sanity check on the signature so we don't misread non-PNG bytes.
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  try {
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
    return { w, h }
  } catch {
    return null
  }
}

// Set custom response headers carrying the real PNG dimensions. The SPA
// prerender HEAD-probes these so meta tags can declare accurate
// og:image:width / og:image:height, which Facebook/Messenger validate
// strictly. CORS exposes them so cross-origin readers (other CAW mirrors
// resolving a peer's card) can use them too.
function setImageDimHeaders(res: any, w: number, h: number) {
  res.set('X-Image-Width', String(w))
  res.set('X-Image-Height', String(h))
  res.set('Access-Control-Expose-Headers', 'X-Image-Width, X-Image-Height')
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
      // Read just the 24-byte header so we can advertise real dims
      // without slurping the whole PNG into memory.
      try {
        const fd = fs.openSync(file, 'r')
        const head = Buffer.alloc(24)
        fs.readSync(fd, head, 0, 24, 0)
        fs.closeSync(fd)
        const dim = readPngDimensions(head)
        if (dim) setImageDimHeaders(res, dim.w, dim.h)
      } catch { /* best-effort — don't fail the response over headers */ }
      return res.sendFile(file)
    }
    const png = await build()
    fs.writeFileSync(file, png)
    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    const dim = readPngDimensions(png)
    if (dim) setImageDimHeaders(res, dim.w, dim.h)
    return res.send(png)
  } catch (err) {
    console.error(`[og] render failed for ${cacheKey}:`, err)
    return res.status(500).end()
  }
}

router.get('/image/profile/:username', async (req, res) => {
  const username = String(req.params.username).toLowerCase()
  // ?locale=<code> selects the chrome language; validated against the
  // catalog list so an unknown / malicious code falls back to English
  // rather than rendering with the key string as the label.
  const rawLocale = typeof req.query.locale === 'string' ? req.query.locale : ''
  const locale: string | null = rawLocale && hasLocale(rawLocale) && rawLocale !== 'en' ? rawLocale : null
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
  // when the displayed number changes (e.g. 999 → 1K). Locale is part of
  // the key — each language gets its own cached PNG.
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
  const cacheKey = `profile-${user.tokenId}-${locale || 'en'}-${inputHash}`

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
      locale,
    }))
  })
})

// Match image URLs in caw content. Two shapes:
//   1) /uploads/images/<8hex>.<ext>   — direct upload route output
//   2) /s/<code>.<ext>                — short-URL alias for the above
// Both can appear with our own host or any other CAW node's host (mirror
// network), so we don't pin the host in the regex. Detection only — the
// resolver below decides whether to actually fetch.
const CONTENT_IMAGE_RE = /(https?:\/\/[^\s]+(?:\/uploads\/images\/[a-zA-Z0-9_-]+|\/s\/[a-zA-Z0-9_-]+)\.(?:jpg|jpeg|png|gif|webp))/gi
const CONTENT_VIDEO_RE = /(https?:\/\/[^\s]+(?:\/uploads\/videos\/[a-zA-Z0-9_-]+|\/s\/[a-zA-Z0-9_-]+)\.(?:mp4|webm|mov|avi|mkv|ogg|ogv))/gi

// Pull the first image URL from a caw's content/imageData. Prefers
// imageData (cheap path used by the modern uploader), falls back to
// regex-scanning the content string (covers caws where the URL is
// freeform text — e.g. a `/s/<code>.png` short link).
function extractFirstImageUrl(caw: { content: string | null; hasImage: boolean; imageData: string | null }): string | null {
  if (caw.hasImage && caw.imageData?.startsWith('urls:')) {
    const urls = caw.imageData.replace(/^urls:/, '').split('|||').filter(Boolean)
    if (urls[0]) return urls[0]
  }
  const m = (caw.content || '').match(CONTENT_IMAGE_RE)
  return m?.[0] ?? null
}

// Same idea for the first video URL — videoData first, content URLs
// second. The uploaded videos always come back as urls:host/uploads/videos/...
function extractFirstVideoUrl(caw: { content: string | null; hasVideo: boolean; videoData: string | null }): string | null {
  if (caw.hasVideo && caw.videoData) {
    // videoData is `url1|||url2` (no urls: prefix — see actionHandlers.ts).
    const urls = caw.videoData.split('|||').filter(Boolean)
    if (urls[0]) return urls[0]
  }
  const m = (caw.content || '').match(CONTENT_VIDEO_RE)
  return m?.[0] ?? null
}

// First "regular" URL in the content — http(s) link that isn't one of
// our own image/video upload paths and isn't the poll-marker sidecar.
// Used as the candidate for og:image scraping. Hashtags / cashtags
// aren't URLs and won't match.
const CONTENT_PLAIN_URL_RE = /(https?:\/\/[^\s]+)/gi
function extractFirstPlainUrl(content: string | null): string | null {
  if (!content) return null
  for (const m of content.matchAll(CONTENT_PLAIN_URL_RE)) {
    const url = m[0]
    // Skip our own media URLs (already handled above).
    if (CONTENT_IMAGE_RE.test(url)) { CONTENT_IMAGE_RE.lastIndex = 0; continue }
    CONTENT_IMAGE_RE.lastIndex = 0
    if (CONTENT_VIDEO_RE.test(url)) { CONTENT_VIDEO_RE.lastIndex = 0; continue }
    CONTENT_VIDEO_RE.lastIndex = 0
    return url
  }
  return null
}

// Resolve a content URL to a fetchable image data URI, including
// /s/<code>.<ext> short-link aliases. For short links we look up the
// originalUrl directly in the DB instead of letting fetchImageDataUri
// follow the 302 — the redirect target's host might not match our SSRF
// allowlist (e.g. an external CDN), but the OWNER of the short link
// already curated that destination via POST /api/shorturl. Treating
// short-links as trusted for OG render is consistent with the /s/
// redirect itself.
// Resolve an arbitrary content URL to a preview image. Three tiers:
//   1. If it's a /s/<code> short URL, check the ShortUrl row's
//      cached imageUrl (set at link-creation time by the unfurl pass).
//      Cheapest — no network call.
//   2. If the short URL has no cached imageUrl, follow the redirect to
//      the originalUrl and og:image-scrape that.
//   3. Otherwise (non-short URL) og:image-scrape directly.
async function resolveLinkPreviewImage(rawUrl: string): Promise<string | null> {
  try {
    const u = new URL(rawUrl)
    const shortMatch = u.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)/)
    if (shortMatch) {
      const code = shortMatch[1]
      const row = await prisma.shortUrl.findUnique({
        where: { code },
        select: { originalUrl: true, imageUrl: true },
      })
      if (row?.imageUrl) {
        const fetched = await fetchImageDataUri(row.imageUrl)
        if (fetched) return fetched
      }
      if (row?.originalUrl) return await scrapeOgImageFromUrl(row.originalUrl)
      // Row not in local DB — let the live fetch follow the 302.
    }
  } catch { /* fall through */ }
  return await scrapeOgImageFromUrl(rawUrl)
}

async function resolveContentImage(rawUrl: string): Promise<string | null> {
  try {
    const u = new URL(rawUrl)
    const shortMatch = u.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)/)
    if (shortMatch) {
      const code = shortMatch[1]
      const row = await prisma.shortUrl.findUnique({ where: { code }, select: { originalUrl: true } })
      // If the short-url row exists locally, resolve to the real
      // destination (avoids one HTTP hop). Otherwise fall through to
      // letting fetch() follow the 302 — works whenever the
      // originating CAW node is reachable from this process.
      if (row) return await fetchImageDataUri(row.originalUrl)
    }
  } catch { /* fall through to direct fetch */ }
  return await fetchImageDataUri(rawUrl)
}

// Same shape as resolveContentImage, but for videos. Resolves /s/<code>
// short URLs against the local ShortUrl table when available, then
// extracts the first frame via ffmpeg.
async function resolveContentVideo(rawUrl: string): Promise<string | null> {
  try {
    const u = new URL(rawUrl)
    const shortMatch = u.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)/)
    if (shortMatch) {
      const code = shortMatch[1]
      const row = await prisma.shortUrl.findUnique({ where: { code }, select: { originalUrl: true } })
      if (row) return await extractVideoFirstFrame(row.originalUrl)
    }
  } catch { /* fall through */ }
  return await extractVideoFirstFrame(rawUrl)
}

router.get('/image/caw/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || id <= 0) return res.redirect(302, '/api/og/image/default')

  const caw = await prisma.caw.findUnique({
    where: { id },
    select: {
      id: true, content: true, status: true, createdAt: true,
      hasImage: true, imageData: true,
      hasVideo: true, videoData: true,
      // Live counters for the stat row at the bottom of the card.
      // Bucketed via fmtCount before they hit the cache key so the
      // PNG only re-renders when the displayed value changes (not
      // every individual interaction).
      likeCount: true,
      recawCount: true,
      commentCount: true,
      viewCount: true,
      user: {
        select: {
          tokenId: true, username: true, displayName: true,
          avatarUrl: true, defaultAvatarId: true,
        },
      },
      poll: {
        select: {
          options: true,
          totalVotes: true,
          id: true,
        },
      },
    },
  })
  // Render PENDING and SUCCESS — the post is publicly visible in
  // both states (the FE shows pending posts in author feeds), so OG
  // crawlers should see the same. FAILED / HIDDEN stay private.
  if (!caw || (caw.status !== 'SUCCESS' && caw.status !== 'PENDING')) {
    return res.redirect(302, '/api/og/image/default')
  }

  // Poll vote counts: aggregate per option since Poll.options is just
  // the labels and Poll.totalVotes is the running total. Done OUTSIDE
  // serveCachedOrRender so we can bake the bucketed counts into the
  // cache key — otherwise the cache would freeze the moment-of-first-
  // render counts forever.
  let pollData: { options: PollOption[]; totalVotes: number } | null = null
  if (caw.poll && caw.poll.options.length > 0) {
    const counts = await prisma.vote.groupBy({
      by: ['optionIndex'],
      where: { pollId: caw.poll.id, pending: false },
      _count: { _all: true },
    })
    const countByIndex = new Map<number, number>()
    for (const row of counts) countByIndex.set(row.optionIndex, row._count._all)
    pollData = {
      options: caw.poll.options.map((label, i) => ({
        label,
        votes: countByIndex.get(i) ?? 0,
      })),
      totalVotes: caw.poll.totalVotes,
    }
  }

  // Bucket all live counters via fmtCount so the cache key only
  // changes when the displayed value changes (999 → 1K, not every
  // single new like). Card stats picked up from the bucket for the
  // displayed strings too — see planCawCard's stats opt.
  const stats = {
    likes:    fmtCount(caw.likeCount),
    recaws:   fmtCount(caw.recawCount),
    replies:  fmtCount(caw.commentCount),
    views:    fmtCount(caw.viewCount),
  }
  // Per-option vote percentages bucketed at 1% granularity for the
  // cache hash — same level of detail the bars actually show.
  const pollHash = pollData
    ? pollData.options.map(o => Math.round((o.votes / Math.max(1, pollData!.totalVotes)) * 100)).join(',') + `|${fmtCount(pollData.totalVotes)}`
    : ''
  const liveHash = crypto.createHash('sha1')
    .update([stats.likes, stats.recaws, stats.replies, stats.views, pollHash].join('|'))
    .digest('hex').slice(0, 8)

  // v11 = date moved to header line + right-aligned stats + doubled
  // vertical margins + tighter narrow column → text-image gap.
  // PENDING caws include status so a later SUCCESS/HIDDEN flip
  // doesn't serve a stale render.
  const cacheKey = caw.status === 'PENDING'
    ? `caw-v11-${caw.id}-${liveHash}-pending`
    : `caw-v11-${caw.id}-${liveHash}`
  return serveCachedOrRender(res, cacheKey, async () => {
    // Strip media URLs and poll markers out of the visible text — the
    // corner image and the rendered poll bars already represent them,
    // and the bare URL/marker is noisy. Preserve original newline
    // structure (including multiple blank lines) so the card mirrors
    // the author's intended pacing.
    let visibleText = stripPollMarker(caw.content || '')
      .replace(CONTENT_IMAGE_RE, '')
      .replace(CONTENT_VIDEO_RE, '')
      .trim()

    // Corner image priority chain (each tier is a network/process call,
    // so we short-circuit as soon as one yields bytes):
    //   1. caw image (direct upload OR short-link alias OR content URL)
    //   2. caw video → first frame via ffmpeg
    //   3. og:image scrape from any other URL in the content
    //   4. user avatar (always succeeds — has a deterministic local fallback)
    let cornerImage: string | null = null
    const imageUrl = extractFirstImageUrl(caw)
    if (imageUrl) cornerImage = await resolveContentImage(imageUrl)
    if (!cornerImage) {
      const videoUrl = extractFirstVideoUrl(caw)
      if (videoUrl) cornerImage = await resolveContentVideo(videoUrl)
    }
    if (!cornerImage) {
      const linkUrl = extractFirstPlainUrl(caw.content)
      if (linkUrl) cornerImage = await resolveLinkPreviewImage(linkUrl)
    }
    if (!cornerImage) cornerImage = await resolveAvatarDataUri(caw.user)

    const planArgs = {
      displayName: caw.user.displayName || '',
      username: caw.user.username,
      text: visibleText,
      poll: pollData,
      backgroundColor: cardBgFor(caw.id),
      postedAt: caw.createdAt,
      stats,
    }
    const { tree, height } = planCawCard({ ...planArgs, cornerImage })
    try {
      return await renderToPng(tree, height)
    } catch (err: any) {
      // Satori sometimes can't decode certain image formats (notably
      // some webp variants) and throws inside its image preprocessor.
      // Re-plan without the corner image rather than 500ing — the
      // text portion of the card is the load-bearing part.
      console.warn(`[og] satori render failed for caw ${caw.id} with corner image, retrying without:`, err?.message ?? err)
      const fallback = planCawCard({ ...planArgs, cornerImage: null })
      return await renderToPng(fallback.tree, fallback.height)
    }
  })
})

router.get('/image/hashtag/:tag', async (req, res) => {
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '')
  if (!tag || !/^[\w-]+$/.test(tag)) return res.redirect(302, '/api/og/image/default')
  const rawLocale = typeof req.query.locale === 'string' ? req.query.locale : ''
  const locale: string | null = rawLocale && hasLocale(rawLocale) && rawLocale !== 'en' ? rawLocale : null
  const hashtag = await prisma.hashtag.findUnique({
    where: { name: tag },
    select: { name: true, displayName: true, usageCount: true },
  })
  // Cache key includes count so the card updates as the tag grows. Bucketed
  // so we don't blow the cache every single new caw — bumps every order of
  // magnitude (1 → 10 → 100 → 1000 → ...). Locale included so each
  // language's chrome is cached separately.
  const count = hashtag?.usageCount ?? 0
  const bucket = count === 0 ? 0 : Math.floor(Math.log10(count))
  const cacheKey = `hashtag-${tag}-${locale || 'en'}-${bucket}`
  // Render with original casing when we have it; URL still uses lowercase.
  const displayTag = hashtag?.displayName || hashtag?.name || tag
  return serveCachedOrRender(res, cacheKey, () => renderToPng(hashtagCardTree({
    tag: displayTag, usageCount: count, locale,
  })))
})

router.get('/image/default', async (_req, res) => {
  return serveCachedOrRender(res, 'default', () => renderToPng(defaultCardTree()))
})

router.get('/image/static/:slug', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase()
  const title = STATIC_PAGE_TITLES[slug]
  // Unknown slug → fall through to the default card. Avoids rendering
  // an empty-H2 card if a stale link points at a removed page.
  if (!title) return res.redirect(302, '/api/og/image/default')
  return serveCachedOrRender(res, `static-${slug}`, () =>
    renderToPng(staticCardTree({ title })),
  )
})

export default router
