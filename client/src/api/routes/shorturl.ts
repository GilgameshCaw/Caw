import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { publicUrl } from '../util/publicUrl'
import { isSafePublicUrl } from '../util/ssrfGuard'

const router = Router()

// Short URLs use the install's public URL — same env var (SHORTURL_DOMAIN)
// also drives og:url / og:image absolute paths in the prerender layer.
function getShortUrlDomain(): string {
  return publicUrl()
}

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'shorturl', domain: getShortUrlDomain() })
})

// Characters for base62 encoding (a-z, A-Z, 0-9)
const BASE62_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// File extensions to preserve for rendering hints
const PRESERVED_EXTENSIONS = ['.gif', '.jpg', '.jpeg', '.png', '.webp', '.mp4', '.webm', '.mov']

// Extract file extension from URL if it's a media type we want to preserve
function getExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    for (const ext of PRESERVED_EXTENSIONS) {
      if (pathname.endsWith(ext)) {
        return ext
      }
    }
  } catch {}
  return ''
}

// If the input is itself a /s/CODE URL, look up the existing entry instead
// of creating a new one. Without this check, re-shortening a short URL
// chains them: short → short → short, and the feed renderer eventually
// resolves the chain to a short URL that gets displayed as link text
// instead of the user's original long URL.
async function findExistingShortUrlByCode(url: string): Promise<{ code: string; originalUrl: string; title: string | null; description: string | null; imageUrl: string | null; siteName: string | null } | null> {
  const m = url.match(/\/s\/([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?)(?:[\?#].*)?$/)
  if (!m) return null
  const code = m[1]
  return prisma.shortUrl.findUnique({ where: { code } })
}

// Generate a random short code
function generateShortCode(length: number = 6): string {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += BASE62_CHARS[Math.floor(Math.random() * BASE62_CHARS.length)]
  }
  return code
}

// SSRF guard moved to ../util/ssrfGuard (`isSafePublicUrl`). The local
// `isPrivateUrl` left here for any synchronous callers that haven't been
// migrated yet — but new code should prefer the DNS-resolving version,
// which catches the "public hostname with A-record pointing at 127.0.0.1"
// rebinding pattern that this string-only check misses.
function isPrivateUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true
    if (hostname === '0.0.0.0' || hostname === '[::1]') return true
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true
    const parts = hostname.split('.').map(Number)
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      if (parts[0] === 10) return true                                         // 10.0.0.0/8
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true   // 172.16.0.0/12
      if (parts[0] === 192 && parts[1] === 168) return true                    // 192.168.0.0/16
      if (parts[0] === 169 && parts[1] === 254) return true                    // 169.254.0.0/16 (link-local/cloud metadata)
    }
    return false
  } catch {
    return true // Block on parse failure
  }
}

// Extract Open Graph metadata from a URL
async function extractMetadata(url: string): Promise<{
  title?: string
  description?: string
  imageUrl?: string
  siteName?: string
}> {
  try {
    // DNS-resolving SSRF check — catches the case where a public-looking
    // hostname has an A-record pointing at a private IP (the common
    // rebinding-via-single-A-record pattern). String-based
    // `isPrivateUrl` misses this entirely.
    if (!(await isSafePublicUrl(url))) return {}

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000) // 5s timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CAWBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    })
    clearTimeout(timeout)

    if (!response.ok) {
      return {}
    }

    const html = await response.text()

    // Extract Open Graph tags
    const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
                    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1]
    const ogDescription = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
                          html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i)?.[1]
    const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
                    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1]
    const ogSiteName = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
                       html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i)?.[1]

    // Fallback to standard meta tags
    const title = ogTitle || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
    const description = ogDescription ||
                        html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i)?.[1]

    // Extract site name from URL if not found
    const siteName = ogSiteName || new URL(url).hostname.replace(/^www\./, '')

    return {
      title: title?.trim().substring(0, 255),
      description: description?.trim(),
      imageUrl: ogImage?.trim(),
      siteName: siteName?.trim().substring(0, 100)
    }
  } catch (error) {
    console.error('Error extracting metadata from', url, error)
    return {}
  }
}

// POST /api/shorturl - Create a new short URL
router.post('/', async (req, res) => {
  try {
    const { url } = req.body

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' })
    }

    // Validate URL format and scheme
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' })
    }

    // Only allow http/https schemes (block javascript:, data:, etc.)
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return res.status(400).json({ error: 'Only http and https URLs are allowed' })
    }

    // Get extension from original URL to preserve it
    const ext = getExtension(url)
    const domain = getShortUrlDomain()

    // If the URL is already one of our short URLs, return that entry
    // verbatim instead of creating a chain.
    const reused = await findExistingShortUrlByCode(url)
    if (reused) {
      return res.json({
        code: reused.code,
        shortUrl: `${domain}/s/${reused.code}`,
        originalUrl: reused.originalUrl,
        title: reused.title,
        description: reused.description,
        imageUrl: reused.imageUrl,
        siteName: reused.siteName,
      })
    }

    // Check if URL already exists
    const existing = await prisma.shortUrl.findFirst({
      where: { originalUrl: url }
    })

    if (existing) {
      const fullShortUrl = `${domain}/s/${existing.code}`
      return res.json({
        code: existing.code,
        shortUrl: fullShortUrl,
        originalUrl: existing.originalUrl,
        title: existing.title,
        description: existing.description,
        imageUrl: existing.imageUrl,
        siteName: existing.siteName
      })
    }

    // Generate unique short code with extension
    let code: string
    let attempts = 0
    do {
      code = generateShortCode() + ext // e.g., "abc123.gif"
      const exists = await prisma.shortUrl.findUnique({ where: { code } })
      if (!exists) break
      attempts++
    } while (attempts < 10)

    if (attempts >= 10) {
      return res.status(500).json({ error: 'Failed to generate unique code' })
    }

    // Extract metadata (don't block on this)
    const metadata = await extractMetadata(url)

    // Create short URL entry
    const shortUrl = await prisma.shortUrl.create({
      data: {
        code,
        originalUrl: url,
        title: metadata.title,
        description: metadata.description,
        imageUrl: metadata.imageUrl,
        siteName: metadata.siteName
      }
    })

    const fullShortUrl = `${domain}/s/${shortUrl.code}`
    return res.status(201).json({
      code: shortUrl.code,
      shortUrl: fullShortUrl,
      originalUrl: shortUrl.originalUrl,
      title: shortUrl.title,
      description: shortUrl.description,
      imageUrl: shortUrl.imageUrl,
      siteName: shortUrl.siteName
    })
  } catch (error) {
    console.error('POST /api/shorturl error:', error)
    return res.status(500).json({ error: 'Failed to create short URL' })
  }
})

