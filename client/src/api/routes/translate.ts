/**
 * Server-side Translation Proxy (/api/translate)
 *
 * Overview:
 * - Provides node-level translation proxying to eliminate browser CORS issues,
 *   protect external API credentials from client exposure, and reduce external
 *   API consumption via a shared in-memory LRU cache.
 *
 * Zero-Config Out of the Box:
 * - By default (without any API keys configured), the node transparently falls back
 *   to the keyless, free public MyMemory API.
 * - Node operators may optionally configure API keys in `.env` to enable higher-quality
 *   or higher-quota translation providers.
 *
 * Provider Fallback Hierarchy:
 *   1. Google Gemini (LLM): Fast and context-aware AI translation (requires GEMINI_API_KEY).
 *      Default model: gemini-3.5-flash-lite (generous 500 RPD free tier).
 *   2. DeepL API: High-precision translation (requires DEEPL_API_KEY).
 *   3. Google Cloud Translation API (v2): (requires GOOGLE_TRANSLATE_API_KEY).
 *   4. MyMemory API: Free keyless fallback (always enabled, default tier).
 *
 * Privacy & Security:
 *   - E2EE Direct Messages pass `isPrivate: true`. Private content is NEVER cached
 *     in memory to prevent sensitive text from persisting on node servers.
 *   - Per-IP rate limiting (30 req/min) prevents abusive scraping and API quota exhaustion.
 *     A request the cache can answer calls no provider, so it is not counted.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

const router = Router()

// Per-IP rate limit: 30 requests per minute per IP.
// Prevents automated bots from draining API quotas or hammering node resources.
//
// The limit protects the providers' quotas, and a request answered from the
// cache calls none, so it is not counted: a feed that is opened again, or by
// a second viewer behind the same address, would otherwise use up the limit on
// answers the node already has. The entry found here is kept for the handler,
// so a request that was not counted is always answered from the entry it was
// not counted for.
const answeredFromCache = new WeakMap<object, CacheEntry>()
const translateRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Translation rate limit exceeded. Please try again in a minute.' },
  skip: (req) => {
    const hit = cacheAnswerFor(req.body)
    if (!hit) return false
    answeredFromCache.set(req, hit)
    return true
  },
})

// Optional API keys for reliable datacenter/node translation
// Primary recommended: GEMINI_API_KEY (free tier from Google AI Studio, fast and context-aware translation)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
// Default to gemini-3.5-flash-lite (generous 500 RPD free tier, ultra-low latency)
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
const DEEPL_API_KEY = process.env.DEEPL_API_KEY
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY

interface CacheEntry {
  text: string
  sourceLanguage: string
  timestamp: number
}

// In-memory LRU cache to minimize external API consumption and eliminate redundant calls
const MAX_CACHE_SIZE = 2000
const translationCache = new Map<string, CacheEntry>()

function getCacheKey(text: string, targetLang: string, sourceLang?: string): string {
  return `${sourceLang || 'auto'}:${targetLang}:${text.trim()}`
}

function getFromCache(key: string): CacheEntry | null {
  const entry = translationCache.get(key)
  if (!entry) return null
  // Refresh LRU order (delete and re-insert)
  translationCache.delete(key)
  translationCache.set(key, entry)
  return entry
}

// ISO 639-1/639-2 codes are 2-3 lowercase letters; the handler refuses any other
// shape (see the note where it checks), and cacheAnswerFor must agree.
const LANG_CODE_RE = /^[a-z]{2,3}$/

/**
 * The cache entry the handler below would answer this body from, or null: a
 * private text, a body the handler would refuse, or no entry. It reads the
 * fields the way the handler does, and never throws; a body it cannot read is
 * left to the handler (and the limit).
 */
function cacheAnswerFor(body: unknown): CacheEntry | null {
  if (!body || typeof body !== 'object') return null
  const { text, targetLang, sourceLang, isPrivate } = body as Record<string, unknown>
  if (isPrivate) return null
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) return null
  if (typeof targetLang !== 'string') return null
  if (sourceLang !== undefined && sourceLang !== null && typeof sourceLang !== 'string') return null
  const cleanTarget = targetLang.split('-')[0].toLowerCase()
  const cleanSource = sourceLang ? sourceLang.split('-')[0].toLowerCase() : undefined
  // A code the handler refuses is not answered from the cache, whatever key it
  // reads as: "auto" as a source gives the key of a request with no source.
  if (!LANG_CODE_RE.test(cleanTarget)) return null
  if (cleanSource && !LANG_CODE_RE.test(cleanSource)) return null
  return getFromCache(getCacheKey(text.trim(), cleanTarget, cleanSource))
}

function setToCache(key: string, value: CacheEntry): void {
  if (translationCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry (first key in iteration order)
    const oldestKey = translationCache.keys().next().value
    if (oldestKey) translationCache.delete(oldestKey)
  }
  translationCache.set(key, value)
}

/**
 * Translate via Google Gemini (LLM)
 * Optional provider: free tier available via Google AI Studio, fast and context-aware.
 */
