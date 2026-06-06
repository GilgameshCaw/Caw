// CawAI/index.ts
//
// Service entrypoint. Designed to be runnable two ways:
//
//   1. As a long-running Node process (VPS / Fly / dev box):
//        node -r ts-node/register client/src/services/CawAI/index.ts
//      Worker stays up, loops every cfg.pollIntervalMs.
//
//   2. As a Lambda handler (recommended for the reference operator
//      deployment): one Lambda invocation == one polling pass. The
//      EventBridge rule fires every 15 min and the handler exits
//      after processing pending mentions. State persists via S3 (or
//      EFS) at the path passed to BudgetTracker.
//
// The Service-interface export keeps it compatible with runServices.ts
// if an operator chooses to bundle it with the rest of the backend on
// one machine. The default recommendation is to run it OUT-OF-PROCESS
// from production for prompt-injection isolation — even though the
// LLM has no tools, the operator's Anthropic key still sits in the
// bot's env, and minimizing its blast radius is good hygiene.

import { Service, HeartbeatContext } from '../../Service'
import { loadConfig, CawAIConfig } from './config'
import { fetchNewMentions, markReplied, Cursor } from './mentionWatcher'
import { generateReply, clampReply } from './claude'
import { postReply } from './reply'
import { BudgetTracker } from './budget'
import { RagIndex } from './rag/search'

const SERVICE_NAME = 'CawAI'

async function runOnce(
  cfg: CawAIConfig,
  rag: RagIndex,
  budget: BudgetTracker,
  cursor: Cursor,
): Promise<Cursor> {
  if (!budget.hasBudget()) {
    console.log(`[CawAI] daily budget exhausted (cap=$${cfg.dailyUsdBudget}) — skipping pass`)
    return cursor
  }

  const { mentions, newCursor } = await fetchNewMentions(cfg, cursor)
  if (mentions.length === 0) {
    console.log(`[CawAI] no new mentions`)
    return newCursor
  }
  console.log(`[CawAI] processing ${mentions.length} new mentions`)

  for (const m of mentions) {
    if (!budget.hasBudget()) {
      console.log(`[CawAI] budget exhausted mid-batch — stopping`)
      break
    }

    // RAG retrieve. Empty index = empty context = bot falls back to
    // its system-prompt-trained "I don't know" behavior.
    // TODO: embed m.cawText for the query
    const retrieved = await rag.search([], 8)
    const context = rag.formatForPrompt(retrieved)

    const gen = await generateReply(cfg, {
      userContent: m.cawText,
      authorHandle: m.authorUsername,
      retrievedContext: context,
    })

    await budget.record(gen.usdCost)

    if (!gen.text || gen.text.trim().length === 0) {
      console.warn(`[CawAI] empty model output for cawId=${m.cawId} — skipping`)
      continue
    }

    const finalText = clampReply(gen.text, cfg.maxReplyChars, cfg.aiMarker)

    const result = await postReply(cfg, {
      parentCawId: m.cawId,
      text: finalText,
    })

    if (result.ok) {
      await markReplied(cfg, [m.notificationId])
      console.log(`[CawAI] replied to cawId=${m.cawId} as cawId=${result.cawId}`)
    } else {
      console.warn(`[CawAI] postReply failed for cawId=${m.cawId}: ${result.error}`)
    }
  }

  return newCursor
}

export const cawAIService: Service = {
  name: SERVICE_NAME,

  validateConfig(_cfg: unknown) {
    try { loadConfig(); return [] }
    catch (e) { return [e as Error] }
  },

  start(_configParam: unknown, ctx: HeartbeatContext) {
    const cfg = loadConfig()
    ctx.declareLoop('poll', cfg.pollIntervalMs * 3)

    let cursor: Cursor = { lastSeenNotificationId: 0 }
    const rag = new RagIndex()
    const budget = new BudgetTracker('./state/cawai-budget.json', cfg.dailyUsdBudget)

    let stopped = false
    let timer: NodeJS.Timeout | null = null

    const started = (async () => {
      await rag.load(cfg.ragIndexPath)
      await budget.load()
      console.log(`[CawAI] started; profile=${cfg.profileTokenId} poll=${cfg.pollIntervalMs}ms cap=$${cfg.dailyUsdBudget}`)
    })()

    const tick = async () => {
      if (stopped) return
      try {
        cursor = await runOnce(cfg, rag, budget, cursor)
        ctx.heartbeat('poll')
      } catch (e) {
        console.error(`[CawAI] tick error:`, e)
      } finally {
        if (!stopped) timer = setTimeout(tick, cfg.pollIntervalMs)
      }
    }

    started.then(() => { timer = setTimeout(tick, 1000) })

    return {
      started,
      async stop() {
        stopped = true
        if (timer) clearTimeout(timer)
      },
      async stats() {
        return {
          profileTokenId: cfg.profileTokenId,
          lastSeenNotificationId: cursor.lastSeenNotificationId,
          dailyBudgetRemainingUsd: budget.remaining(),
        }
      },
    }
  },
}

// Lambda handler — `handler(event, context)` shape so an EventBridge
// scheduled rule can trigger one polling pass and exit. Operators
// running on Lambda set the schedule cadence at the EventBridge rule
// level, not via CAW_AI_POLL_INTERVAL_MS.
export async function lambdaHandler(): Promise<{ ok: true }> {
  const cfg = loadConfig()
  const rag = new RagIndex()
  await rag.load(cfg.ragIndexPath)
  const budget = new BudgetTracker('/tmp/cawai-budget.json', cfg.dailyUsdBudget)
  await budget.load()
  const cursor: Cursor = { lastSeenNotificationId: 0 } // TODO: load from S3
  await runOnce(cfg, rag, budget, cursor)
  return { ok: true }
}
