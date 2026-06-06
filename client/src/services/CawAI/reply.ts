// CawAI/reply.ts
//
// Posts the generated reply as a threaded CAW action under the bot's
// sponsor wallet.
//
// IMPORTANT — security boundary: this module signs CAW actions and is
// the ONLY module in the bot that touches the sponsor key. The LLM
// never sees it; mentionWatcher / persona / claude never sees it.
// All keys live here.
//
// Reply structure:
//   - Single CAW post, threaded as reply to the @-mentioning caw.
//   - No embedded tips (bot is replying, not promoting).
//   - Uses the same client-side signing path as a regular user — no
//     special "bot lane". From the protocol's POV the bot is a normal
//     authenticated profile.
//
// The bot uses a long-lived Quick Sign session bound to its profile
// tokenId. The sponsor key creates the session once (via the sponsored
// authenticate path on first run); subsequent replies use the session
// key directly, no on-chain action per reply.

import type { CawAIConfig } from './config'

export type ReplyInput = {
  parentCawId: number
  text: string                  // already clamped by claude.clampReply
}

export type ReplyResult = {
  ok: boolean
  cawId?: number                // bot's newly-created caw row id
  error?: string
}

export async function postReply(
  cfg: CawAIConfig,
  input: ReplyInput,
): Promise<ReplyResult> {
  // TODO:
  //   1. Load session key for cfg.profileTokenId from local secret
  //      store (encrypted with sponsorPrivateKey-derived KEK).
  //   2. If no session or expired: call sponsored authenticate path
  //      using sponsor wallet to create one (rare — once per session
  //      window).
  //   3. Build CawAction: action=POST, originalCawId=parentCawId,
  //      text=input.text, recipients=[], amounts=[].
  //   4. Sign with session key.
  //   5. POST to cfg.apiUrl + /api/actions (the existing FE endpoint).
  //   6. Return the assigned cawId.
  //
  // Hard limits enforced HERE in code, not via LLM cooperation:
  //   - exactly one reply per call (no loop, no batch).
  //   - text.length <= cfg.maxReplyChars (assert; throw if not).
  //   - recipients/amounts always empty (bot never tips on replies).
  void cfg; void input
  return { ok: false, error: 'not implemented' }
}