async function translateWithGemini(
  text: string,
  targetLang: string,
  sourceLang?: string,
): Promise<{ text: string; sourceLanguage: string } | null> {
  if (!GEMINI_API_KEY) return null
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`

    const systemPrompt =
      `You are a neutral, accurate, and faithful translator for social media posts.\n` +
      `Translate the following post text into target language code "${targetLang}"${sourceLang && sourceLang !== 'auto' ? ` from source language "${sourceLang}"` : ''}.\n` +
      `Guidelines:\n` +
      `- Provide an accurate, natural, and balanced translation that faithfully conveys the meaning and tone of the original post without exaggeration.\n` +
      `- Translate all sentences and text naturally into the target language.\n` +
      `- Do NOT insert extra words, slang, colloquialisms, or emojis that are not in the original text.\n` +
      `- Preserve proper nouns, usernames (@mentions), hashtags (#tags), URLs, and financial/token tickers (e.g. $CAW, ETH). Widely recognized acronyms (e.g. WAGMI, LFG, gm) may be kept in uppercase Latin if commonly used untranslated.\n` +
      `- Return ONLY a valid raw JSON object with keys "text" and "sourceLanguage".\n` +
      `- "text" must be the translated string.\n` +
      `- "sourceLanguage" must be the 2-letter ISO language code of the original text (e.g. "en", "ja").\n` +
      `- Do NOT wrap the JSON in Markdown code fences (no \`\`\`json). Do NOT add extra conversational commentary.`

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `${systemPrompt}\n\nText to translate:\n${text}` },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1000,
        },
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) {
      console.warn(`[translate:Gemini] HTTP ${response.status}: ${await response.text().catch(() => '')}`)
      return null
    }

    const data = await response.json()
    const rawOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!rawOutput) return null

    // Parse JSON output
    try {
      // Strip markdown fences if Gemini still added them
      const cleanJson = rawOutput.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim()
      const parsed = JSON.parse(cleanJson)
      if (parsed?.text) {
        return {
          text: String(parsed.text).trim(),
          sourceLanguage: (parsed.sourceLanguage || sourceLang || 'auto').toLowerCase(),
        }
      }
    } catch {
      // Fallback: If not valid JSON, use entire output as translated text
      return {
        text: rawOutput,
        sourceLanguage: sourceLang || 'auto',
      }
    }

    return null
  } catch (err) {
    console.warn('[translate:Gemini] fetch error:', err)
    return null
  }
}

/**
 * Translate via DeepL API Free or Pro
 */
async function translateWithDeepL(
  text: string,
  targetLang: string,
  sourceLang?: string,
): Promise<{ text: string; sourceLanguage: string } | null> {
  if (!DEEPL_API_KEY) return null
  try {
    const isFreePlan = DEEPL_API_KEY.endsWith(':fx') || !DEEPL_API_KEY.includes('-')
    const endpoint = isFreePlan
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate'

    // DeepL target language mapping (e.g. EN -> EN-US, JA -> JA)
    let deepLTarget = targetLang.toUpperCase()
    if (deepLTarget === 'EN') deepLTarget = 'EN-US'

    const params = new URLSearchParams()
    params.set('text', text)
    params.set('target_lang', deepLTarget)
    if (sourceLang && sourceLang !== 'auto') {
      params.set('source_lang', sourceLang.toUpperCase())
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(6000),
    })

    if (!response.ok) {
      console.warn(`[translate:DeepL] HTTP ${response.status}: ${await response.text().catch(() => '')}`)
      return null
    }

    const data = await response.json()
    const first = data?.translations?.[0]
    if (first?.text) {
      const detected = (first.detected_source_language || '').toLowerCase()
      return { text: first.text, sourceLanguage: detected }
    }
    return null
  } catch (err) {
    console.warn('[translate:DeepL] fetch error:', err)
    return null
  }
}

/**
 * Translate via Google Cloud Translation API (v2)
 */
async function translateWithGoogleCloud(
  text: string,
  targetLang: string,
  sourceLang?: string,
): Promise<{ text: string; sourceLanguage: string } | null> {
  if (!GOOGLE_TRANSLATE_API_KEY) return null
  try {
    const url = new URL('https://translation.googleapis.com/language/translate/v2')
    url.searchParams.set('key', GOOGLE_TRANSLATE_API_KEY)
    url.searchParams.set('q', text)
    url.searchParams.set('target', targetLang)
    url.searchParams.set('format', 'text')
    if (sourceLang && sourceLang !== 'auto') {
      url.searchParams.set('source', sourceLang)
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(6000),
    })

    if (!response.ok) {
      console.warn(`[translate:GoogleCloud] HTTP ${response.status}: ${await response.text().catch(() => '')}`)
      return null
    }

    const data = await response.json()
    const trans = data?.data?.translations?.[0]
    if (trans?.translatedText) {
      const detected = (trans.detectedSourceLanguage || '').toLowerCase()
      return { text: trans.translatedText, sourceLanguage: detected }
    }
    return null
  } catch (err) {
    console.warn('[translate:GoogleCloud] fetch error:', err)
    return null
  }
}

