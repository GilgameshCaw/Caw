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
import { SYSTEM_PROMPT, REPLY_INSTRUCTION } from './persona'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001' // cheap, fast, fits the budget

const VOYAGE_EMBED_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-3.5'

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
      system: SYSTEM_PROMPT,
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
 * Embed a query string using Voyage AI for RAG retrieval.
 * Uses input_type='query' (vs 'document' used at index-build time).
 */
export async function embedQuery(text: string, voyageApiKey: string): Promise<number[]> {
  const res = await fetch(VOYAGE_EMBED_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${voyageApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      input: [text],
      model: VOYAGE_MODEL,
      input_type: 'query',
    }),
  })
  if (!res.ok) throw new Error(`voyage embed ${res.status}: ${await res.text()}`)
  const { data } = await res.json() as { data: Array<{ embedding: number[] }> }
  return data[0].embedding
}

// Hard character clamp applied to model output BEFORE posting. Never
// trust the model to obey the system-prompt length rule — a
// prompt-injected reply that's 5000 chars long would just get sliced.
export function clampReply(text: string, maxChars: number, marker: string): string {
  const room = maxChars - marker.length
  let body = text.trim()
  if (body.length > room) body = body.slice(0, room - 1).trimEnd() + '…'
  return body + marker
}
