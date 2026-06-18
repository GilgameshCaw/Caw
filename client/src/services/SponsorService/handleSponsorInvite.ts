// services/SponsorService/handleSponsorInvite.ts
//
// Handler for the PAID buy-a-code OTHER subtype: "sp-i:<giftCaw>:<minLen>".
//
// A buyer signs an OTHER action that tips CAW to this server's sponsor/validator
// profile (recipients[0] == our PLATFORM_SPONSOR_TOKEN_ID). The action is
// replicated to every mirror, but ONLY the mirror named as recipients[0] acts —
// that mirror holds the tipped CAW and will fund the future gift. The tip must
// cover gas; the remainder becomes the new code's gift budget.
//
// Idempotent: one PurchasedInviteCode per (senderId, cawonce). A replay/re-index
// finds the existing row and no-ops. Runs inside ActionProcessor Tx2.

import type { PrismaTransactionClient } from '../ActionProcessor/types'
import { getOwnValidatorTokenIdSync } from './validatorIdentity'
import { quoteSponsorInviteCostCaw, MAX_INVITE_GIFT_CAW, burnCostForLen } from './inviteQuote'
import { createSponsorCode } from './createSponsorCode'
import { encryptInviteCode, isInviteCodeCryptoConfigured } from './inviteCodeCrypto'

// On-chain action-text prefix for a paid invite-code purchase. Kept SHORT
// ("sp-i:" not "sponsor-invite:") because action text is calldata the validator
// pays for on every submission. The FE producer (SponsorInviteSection) and the
// ActionProcessor dispatch both reference this exact string.
export const INVITE_ACTION_PREFIX = 'sp-i:'

const WEI = 10n ** 18n
// Long-tier codes; single-use; expire 30 days after purchase.
const CODE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
const CODE_TIER = 'long' as const
// Floor for the buyer-chosen min username length. The FE offers 6/7/8+; we
// re-clamp here so a forged-low value can't make the validator front a cheaper
// burn than the gift was priced against.
const MIN_USERNAME_FLOOR = 6

/**
 * Whether THIS node is the designated minter for paid invite codes. A buy-a-code
 * action reaches every mirror; only the node with SPONSOR_INVITE_MINTER_ENABLED
 * set truthy mints. Default OFF so replica mirrors never double-mint. Set true on
 * exactly one node per validator (typically the same node that runs the sponsor
 * server / holds INVITE_CODE_ENC_KEY).
 */
