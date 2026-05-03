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
 * Best target-language guess for the current user. Today: browser locale's
 * primary subtag (`navigator.language.split('-')[0]`). Stub here so a future
 * per-user setting (Settings → Language → "Translate posts to ...") can
 * land in one place without touching every callsite.
 */
export function getTargetLanguage(): string {
  if (typeof navigator === 'undefined') return 'en'
  const locale = navigator.language || 'en'
  return locale.split('-')[0] || 'en'
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
 */
export async function translateText(text: string, targetLang?: string): Promise<string | null> {
  if (!text || !text.trim()) return null
  const tl = targetLang || getTargetLanguage()

  const first = await fetchTranslation(text, tl)
  if (first && first !== text) return first

  // Source was already in target language — fall back to English so the
  // user gets *something* useful (vs. tapping "Translate" and seeing the
  // same text). Skip this if we already targeted English.
  if (tl !== 'en') {
    const en = await fetchTranslation(text, 'en')
    if (en && en !== text) return en
  }
  return null
}

async function fetchTranslation(text: string, tl: string): Promise<string | null> {
  try {
    const url = `${GOOGLE_TRANSLATE_URL}?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    // Response shape: [[[translatedChunk, originalChunk, ...], ...], ...]
    if (!Array.isArray(data?.[0])) return null
    const joined = (data[0] as unknown[])
      .map(seg => Array.isArray(seg) ? (seg as unknown[])[0] : '')
      .filter((s): s is string => typeof s === 'string')
      .join('')
    return joined || null
  } catch (err) {
    console.warn('[translate] fetch failed:', err)
    return null
  }
}