// POST /api/shorturl/bulk - Shorten multiple URLs at once
router.post('/bulk', async (req, res) => {
  console.log('[ShortURL] /bulk request body:', req.body)
  try {
    const { urls } = req.body
    const domain = getShortUrlDomain()

    if (!urls || !Array.isArray(urls)) {
      console.log('[ShortURL] Invalid request - urls is not an array:', urls)
      return res.status(400).json({ error: 'URLs array is required' })
    }
    console.log('[ShortURL] Processing URLs:', urls)

    if (urls.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 URLs per request' })
    }

    const results: Record<string, { code: string; shortUrl: string; title?: string; description?: string; imageUrl?: string; siteName?: string }> = {}

    for (const url of urls) {
      if (typeof url !== 'string') continue

      try {
        new URL(url) // Validate URL
      } catch {
        continue // Skip invalid URLs
      }

      // If the URL is already one of our short URLs, reuse the existing
      // entry — see findExistingShortUrlByCode for the rationale.
      const reused = await findExistingShortUrlByCode(url)
      if (reused) {
        results[url] = {
          code: reused.code,
          shortUrl: `${domain}/s/${reused.code}`,
          title: reused.title || undefined,
          description: reused.description || undefined,
          imageUrl: reused.imageUrl || undefined,
          siteName: reused.siteName || undefined,
        }
        continue
      }

      // Get extension from original URL
      const ext = getExtension(url)

      // Check if already exists
      let shortUrlEntry = await prisma.shortUrl.findFirst({
        where: { originalUrl: url }
      })

      if (!shortUrlEntry) {
        // Generate unique code with extension
        let code: string
        let attempts = 0
        do {
          code = generateShortCode() + ext // e.g., "abc123.gif"
          const exists = await prisma.shortUrl.findUnique({ where: { code } })
          if (!exists) break
          attempts++
        } while (attempts < 10)

        if (attempts >= 10) continue

        // Extract metadata
        const metadata = await extractMetadata(url)

        // Create entry
        shortUrlEntry = await prisma.shortUrl.create({
          data: {
            code,
            originalUrl: url,
            title: metadata.title,
            description: metadata.description,
            imageUrl: metadata.imageUrl,
            siteName: metadata.siteName
          }
        })
      }

      const fullShortUrl = `${domain}/s/${shortUrlEntry.code}`
      results[url] = {
        code: shortUrlEntry.code,
        shortUrl: fullShortUrl,
        title: shortUrlEntry.title || undefined,
        description: shortUrlEntry.description || undefined,
        imageUrl: shortUrlEntry.imageUrl || undefined,
        siteName: shortUrlEntry.siteName || undefined
      }
    }

    return res.json({ results })
  } catch (error) {
    console.error('POST /api/shorturl/bulk error:', error)
    return res.status(500).json({ error: 'Failed to shorten URLs' })
  }
})

// GET /api/shorturl/:code - Get metadata for a short URL (for previews).
//
// Cross-origin allowed: the FE on a mirror node needs to resolve short
// URLs that were minted on the originating node. The endpoint is
// public-read (no auth, no cookies, returns the same data the /s/ 302
// would expose anyway via `Location:` header), so opening it up to
// any origin doesn't change the security posture.
//
// Importantly, NO `Access-Control-Allow-Credentials: true` here — the
// combination with `*` is invalid per spec, and there's no auth state
// for callers to leak. The FE's cross-node fetch in useCachedFetch and
// LinkPreview goes through plain `fetch(url)` (not credentials:include).
router.get('/:code', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Vary', 'Origin')
  try {
    const { code } = req.params

    if (!code) {
      return res.status(400).json({ error: 'Code is required' })
    }

    const shortUrl = await prisma.shortUrl.findUnique({
      where: { code }
    })

    if (!shortUrl) {
      return res.status(404).json({ error: 'Short URL not found' })
    }

    return res.json({
      code: shortUrl.code,
      originalUrl: shortUrl.originalUrl,
      title: shortUrl.title,
      description: shortUrl.description,
      imageUrl: shortUrl.imageUrl,
      siteName: shortUrl.siteName,
      clickCount: shortUrl.clickCount
    })
  } catch (error) {
    console.error('GET /api/shorturl/:code error:', error)
    return res.status(500).json({ error: 'Failed to get short URL' })
  }
})

export default router