function isInviteMinterEnabled(): boolean {
  const raw = (process.env.SPONSOR_INVITE_MINTER_ENABLED ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Process a "sponsor-invite:<giftCaw>:<minLen>" OTHER action. rawAction carries
 * recipients[0] = the tip-target validator profile tokenId, amounts[0] = the tip
 * in WHOLE CAW. `action.senderId`/`action.cawonce` identify the buyer + nonce.
 */
export async function handleSponsorInviteAction(
  tx: PrismaTransactionClient,
  action: { senderId: number; cawonce: number; validatorId?: number | null },
  rawAction: { text?: string; recipients?: any[]; amounts?: (string | bigint | number)[] },
): Promise<void> {
  // ── Gate 0: this mirror must be the DESIGNATED MINTER. ────────────────────
  // The buy-a-code action replicates to EVERY mirror, but a sponsor code may be
  // minted exactly once — a code minted twice (e.g. on two mirrors that share a
  // PurchasedInviteCode/SponsorCode store, or worse, two SEPARATE stores both
  // configured with the same validator profile) would either collide or hand
  // the buyer two different codes for one purchase. The `@@unique([senderId,
  // cawonce])` constraint dedups WITHIN one database, but mirrors with separate
  // databases can't see each other's rows, so we gate minting behind an explicit
  // opt-in: only the node flagged SPONSOR_INVITE_MINTER_ENABLED mints. Default
  // OFF → a replica mirror never mints, even if it shares the tipped validator
  // id. The operator sets it true on exactly ONE node per validator.
  if (!isInviteMinterEnabled()) return

  // ── Gate 1: this mirror must be the tipped validator. ─────────────────────
  const ownTokenId = getOwnValidatorTokenIdSync()
  const recipientTokenId = Number(rawAction.recipients?.[0])
  if (!ownTokenId || !Number.isInteger(recipientTokenId) || recipientTokenId !== ownTokenId) {
    // Some other mirror's validator was tipped (or no identity configured).
    // Every mirror indexes the action; only the tipped one mints.
    return
  }

  // ── Idempotency: never double-mint for the same (sender, cawonce). ────────
  const senderId = Number(action.senderId)
  const cawonce = Number(action.cawonce)
  if (!Number.isInteger(senderId) || !Number.isInteger(cawonce)) return
  const existing = await tx.purchasedInviteCode.findUnique({
    where: { senderId_cawonce: { senderId, cawonce } },
  })
  if (existing) return // already minted on a prior index pass

  // ── Parse the tip amount (whole CAW) -> wei. ──────────────────────────────
  const tipWholeCaw = (() => {
    try { return BigInt(String(rawAction.amounts?.[0] ?? '0')) } catch { return 0n }
  })()
  if (tipWholeCaw <= 0n) return
  const paidCawWei = tipWholeCaw * WEI

  // ── Pricing gate: prices must be available. ───────────────────────────────
  const quote = quoteSponsorInviteCostCaw()
  if (!quote.priceAvailable) {
    // Without live prices we can't safely price the gift; skip rather than mint
    // a free code. The buyer's tip is already on-chain; this is the documented
    // no-refund edge. (Rare — prices are cached and refreshed continuously.)
    console.warn(`[sponsor-invite] prices unavailable; skipping mint for sender=${senderId} cawonce=${cawonce}`)
    return
  }
  // NOTE: we no longer REJECT an under-gas tip here. The gift floats with real
  // costs — a tip that barely covers (or undershoots) overhead simply mints a
  // code with a small (or zero) gift, instead of silently producing NO code.
  // This removes the buy-time-vs-index-time gas-floor mismatch that could make a
  // paid purchase yield nothing: gas moving between when the FE quoted and when
  // this handler runs can't reject the mint anymore, it only shrinks the gift.
  // The FE pads the tip with a ~15% gas buffer + tells the buyer the gift size
  // fluctuates with gas, so a positive gift is the normal outcome.

  if (!isInviteCodeCryptoConfigured()) {
    console.error('[sponsor-invite] INVITE_CODE_ENC_KEY not set; cannot store buyer code — skipping mint')
    return
  }

  // Min-username length the buyer requested (text field 2), floored at 6 (the
  // shortest length the FE offers). Parsed here because the username BURN the
  // sponsor fronts depends on it.
  const minLen = (() => {
    const parts = (rawAction.text ?? '').split(':')
    const n = Number(parts[2])
    return Number.isInteger(n) && n >= MIN_USERNAME_FLOOR ? n : MIN_USERNAME_FLOOR
  })()

  // ── Gift budget = tip minus OVERHEAD (gas+LZ margin + the username burn the
  //    sponsor fronts for the shortest allowed name), clamped >= 0. Must match
  //    the FE's overhead so the recorded gift equals what the buyer intended;
  //    otherwise the validator over-fronts by the burn amount at redeem. ───────
  const overheadCaw = quote.gasMarginCaw + burnCostForLen(minLen)
  const giftWholeCaw = tipWholeCaw > overheadCaw ? tipWholeCaw - overheadCaw : 0n

  // ── Upper bound: reject an oversized gift. ────────────────────────────────
  // A single code's gift is the maxDepositCawWei a redeemer can draw into one
  // new profile in one sponsored bootstrap. Cap it at MAX_INVITE_GIFT_CAW (==
  // SponsorService's per-deposit max) so an arbitrarily large tip can't mint a
  // code that drains the validator pool in one redemption — and so a code can't
  // promise more than a single deposit could ever honour. Over-cap: no code, no
  // refund (same documented no-refund edge as the under-gas path). We REJECT
  // rather than silently clamp so the buyer isn't charged for a gift larger than
  // what they receive; the FE clamps the input to keep this unreachable in normal
  // use, so reaching here means a hand-crafted action.
  if (giftWholeCaw > MAX_INVITE_GIFT_CAW) {
    console.warn(`[sponsor-invite] gift ${giftWholeCaw} CAW exceeds cap ${MAX_INVITE_GIFT_CAW}; no code (sender=${senderId} cawonce=${cawonce})`)
    return
  }

  const giftCawWei = giftWholeCaw * WEI

  // ── Mint the code + persist the buyer's encrypted copy. ───────────────────
  // budgetCapUsdCents is a USD ceiling on redemption cost; derive it from the
  // gift's USD value so the redemption budget guard is consistent with what was
  // paid. (giftWholeCaw * cawUsdRate dollars -> cents, min 1.)
  const giftUsd = Number(giftWholeCaw) * quote.cawUsdRate
  const budgetCapUsdCents = Math.max(1, Math.ceil(giftUsd * 100))

  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MS)

  // Mint the SponsorCode INSIDE the same Tx2 transaction (pass tx) so it commits
  // atomically with the PurchasedInviteCode row below — a rollback can't orphan
  // an unretrievable code (H-1).
  const { rawCode, codeHash } = await createSponsorCode({
    tier: CODE_TIER,
    budgetCapUsdCents,
    maxDepositCawWei: giftCawWei.toString(),
    expiresAt,
    maxUses: 1,
    minUsernameLength: minLen,
    label: `bought:${senderId}`,
    purchasedByTokenId: senderId,
  }, tx as any)

  await tx.purchasedInviteCode.create({
    data: {
      purchasedByTokenId: senderId,
      senderId,
      cawonce,
      codeHash,
      codeCiphertext: encryptInviteCode(rawCode),
      giftCawWei: giftCawWei.toString(),
      paidCawWei: paidCawWei.toString(),
    },
  })

  console.log(`[sponsor-invite] minted code for buyer=${senderId} cawonce=${cawonce} gift=${giftWholeCaw} CAW`)
}
