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

/**
 * Cheap script-based source-language guess. Returns a BCP-47 primary
 * subtag if we can identify the writing system unambiguously, else null.
 *
 * Used as a free fallback when neither Caw.sourceLanguage nor the
 * author's preferredLanguage is set — saves a gtx detect call for posts
 * written in non-Latin scripts.
 *
 * Conservative by design: scripts shared by multiple languages (Cyrillic,
 * Latin, Arabic-script Persian-vs-Arabic, Hangul-vs-Hanja-vs-Hiragana
 * mixed CJK) get the dominant guess. The user's manual Translate button
 * still calls real gtx detect, which writes the correct code back to
 * Caw.sourceLanguage and corrects any miss.
 *
 * Counts script-bearing characters; ignores digits, punctuation, URLs,
 * and ASCII letters (which would otherwise dominate any post that
 * contains a single Latin-script @mention or hashtag).
 */
export function detectScript(text: string): string | null {
  if (!text) return null

  const counts: Record<string, number> = {}
  // Walk codepoints (post text may include emoji & surrogate pairs).
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    // CJK ideographs (Han) — used by zh + part of ja/ko, but if no
    // hiragana/katakana/hangul accompanies it, default to Chinese.
    if (cp >= 0x4E00 && cp <= 0x9FFF) counts.zh = (counts.zh ?? 0) + 1
    // Hiragana + Katakana → unambiguously Japanese.
    else if ((cp >= 0x3040 && cp <= 0x309F) || (cp >= 0x30A0 && cp <= 0x30FF)) counts.ja = (counts.ja ?? 0) + 1
    // Hangul Syllables + Jamo → unambiguously Korean.
    else if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x3130 && cp <= 0x318F)) counts.ko = (counts.ko ?? 0) + 1
    // Cyrillic → assume Russian (covers Russian/Ukrainian/Belarusian/Bulgarian
    // — all share the script; ru is the safe majority guess).
    else if ((cp >= 0x0400 && cp <= 0x04FF) || (cp >= 0x0500 && cp <= 0x052F)) counts.ru = (counts.ru ?? 0) + 1
    // Hebrew block.
    else if (cp >= 0x0590 && cp <= 0x05FF) counts.he = (counts.he ?? 0) + 1
    // Arabic block (covers Arabic, Persian, Urdu — all overlap; default
    // to Arabic since fa/ur add specific letters but Arabic-only is
    // detectable by absence of those, which we don't bother with here).
    else if (cp >= 0x0600 && cp <= 0x06FF) counts.ar = (counts.ar ?? 0) + 1
    // Devanagari → Hindi.
    else if (cp >= 0x0900 && cp <= 0x097F) counts.hi = (counts.hi ?? 0) + 1
    // Thai block.
    else if (cp >= 0x0E00 && cp <= 0x0E7F) counts.th = (counts.th ?? 0) + 1
  }

  // Japanese check first: any kana presence trumps Chinese, since
  // Chinese never uses kana but Japanese mixes kanji + kana.
  if (counts.ja && counts.ja > 0) return 'ja'

  // Otherwise pick the script with the most matching characters.
  let best: string | null = null
  let bestCount = 0
  for (const [lang, n] of Object.entries(counts)) {
    if (n > bestCount) { bestCount = n; best = lang }
  }
  // Require at least 3 script-bearing characters before committing —
  // a single emoji-adjacent CJK character in an otherwise-English post
  // shouldn't flip the language.
  return bestCount >= 3 ? best : null
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
