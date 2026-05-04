// Translation helper used by both post translation (FeedItem) and DM
// translation (Messages). Centralized here so changing the provider, the
// target-language strategy, or adding API-key auth happens in one place.
//
// Current implementation: Google Translate's free unauthenticated `gtx`
// endpoint (the same one the Chrome translate bar uses). No API key, no
// quota visible to us, but it's undocumented and could break — wrap every
// call in try/catch at the callsite.
//
// Note for DMs: this sends plaintext to a third party. The DM is E2E-
// encrypted in transit + at rest; translating breaks that boundary. Always
// prompt the user (see ConfirmModal with rememberKey='dmTranslateAck')
// before calling this for a DM.

const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single'

/**
 * Browser-locale fallback target language. The Settings → Language picker
 * stores a per-user preference on the User row; viewers without one set
 * (and unauthenticated viewers) fall through to this. Both this function
 * and the FeedItem consumer return BCP-47 primary subtags.
 */
export function getTargetLanguage(): string {
  if (typeof navigator === 'undefined') return 'en'
  const locale = navigator.language || 'en'
  return locale.split('-')[0] || 'en'
}

export interface TranslationResult {
  /** Final translated text. */
  text: string
  /** Source language detected by gtx (BCP-47 primary subtag). May be
   * 'auto' or empty if gtx didn't return one — callers should treat
   * those as "unknown" and skip the source-language-cache POST. */
  sourceLanguage: string
  /** The target language that produced `text` — usually the requested
   * `tl`, but can be `'en'` when the requested target matched the
   * source and we fell back to English (see translateText). */
  targetLanguage: string
}

/**
 * Translate `text` to `targetLang` (defaults to getTargetLanguage()).
 *
 * If the result equals the original (likely because the source IS already
 * in targetLang), retries with `en` as the target — matches what FeedItem
 * was doing inline. Returns null on failure or if the translation came
 * back empty.
 *
 * Throws nothing — callers don't need a try/catch unless they want to
 * distinguish "no translation available" from "network error".
 *
 * Backwards-compatible: returns the joined translation string. Callers
 * that want the detected source language for caching purposes should
 * use `translateTextDetailed` instead.
 */
export async function translateText(text: string, targetLang?: string): Promise<string | null> {
  const detail = await translateTextDetailed(text, targetLang)
  return detail?.text ?? null
}

/**
 * Same as translateText but returns the detected source language too,
 * so callers (FeedItem) can persist it back to the server for the
 * crowd-sourced source-language cache on Caw.sourceLanguage.
 */
export async function translateTextDetailed(
  text: string,
  targetLang?: string,
): Promise<TranslationResult | null> {
  if (!text || !text.trim()) return null
  const tl = targetLang || getTargetLanguage()

  const first = await fetchTranslation(text, tl)
  if (first && first.text && first.text !== text) {
    return { ...first, targetLanguage: tl }
  }

  // Source was already in target language — fall back to English so the
  // user gets *something* useful (vs. tapping "Translate" and seeing the
  // same text). Skip this if we already targeted English.
  if (tl !== 'en') {
    const en = await fetchTranslation(text, 'en')
    if (en && en.text && en.text !== text) {
      return { ...en, targetLanguage: 'en' }
    }
  }
  return null
}

interface FetchResult {
  text: string
  sourceLanguage: string
}

async function fetchTranslation(text: string, tl: string): Promise<FetchResult | null> {
  try {
    const url = `${GOOGLE_TRANSLATE_URL}?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    // Response shape: [[[translatedChunk, originalChunk, ...], ...], <??>, "<src>", ...]
    if (!Array.isArray(data?.[0])) return null
    const joined = (data[0] as unknown[])
      .map(seg => Array.isArray(seg) ? (seg as unknown[])[0] : '')
      .filter((s): s is string => typeof s === 'string')
      .join('')
    if (!joined) return null
    // data[2] is gtx's detected source language (e.g. "es"). Sometimes
    // it's a region-tagged form ("zh-CN") — strip down to the primary
    // subtag so it lines up with our stored preferredLanguage shape.
    const detectedRaw = typeof data?.[2] === 'string' ? data[2] : ''
    const sourceLanguage = detectedRaw.split('-')[0].toLowerCase()
    return { text: joined, sourceLanguage }
  } catch (err) {
    console.warn('[translate] fetch failed:', err)
    return null
  }
}
