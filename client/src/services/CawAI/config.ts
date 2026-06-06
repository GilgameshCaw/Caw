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

  // Deployer wallet that owns the bot profile. Signs every reply
  // action directly (no Quick Sign session bootstrap required). Hex
  // private key: 0x followed by 64 hex chars.
  deployerPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),

  // Anthropic API key. NEVER passed into the LLM prompt; only used by
  // the Node-side fetch call that hits api.anthropic.com.
  anthropicApiKey: z.string().min(10),

  // Voyage AI key for RAG embeddings (build-index + query-time embed).
  // Get one at dash.voyageai.com.
  voyageApiKey: z.string().min(10),

  // The mirror this bot polls / posts through. Single-mirror by design
  // until the operator explicitly opts into multi-mirror.
  apiUrl: z.string().url(),

  // L2 CawActions contract address (0x-prefixed). Used to build the
  // EIP-712 domain for signing replies.
  cawActionsAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

  // L2 chain id. Used in EIP-712 domain. e.g. 84532 for Base Sepolia.
  chainId: z.coerce.number().int().positive(),

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

  // Optional: S3 bucket + key for persisting the cursor in Lambda
  // deployments where /tmp is ephemeral per cold start. When absent
  // the cursor falls back to a local file at /tmp/cawai-cursor.json.
  s3Bucket: z.string().optional(),
  s3CursorKey: z.string().optional(),
})

export type CawAIConfig = z.infer<typeof Schema>

export function loadConfig(): CawAIConfig {
  return Schema.parse({
    profileTokenId:   process.env.CAW_AI_PROFILE_TOKEN_ID,
    deployerPrivateKey: process.env.CAW_AI_DEPLOYER_PRIVATE_KEY,
    anthropicApiKey:  process.env.CAW_AI_ANTHROPIC_API_KEY,
    voyageApiKey:     process.env.CAW_AI_VOYAGE_API_KEY,
    apiUrl:           process.env.CAW_AI_API_URL,
    cawActionsAddress: process.env.CAW_AI_CAWACTIONS_ADDRESS,
    chainId:          process.env.CAW_AI_CHAIN_ID,
    pollIntervalMs:   process.env.CAW_AI_POLL_INTERVAL_MS,
    dailyUsdBudget:   process.env.CAW_AI_DAILY_USD_BUDGET,
    ragIndexPath:     process.env.CAW_AI_RAG_INDEX_PATH,
    maxReplyChars:    process.env.CAW_AI_MAX_REPLY_CHARS,
    aiMarker:         process.env.CAW_AI_MARKER,
    s3Bucket:         process.env.CAW_AI_S3_BUCKET,
    s3CursorKey:      process.env.CAW_AI_S3_CURSOR_KEY,
  })
}
