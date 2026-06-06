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

  // TODO: actual fetch() with the Anthropic key from cfg.anthropicApiKey.
  // Key is read from Node env here; never inlined into prompts.
  void ANTHROPIC_URL; void MODEL; void cfg; void userMessage; void SYSTEM_PROMPT

  return {
    text: '',
    inputTokens: 0,
    outputTokens: 0,
    usdCost: 0,
  }
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
