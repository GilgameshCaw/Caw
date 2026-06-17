// CawAI/test-reply.ts
//
// OFFLINE reply tester. Submit text, see exactly what @cawai would post —
// with NO chain access, NO signing key, and NO posting. This exercises the
// real reply path (RAG retrieval + persona + Claude + character clamp) so the
// output matches production, minus the final on-chain postReply step.
//
// It deliberately does NOT call loadConfig() (which requires the signing key,
// mirror URL, contract address, chain id). The only things a text-only test
// needs are the Anthropic key and the prebuilt RAG index.
//
// Usage (from client/):
//   CAW_AI_ANTHROPIC_API_KEY=sk-ant-... \
//     npx tsx src/services/CawAI/test-reply.ts "what is the optimistic archive?"
//
//   # author handle override (defaults to 'tester'):
//   CAW_AI_TEST_AUTHOR=alice npx tsx src/services/CawAI/test-reply.ts "gm"
//
//   # custom index path (defaults to the same default as the service):
//   CAW_AI_RAG_INDEX_PATH=/tmp/cawai-rag-index.jsonl npx tsx ... "..."
//
//   # interactive REPL (no arg): type a line, get a reply, repeat. Ctrl-D exits.
//   CAW_AI_ANTHROPIC_API_KEY=sk-ant-... npx tsx src/services/CawAI/test-reply.ts

import 'dotenv/config'
import { createInterface } from 'readline'
import { generateReply, clampReply, embedQuery } from './claude'
import { RagIndex } from './rag/search'
import type { CawAIConfig } from './config'

// Minimal config — only the fields the reply path actually reads. We cast to
// CawAIConfig so we can reuse generateReply()/clampReply() unchanged; the chain
// fields they don't touch are left as harmless placeholders.
function testConfig(): CawAIConfig {
  const anthropicApiKey = process.env.CAW_AI_ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    console.error('ERROR: CAW_AI_ANTHROPIC_API_KEY is required (text-only test still calls api.anthropic.com).')
    process.exit(1)
  }
  return {
    anthropicApiKey,
    ragIndexPath: process.env.CAW_AI_RAG_INDEX_PATH || './rag-index.jsonl',
    maxReplyChars: Number(process.env.CAW_AI_MAX_REPLY_CHARS) || 420,
    aiMarker: process.env.CAW_AI_MARKER ?? '',
    siteUrl: (process.env.CAW_AI_SITE_URL || process.env.SHORTURL_DOMAIN || 'https://caw.social').replace(/\/+$/, ''),
    // Unused by the reply path — placeholders so the typed object is complete.
    profileTokenId: 0,
    deployerPrivateKey: '0x' + '0'.repeat(64),
    apiUrl: 'http://localhost',
    cawActionsAddress: '0x' + '0'.repeat(40),
    chainId: 0,
    pollIntervalMs: 900_000,
    dailyUsdBudget: 20,
  } as CawAIConfig
}

async function replyTo(cfg: CawAIConfig, rag: RagIndex, author: string, text: string): Promise<void> {
  let queryEmbedding: number[] = []
  try {
    queryEmbedding = await embedQuery(text)
  } catch (e) {
    console.warn(`  [warn] embed failed (${(e as Error).message}) — proceeding with empty context`)
  }

  const retrieved = await rag.search(queryEmbedding, 8)
  const context = rag.formatForPrompt(retrieved)

  const gen = await generateReply(cfg, {
    userContent: text,
    authorHandle: author,
    retrievedContext: context,
  })

  const finalText = clampReply(gen.text, cfg.maxReplyChars, cfg.aiMarker)

  // Show what RAG surfaced so you can judge whether retrieval is helping.
  console.log('')
  if (retrieved.length > 0) {
    const sources = retrieved.map(c => `${c.path} ${c.span}`).join(', ')
    console.log(`  [retrieved ${retrieved.length} chunk(s)]: ${sources}`)
  } else {
    console.log(`  [retrieved 0 chunks — no RAG context]`)
  }
  console.log(`  [tokens: ${gen.inputTokens} in / ${gen.outputTokens} out · $${gen.usdCost.toFixed(5)}]`)
  console.log('')
  console.log('  ┌─ @cawai would reply ──────────────────────────────')
  for (const line of finalText.split('\n')) console.log(`  │ ${line}`)
  console.log(`  └─ (${finalText.length}/${cfg.maxReplyChars} chars)`)
  console.log('')
}

async function main() {
  const cfg = testConfig()
  const author = process.env.CAW_AI_TEST_AUTHOR || 'tester'

  const rag = new RagIndex()
  try {
    await rag.load(cfg.ragIndexPath)
  } catch (e) {
    console.warn(`[warn] could not load RAG index at ${cfg.ragIndexPath} (${(e as Error).message}).`)
    console.warn(`[warn] continuing WITHOUT retrieval — replies will lack CAW-specific grounding.`)
    console.warn(`[warn] build one first: npx tsx src/services/CawAI/rag/build-index.ts <out-path>`)
  }

  const arg = process.argv.slice(2).join(' ').trim()
  if (arg) {
    // One-shot mode.
    await replyTo(cfg, rag, author, arg)
    return
  }

  // Interactive REPL mode.
  console.log('CawAI offline tester — type a mention, get a reply. Ctrl-D to exit.\n')
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '@cawai> ' })
  rl.prompt()
  for await (const line of rl) {
    const text = line.trim()
    if (text) {
      try {
        await replyTo(cfg, rag, author, text)
      } catch (e) {
        console.error(`  [error] ${(e as Error).message}\n`)
      }
    }
    rl.prompt()
  }
  console.log('\nbye')
}

main().catch((e) => { console.error(e); process.exit(1) })
