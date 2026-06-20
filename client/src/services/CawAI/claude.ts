// CawAI/claude.ts
//
// Thin Anthropic API wrapper. The LLM **has no tools**. It is a
// pure text-in / text-out call.
//
// This is the prompt-injection containment seam. Even if a malicious
// caw embeds `<system>` tags or `ignore previous instructions`, the
// model can only return TEXT. The text is character-clamped and
// posted as a normal CAW reply. There is no path from model output
// to a shell, filesystem, signing key, or external HTTP call.

import type { CawAIConfig } from './config'
import { SYSTEM_PROMPT, REPLY_INSTRUCTION, buildCitationGuidance } from './persona'
import { embedTexts } from './rag/embed'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001' // cheap, fast, fits the budget

export type GenerateInput = {
  userContent: string         // the @-mentioning caw text, untrusted
  authorHandle: string        // username for context; NOT used as instruction
  retrievedContext: string    // top-K RAG chunks already concatenated
}

export type GenerateOutput = {
  text: string
  inputTokens: number
  outputTokens: number
  usdCost: number
}

export async function generateReply(
  cfg: CawAIConfig,
  input: GenerateInput,
): Promise<GenerateOutput> {
  // User content is hard-wrapped in <user_content> tags. The system
  // prompt tells the model to treat that block as data, never as
  // instructions. We don't sanitize the user text otherwise — the
  // defense is the system prompt + the text-only tool surface.
  const userMessage = [
    `<retrieved_context>`,
    input.retrievedContext || '(no relevant context retrieved)',
    `</retrieved_context>`,
    ``,
    `<user_content author="${input.authorHandle}">`,
    input.userContent,
    `</user_content>`,
    ``,
    REPLY_INSTRUCTION,
  ].join('\n')

  // Key is read from Node env here; never inlined into prompts.
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      // Citation links are appended dynamically so they reflect the configured
      // site URL (no hardcoded domain in the static prompt).
      system: `${SYSTEM_PROMPT}\n\n${buildCitationGuidance(cfg.siteUrl)}`,
      messages: [{ role: 'user', content: userMessage }],
    }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`)
  const json = await res.json() as {
    content: Array<{ type: string; text: string }>
    usage: { input_tokens: number; output_tokens: number }
  }
  const text = json.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
  // Haiku 4.5 pricing (as of 2026-06): $0.80/Mtok input, $4.00/Mtok output
  const usdCost = (json.usage.input_tokens * 0.80 + json.usage.output_tokens * 4.00) / 1_000_000
  return {
    text,
    inputTokens: json.usage.input_tokens,
    outputTokens: json.usage.output_tokens,
    usdCost,
  }
}

/**
 * Embed a query string using the local sentence-transformers model for
 * RAG retrieval. The embedding is produced by Xenova/all-MiniLM-L6-v2
 * (384-dim, L2-normalized) — same model used at index-build time.
 *
 * The `cfg` parameter is retained for API symmetry; no remote key is
 * needed since embeddings are generated locally.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function embedQuery(text: string, _cfg?: CawAIConfig): Promise<number[]> {
  const vectors = await embedTexts([text], 'query')
  return vectors[0]
}

// Hard character clamp applied to model output BEFORE posting. Never
// trust the model to obey the system-prompt length rule — a
// prompt-injected reply that's 5000 chars long would just get sliced.
//
// When it must truncate, it backs off to a clean boundary so it never cuts
// mid-word ("...The cha…"): prefer the last sentence end, else the last word
// break, within the available room. The hard cap is still absolute — the
// result is always <= maxChars — so the security guarantee is unchanged.
// -1 stays -1 (no match); otherwise return the index one past the matched
// position so callers can treat every boundary as "cut here" uniformly.
function after(idx: number): number {
  return idx < 0 ? -1 : idx + 1
}

// Find the last occurrence of a multi-char terminator (e.g. '. ') and return
// the index just past it — i.e. past the trailing space — so the cut keeps the
// punctuation and drops the space. -1 if not found.
function lastBoundaryAfter(s: string, token: string): number {
  const idx = s.lastIndexOf(token)
  return idx < 0 ? -1 : idx + token.length
}

// Don't cut between the two halves of a UTF-16 surrogate pair (emoji, rare
// kanji in supplementary planes). If `cut` would land on a low surrogate,
// step back one unit so the pair stays whole.
function safeCodePointBoundary(s: string, cut: number): number {
  if (cut > 0 && cut < s.length) {
    const code = s.charCodeAt(cut)
    if (code >= 0xDC00 && code <= 0xDFFF) return cut - 1
  }
  return cut
}

export function clampReply(text: string, maxChars: number, marker: string): string {
  const room = maxChars - marker.length
  let body = text.trim()
  if (body.length > room) {
    // Reserve one char for the ellipsis.
    const slice = body.slice(0, room - 1)
    // Prefer a sentence boundary if one lands in the back portion of the slice
    // (don't chop the reply in half for the sake of a period).
    //
    // Two punctuation families:
    //  - Latin: '. ', '! ', '? ' — the terminator is followed by an ASCII
    //    space, so the boundary is *after* the space (index + 2).
    //  - CJK full-width: 。 ！ ？ — these never have a following half-width
    //    space, so we match the character itself and cut *after* it (index + 1,
    //    each is a single UTF-16 unit). Without this, Japanese text (no
    //    trailing space, frequently no inter-word spaces at all) never matched
    //    either boundary check and fell straight through to the hard slice,
    //    cutting mid-token. (nyaromesama)
    const latinSentenceEnd = Math.max(
      lastBoundaryAfter(slice, '. '), lastBoundaryAfter(slice, '! '), lastBoundaryAfter(slice, '? '),
    )
    const cjkSentenceEnd = Math.max(
      after(slice.lastIndexOf('。')), after(slice.lastIndexOf('！')), after(slice.lastIndexOf('？')),
    )
    const sentenceEnd = Math.max(latinSentenceEnd, cjkSentenceEnd)
    // Word/phrase boundary fallbacks, in descending preference:
    //  - ASCII space (Latin word break)
    //  - full-width comma 、 (CJK clause break — better than a raw char cut)
    const wordEnd = slice.lastIndexOf(' ')
    const cjkCommaEnd = after(slice.lastIndexOf('、'))
    let cut: number
    if (sentenceEnd >= room * 0.6) {
      cut = sentenceEnd                   // boundary already points past the terminator
    } else if (wordEnd > 0) {
      cut = wordEnd                       // last whole word (Latin)
    } else if (cjkCommaEnd >= room * 0.6) {
      cut = cjkCommaEnd                   // last CJK clause break
    } else {
      // Space-less CJK with no usable punctuation: any character boundary is a
      // natural break in Japanese, so the hard slice is acceptable — but make
      // sure we don't sever a surrogate pair (emoji, rare kanji) and leave a
      // lone half-code-unit.
      cut = safeCodePointBoundary(slice, slice.length)
    }
    body = slice.slice(0, cut).trimEnd() + '…'
  }
  return body + marker
}
