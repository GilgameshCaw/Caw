// CawAI/reply.ts
//
// Posts the generated reply as a threaded CAW action signed by the
// deployer wallet. No Quick Sign session bootstrap — the deployer
// owns the bot profile and signs every reply directly via
// wallet.signTypedData. Simple, no session management overhead.
//
// SECURITY BOUNDARY: this module is the ONLY place the deployer key
// is used. The LLM never sees it; mentionWatcher / persona / claude
// never see it. The key is loaded once from cfg at call time.
//
// Reply structure:
//   - actionType = 0 (CAW post)
//   - threaded to the parent caw via receiverId + receiverCawonce
//   - no embedded tips (bot doesn't tip on replies)
//   - amounts = [validatorTip] trailing entry per the non-session-key path

import { ethers } from 'ethers'
import SmlTxt from 'smltxt'
import type { CawAIConfig } from './config'

// EIP-712 domain (built from env at call time, not module-load time)
function buildDomain(cfg: CawAIConfig) {
  return {
    name: 'Caw Protocol',
    version: '1',
    chainId: cfg.chainId,
    verifyingContract: cfg.cawActionsAddress,
  }
}

const TYPES = {
  ActionData: [
    { name: 'actionType',      type: 'uint8'    },
    { name: 'senderId',        type: 'uint32'   },
    { name: 'receiverId',      type: 'uint32'   },
    { name: 'receiverCawonce', type: 'uint32'   },
    { name: 'networkId',       type: 'uint32'   },
    { name: 'cawonce',         type: 'uint32'   },
    { name: 'recipients',      type: 'uint32[]' },
    { name: 'amounts',         type: 'uint64[]' },
    { name: 'text',            type: 'bytes'    },
  ],
}

// Lazy smltxt singleton — table is ~380 KB; parse once.
let _sml: SmlTxt | undefined
function getSml(): SmlTxt {
  if (!_sml) _sml = SmlTxt.fromPkg()
  return _sml
}

function compressText(text: string): string {
  if (!text) return '0x'
  const bytes = getSml().compress(text)
  return '0x' + Buffer.from(bytes).toString('hex')
}

// Fetch the current validator tip from the mirror's tip-config endpoint.
// Falls back to 26000 CAW (same default as the FE) if the endpoint is
// unreachable or returns an unparseable body.
async function fetchValidatorTip(apiUrl: string): Promise<bigint> {
  try {
    const resp = await fetch(`${apiUrl}/api/validator-analytics/tip-config`)
    if (!resp.ok) return 26000n
    const data = await resp.json() as { baseTip?: string }
    const tip = BigInt(data.baseTip ?? '26000')
    return tip > 0n ? tip : 26000n
  } catch {
    return 26000n
  }
}

// Fetch (receiverId, receiverCawonce) from the parent caw so we can
// build the threaded reply correctly.
async function fetchParentCawInfo(
  apiUrl: string,
  parentCawId: number,
): Promise<{ receiverId: number; receiverCawonce: number }> {
  const resp = await fetch(`${apiUrl}/api/caws/${parentCawId}`)
  if (!resp.ok) throw new Error(`GET /api/caws/${parentCawId} returned ${resp.status}`)
  const data = await resp.json() as { userId?: number; cawonce?: number }
  const receiverId = data.userId
  const receiverCawonce = data.cawonce
  if (!receiverId || !receiverCawonce) {
    throw new Error(`Parent caw ${parentCawId} missing userId or cawonce`)
  }
  return { receiverId, receiverCawonce }
}

// Generate a cawonce for the bot's reply. We use a large random number
// in the uint32 range. The server will reject on collision (409) and
// index.ts can log and retry next poll cycle — acceptable for a bot.
function randomCawonce(): number {
  return Math.floor(Math.random() * 0xffff_ffff) + 1
}

export type ReplyInput = {
  parentCawId: number
  text: string                  // already clamped by claude.clampReply
}

export type ReplyResult = {
  ok: boolean
  cawId?: number                // bot's newly-created caw row id
  error?: string
}

// networkId = 1 (Uruk / the reference network). This matches CLIENT_ID
// used by the reference deployment. Forks on other networks should
// override this.
const NETWORK_ID = 1

export async function postReply(
  cfg: CawAIConfig,
  input: ReplyInput,
): Promise<ReplyResult> {
  // Hard guard: never post if the text is over the limit. The caller
  // (index.ts:75) already clamped via clampReply, but we check again
  // here as a code-level invariant. Throw rather than silently truncate.
  if (input.text.length > cfg.maxReplyChars) {
    throw new Error(
      `postReply: text too long (${input.text.length} > ${cfg.maxReplyChars}). ` +
      `clampReply must run before postReply.`
    )
  }

  const wallet = new ethers.Wallet(cfg.deployerPrivateKey)
  const domain = buildDomain(cfg)

  const [{ receiverId, receiverCawonce }, validatorTip] = await Promise.all([
    fetchParentCawInfo(cfg.apiUrl, input.parentCawId),
    fetchValidatorTip(cfg.apiUrl),
  ])

  const cawonce = randomCawonce()
  const compressedText = compressText(input.text)

  const message = {
    actionType:      0,                     // CAW post
    senderId:        cfg.profileTokenId,
    receiverId,
    receiverCawonce,
    networkId:       NETWORK_ID,
    cawonce,
    recipients:      [] as number[],
    amounts:         [validatorTip.toString()],  // trailing validator tip (non-session path)
    text:            compressedText,
  }

  const signature = await wallet.signTypedData(domain, { ActionData: TYPES.ActionData }, message)

  // POST body mirrors exactly what the FE sends in actions.ts:1449
  const payload = {
    data: message,
    domain,
    types: TYPES,
    signature,
  }

  const resp = await fetch(`${cfg.apiUrl}/api/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    return { ok: false, error: `POST /api/actions ${resp.status}: ${body}` }
  }

  const json = await resp.json().catch(() => ({})) as { cawId?: number }
  return { ok: true, cawId: json.cawId }
}
