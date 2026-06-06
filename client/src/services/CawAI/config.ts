// CawAI/config.ts
//
// Env var loading + zod validation for the bot's runtime config. Kept
// separate from index.ts so the build-RAG-index script can import it
// without dragging in the full service surface.

import { z } from 'zod'
import 'dotenv/config'

const Schema = z.object({
  // Bot identity on the protocol — any minted profile's tokenId.
  // Operators of forked bots set this to their own profile id.
  profileTokenId: z.coerce.number().int().positive(),

  // Sponsor wallet that pays for the reply tx (gas + validator tip +
  // session create if needed). Hex private key.
  sponsorPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),

  // Anthropic API key. NEVER passed into the LLM prompt; only used by
  // the Node-side fetch call that hits api.anthropic.com.
  anthropicApiKey: z.string().min(10),

  // The mirror this bot polls / posts through. Single-mirror by design
  // until the operator explicitly opts into multi-mirror.
  apiUrl: z.string().url(),

  // Poll cadence. Default 15 min.
  pollIntervalMs: z.coerce.number().int().min(60_000).default(15 * 60_000),

  // Hard cap on inference spend per day, in USD. When tripped, the bot
  // silently stops replying until UTC midnight resets the counter.
  dailyUsdBudget: z.coerce.number().positive().default(20),

  // Path to the prebuilt RAG index (JSONL). Built once at deploy time by
  // `npm run cawai:build-rag`.
  ragIndexPath: z.string().default('./rag-index.jsonl'),

  // Max chars per reply. Hard-clamped after generation, never trusted
  // to the model. < 420 keeps replies fitting in a single CAW post.
  maxReplyChars: z.coerce.number().int().min(50).max(420).default(420),

  // Visible marker appended to every reply so users can identify
  // machine-generated content.
  aiMarker: z.string().default(' — 🤖'),
})

export type CawAIConfig = z.infer<typeof Schema>

export function loadConfig(): CawAIConfig {
  return Schema.parse({
    profileTokenId: process.env.CAW_AI_PROFILE_TOKEN_ID,
    sponsorPrivateKey: process.env.CAW_AI_SPONSOR_PRIVATE_KEY,
    anthropicApiKey: process.env.CAW_AI_ANTHROPIC_API_KEY,
    apiUrl: process.env.CAW_AI_API_URL,
    pollIntervalMs: process.env.CAW_AI_POLL_INTERVAL_MS,
    dailyUsdBudget: process.env.CAW_AI_DAILY_USD_BUDGET,
    ragIndexPath: process.env.CAW_AI_RAG_INDEX_PATH,
    maxReplyChars: process.env.CAW_AI_MAX_REPLY_CHARS,
    aiMarker: process.env.CAW_AI_MARKER,
  })
}
