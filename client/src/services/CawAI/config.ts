// CawAI/config.ts
//
// Env var loading + zod validation for the bot's runtime config. Kept
// separate from index.ts so the build-RAG-index script can import it
// without dragging in the full service surface.

import { z } from 'zod'
import 'dotenv/config'
// CAW_ACTIONS_ADDRESS in addresses.ts is the action-processing L2 CawActions —
// the same contract CAW_AI_CAWACTIONS_ADDRESS points at. Default to it so a
// redeploy needs no .env edit; env stays an optional override.
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'

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

  // Optional marker appended to every reply. Default is empty: the bot
  // discloses its AI nature through its wording (see persona rule 7) and uses
  // 🌙 as a natural signature rather than a fixed appended badge. Set
  // CAW_AI_MARKER to re-enable a fixed suffix if an operator wants one.
  aiMarker: z.string().default(''),

  // Public website base URL the bot uses to build citation links
  // (e.g. <siteUrl>/resources/whitepaper). No NEW required env var: prefers the
  // canonical HOST_DOMAIN (shared install-wide origin), with an optional
  // CAW_AI_SITE_URL override and SHORTURL_DOMAIN back-compat fallback. No
  // trailing slash — links are built as `${siteUrl}/resources/...`.
  siteUrl: z.string().url().default('https://caw.social'),

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
    apiUrl:           process.env.CAW_AI_API_URL,
    cawActionsAddress: process.env.CAW_AI_CAWACTIONS_ADDRESS || CAW_ACTIONS_ADDRESS,
    chainId:          process.env.CAW_AI_CHAIN_ID,
    pollIntervalMs:   process.env.CAW_AI_POLL_INTERVAL_MS,
    dailyUsdBudget:   process.env.CAW_AI_DAILY_USD_BUDGET,
    ragIndexPath:     process.env.CAW_AI_RAG_INDEX_PATH,
    maxReplyChars:    process.env.CAW_AI_MAX_REPLY_CHARS,
    aiMarker:         process.env.CAW_AI_MARKER,
    // Site URL precedence: explicit CAW_AI_SITE_URL override → canonical
    // HOST_DOMAIN → SHORTURL_DOMAIN (back-compat) → zod default. Strip any
    // trailing slash so link-building stays clean.
    siteUrl:          (process.env.CAW_AI_SITE_URL || process.env.HOST_DOMAIN || process.env.SHORTURL_DOMAIN || undefined)?.replace(/\/+$/, ''),
    s3Bucket:         process.env.CAW_AI_S3_BUCKET,
    s3CursorKey:      process.env.CAW_AI_S3_CURSOR_KEY,
  })
}
