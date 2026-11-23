// Translation helper used by both post translation (FeedItem) and DM
// translation (Messages).
//
// Two routes exist and the caller's `isPrivate` flag plus the user's
// setting decide which one runs:
//
//   node    POST /api/translate on this node. Multi-provider (Gemini /
//           DeepL / Google Cloud / keyless MyMemory), server-side LRU cache,
//           works from datacenter IPs and privacy relays that Google's
//           unauthenticated gtx endpoint rate-limits. Public posts always
//           take this route: the text is public anyway.
//
//   browser The original path: this device calls Google Translate's
//           unauthenticated gtx endpoint directly. The node operator never
//           sees the plaintext. It is the DEFAULT for DMs, because a DM is
//           end-to-end encrypted and routing its plaintext through the node
//           would hand it to the operator (and to whatever provider the
//           operator configured) — a strictly larger trust surface than the
//           user was told about. Users who prefer the node's providers can
//           opt in under Settings → Language.
//
// Either way, translating a DM sends its plaintext off-device. Always prompt
// the user first (see ConfirmModal with rememberKey='dmTranslate').

import { apiFetch } from '~/api/client'
import {
  scheduleTranslateRequest,
  TranslateRateLimitedError,
  TranslateCancelledError,
  type TranslatePriority,
} from './translateRequests'

/** Where DM plaintext goes when the user translates a direct message. */
export type DmTranslateRoute = 'browser' | 'node'

const DM_TRANSLATE_ROUTE_KEY = 'caw:dmTranslateRoute'
const DM_TRANSLATE_ROUTE_DEFAULT: DmTranslateRoute = 'browser'

/**
 * Per-device preference (localStorage, like the dmTranslate acknowledgement
 * itself): it is a statement about where THIS device is willing to send
 * decrypted DM text, so it deliberately does not sync through the User row.
 */
export function getDmTranslateRoute(): DmTranslateRoute {
  try {
    const v = localStorage.getItem(DM_TRANSLATE_ROUTE_KEY)
    return v === 'node' ? 'node' : DM_TRANSLATE_ROUTE_DEFAULT
  } catch {
    return DM_TRANSLATE_ROUTE_DEFAULT
  }
}

export function setDmTranslateRoute(route: DmTranslateRoute): void {
  try { localStorage.setItem(DM_TRANSLATE_ROUTE_KEY, route) } catch {}
}

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
 *
 * `minChars` is how many script-bearing characters it takes to commit
 * (default 3). translateTextDetailed lowers it to 2, because it only asks
 * after the provider's own detection has already failed.
 */