/**
 * Fallback to MyMemory Public API (free, keyless)
 */
async function translateWithMyMemory(
  text: string,
  targetLang: string,
  sourceLang?: string,
): Promise<{ text: string; sourceLanguage: string } | null> {
  try {
    const sl = sourceLang && sourceLang !== 'auto' ? sourceLang : 'autodetect'
    const langpair = `${sl}|${targetLang}`
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langpair}`

    const response = await fetch(url, {
      signal: AbortSignal.timeout(6000),
    })

    if (!response.ok) return null
    const data = await response.json()

    // Status 200 with valid translatedText
    if (data?.responseStatus === 200 || data?.responseStatus === '200') {
      const txt = data?.responseData?.translatedText
      if (txt && !txt.includes('PLEASE SELECT TWO DISTINCT LANGUAGES')) {
        const detected = (data?.responseData?.detectedLanguage || '').toLowerCase()
        return { text: txt, sourceLanguage: detected }
      }
    }
    return null
  } catch (err) {
    console.warn('[translate:MyMemory] fetch error:', err)
    return null
  }
}

/**
 * POST /api/translate
 * Body: { text: string, targetLang: string, sourceLang?: string, isPrivate?: boolean }
 */
router.post('/', translateRateLimit, (async (req: any, res: any): Promise<void> => {
  try {
    const { text, targetLang, sourceLang, isPrivate } = req.body

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Field "text" is required and must be non-empty' })
      return
    }

    if (text.length > 2000) {
      res.status(400).json({ error: 'Field "text" exceeds maximum allowed length of 2,000 characters' })
      return
    }

    if (!targetLang || typeof targetLang !== 'string') {
      res.status(400).json({ error: 'Field "targetLang" is required' })
      return
    }

    const trimmedText = text.trim()
    const cleanTarget = targetLang.split('-')[0].toLowerCase()
    const cleanSource = sourceLang ? sourceLang.split('-')[0].toLowerCase() : undefined

    // cleanTarget/cleanSource flow unsanitized into the Gemini prompt string
    // and the MyMemory/Google Cloud query URLs below -- an unvalidated value
    // here is a prompt-injection vector into the LLM path and a URL-injection
    // vector into the HTTP fallback paths. ISO 639-1/639-2 language codes are
    // always 2-3 lowercase letters, so gate on that shape before either use.
    // (Found in review by @nyaromesama.)
    if (!LANG_CODE_RE.test(cleanTarget)) {
      res.status(400).json({ error: 'Field "targetLang" must be a 2-3 letter language code' })
      return
    }
    if (cleanSource && !LANG_CODE_RE.test(cleanSource)) {
      res.status(400).json({ error: 'Field "sourceLang" must be a 2-3 letter language code' })
      return
    }

    // If source and target are explicitly identical, return original
    if (cleanSource && cleanSource === cleanTarget) {
      res.json({
        text: trimmedText,
        sourceLanguage: cleanSource,
        targetLanguage: cleanTarget,
        cached: false,
      })
      return
    }

    // Check in-memory LRU cache first
    // PRIVACY AUDIT GUARD: Never read from cache for private content (e.g. E2EE DMs)
    const cacheKey = getCacheKey(trimmedText, cleanTarget, cleanSource)
    if (!isPrivate) {
      const cached = answeredFromCache.get(req) ?? getFromCache(cacheKey)
      if (cached) {
        res.json({
          text: cached.text,
          sourceLanguage: cached.sourceLanguage,
          targetLanguage: cleanTarget,
          cached: true,
        })
        return
      }
    }

    // Multi-tier fallback order:
    // 1. Google Gemini (Context-aware Web3 translation, if configured)
    // 2. DeepL API (if configured)
    // 3. Google Cloud Translation API (if configured)
    // 4. MyMemory Public API (zero-config keyless free fallback)
    let result = await translateWithGemini(trimmedText, cleanTarget, cleanSource)
    if (!result) {
      result = await translateWithDeepL(trimmedText, cleanTarget, cleanSource)
    }
    if (!result) {
      result = await translateWithGoogleCloud(trimmedText, cleanTarget, cleanSource)
    }
    if (!result) {
      result = await translateWithMyMemory(trimmedText, cleanTarget, cleanSource)
    }

    if (!result) {
      res.status(503).json({
        error: 'Translation services temporarily unavailable',
      })
      return
    }

    // PRIVACY AUDIT GUARD: Never store private content (E2EE DMs) in memory cache
    if (!isPrivate) {
      const cacheEntry: CacheEntry = {
        text: result.text,
        sourceLanguage: result.sourceLanguage,
        timestamp: Date.now(),
      }
      setToCache(cacheKey, cacheEntry)
    }

    res.json({
      text: result.text,
      sourceLanguage: result.sourceLanguage,
      targetLanguage: cleanTarget,
      cached: false,
    })
  } catch (error: any) {
    console.error('POST /api/translate error:', error)
    res.status(500).json({ error: 'Internal server error during translation' })
  }
}) as any)

export default router