export function detectScript(text: string, minChars = 3): string | null {
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
  // Require at least `minChars` script-bearing characters before committing —
  // a single emoji-adjacent CJK character in an otherwise-English post
  // shouldn't flip the language.
  return bestCount >= minChars ? best : null
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
export interface TranslateOptions {
  isPrivate?: boolean
  /**
   * 'auto' for a translation nobody asked for (auto-translate): it waits its
   * turn behind the node's rate limit. The default, 'user', is for one the user
   * asked for, and goes at once. See ./translateRequests.
   */
  priority?: TranslatePriority
  /** Cancels a request that is still waiting for its turn. */
  signal?: AbortSignal
  /**
   * Called, with the seconds until the limit is lifted, when the node's rate
   * limit stopped the translation, so the caller can say so instead of the
   * null result passing in silence.
   */
  onRateLimited?: (retryAfterSeconds: number) => void
}

export async function translateText(
  text: string,
  targetLang?: string,
  options?: TranslateOptions,
): Promise<string | null> {
  const detail = await translateTextDetailed(text, targetLang, options)
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
  options?: TranslateOptions,
): Promise<TranslationResult | null> {
  try {
    return await translateWithFallbacks(text, targetLang, options)
  } catch (err) {
    // The node's rate limit stops the whole attempt: the requests below would
    // only be refused as well. A cancel ends it quietly.
    if (err instanceof TranslateRateLimitedError) {
      options?.onRateLimited?.(err.retryAfterSeconds)
      return null
    }
    if (err instanceof TranslateCancelledError) return null
    throw err
  }
}

async function translateWithFallbacks(
  text: string,
  targetLang?: string,
  options?: TranslateOptions,
): Promise<TranslationResult | null> {
  if (!text || !text.trim()) return null
  const tl = targetLang || getTargetLanguage()

  const first = await fetchTranslation(text, tl, options?.isPrivate, undefined, options)
  if (first && first.text && first.text !== text) {
    return { ...first, targetLanguage: tl }
  }

  // The provider answered but handed the text back as it was. Besides "the
  // text is already in the target language", that happens when the provider
  // detects the language itself (MyMemory, the node's fallback when no
  // translation key is set) and Latin-script tokens in the text (gm, $CAW,
  // #tags) throw the detection off: a Chinese post with a few of them is
  // "detected" as Polish and returned untouched. When the text's own script
  // says what it is, tell the provider and ask again. Only on this path, so a
  // text that already translates goes out exactly as before. A DM on the
  // browser route goes to Google's gtx, which detects well and is not told.
  const viaNode = !(options?.isPrivate && getDmTranslateRoute() === 'browser')
  const hint = first && viaNode ? detectScript(text, 2) : null
  if (hint && hint !== tl) {
    const hinted = await fetchTranslation(text, tl, options?.isPrivate, hint, options)
    if (hinted && hinted.text && hinted.text !== text) {
      return { ...hinted, targetLanguage: tl }
    }
  }

  // Source was already in target language — fall back to English so the
  // user gets *something* useful (vs. tapping "Translate" and seeing the
  // same text). Skip this if we already targeted English. The source is named
  // here only when the request above was not made because the script language
  // is the target itself; after a hinted request that failed, this is the plain
  // request it always was, in case the guess was the problem.
  if (tl !== 'en') {
    const en = await fetchTranslation(text, 'en', options?.isPrivate, hint && hint === tl ? hint : undefined, options)
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

type Pacing = Pick<TranslateOptions, 'priority' | 'signal'>

async function fetchTranslation(text: string, tl: string, isPrivate?: boolean, sourceLang?: string, pacing?: Pacing): Promise<FetchResult | null> {
  // Private (DM) text only goes through the node when the user opted in.
  if (isPrivate && getDmTranslateRoute() === 'browser') {
    return fetchTranslationDirect(text, tl)
  }
  return fetchTranslationViaNode(text, tl, isPrivate, sourceLang, pacing)
}

/** `sourceLang`, when given, is sent so the node does not have to detect it. */
async function fetchTranslationViaNode(text: string, tl: string, isPrivate?: boolean, sourceLang?: string, pacing?: Pacing): Promise<FetchResult | null> {
  try {
    const res = await scheduleTranslateRequest(
      () => apiFetch<{ text: string; sourceLanguage: string }>('/api/translate', {
        method: 'POST',
        body: JSON.stringify({ text, targetLang: tl, sourceLang, isPrivate }),
      }),
      pacing?.priority,
      pacing?.signal,
    )
    if (res?.text) {
      return { text: res.text, sourceLanguage: res.sourceLanguage || '' }
    }
  } catch (err) {
    // Not a failed translation: the caller decides what to say (see translateTextDetailed).
    if (err instanceof TranslateRateLimitedError || err instanceof TranslateCancelledError) throw err
    console.warn('[translate] API proxy request failed:', err)
  }
  return null
}

/**
 * Browser → Google Translate directly (the unauthenticated `gtx` endpoint
 * the Chrome translate bar uses). Undocumented and rate-limited from
 * datacenter IPs and privacy relays, which is why public posts moved to the
 * node proxy — but it is the only route where the node operator never sees
 * the text, so it stays as the default for DMs.
 */
async function fetchTranslationDirect(text: string, tl: string): Promise<FetchResult | null> {
  try {
    const url = `${GOOGLE_TRANSLATE_URL}?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`
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
    // data[2] is gtx's detected source language (e.g. "es"). Sometimes a
    // region-tagged form ("zh-CN") — strip to the primary subtag.
    const detectedRaw = typeof data?.[2] === 'string' ? data[2] : ''
    return { text: joined, sourceLanguage: detectedRaw.split('-')[0].toLowerCase() }
  } catch (err) {
    console.warn('[translate] direct request failed:', err)
    return null
  }
}
