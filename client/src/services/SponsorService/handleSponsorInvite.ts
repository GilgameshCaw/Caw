// services/SponsorService/handleSponsorInvite.ts
//
// Handler for the PAID buy-a-code OTHER subtype: "sponsor-invite:<giftCaw>:<minLen>".
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
import { quoteSponsorInviteCostCaw } from './inviteQuote'
import { createSponsorCode } from './createSponsorCode'
import { encryptInviteCode, isInviteCodeCryptoConfigured } from './inviteCodeCrypto'

const WEI = 10n ** 18n
// Long-tier codes; single-use; expire 30 days after purchase.
const CODE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
const CODE_TIER = 'long' as const
// The on-chain min username length the buyer can pick is clamped to >= 8 by the
// FE; we re-clamp here as a server-side floor (never below 8 for bought codes).
const MIN_USERNAME_FLOOR = 8

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

  // ── Pricing gate: tip must clear the gas floor. ───────────────────────────
  const quote = quoteSponsorInviteCostCaw()
  if (!quote.priceAvailable) {
    // Without live prices we can't safely price the gift; skip rather than mint
    // a free code. The buyer's tip is already on-chain; this is the documented
    // no-refund edge. (Rare — prices are cached and refreshed continuously.)
    console.warn(`[sponsor-invite] prices unavailable; skipping mint for sender=${senderId} cawonce=${cawonce}`)
    return
  }
  if (tipWholeCaw <= quote.gasFloorCaw) {
    // Under-gas: no code. The buyer's My-Invite-Codes list shows nothing for
    // this action, which the FE surfaces as "payment didn't cover gas." No
    // refund (documented). Nothing persisted.
    console.warn(`[sponsor-invite] tip ${tipWholeCaw} CAW below gas floor ${quote.gasFloorCaw}; no code (sender=${senderId})`)
    return
  }

  if (!isInviteCodeCryptoConfigured()) {
    console.error('[sponsor-invite] INVITE_CODE_ENC_KEY not set; cannot store buyer code — skipping mint')
    return
  }

  // ── Gift budget = tip minus the gas+LZ margin (clamped >= 0). ─────────────
  const giftWholeCaw = tipWholeCaw > quote.gasMarginCaw ? tipWholeCaw - quote.gasMarginCaw : 0n
  const giftCawWei = giftWholeCaw * WEI

  // Min-username length the buyer requested (text field 2), floored at 8.
  const minLen = (() => {
    const parts = (rawAction.text ?? '').split(':')
    const n = Number(parts[2])
    return Number.isInteger(n) && n >= MIN_USERNAME_FLOOR ? n : MIN_USERNAME_FLOOR
  })()

  // ── Mint the code + persist the buyer's encrypted copy. ───────────────────
  // budgetCapUsdCents is a USD ceiling on redemption cost; derive it from the
  // gift's USD value so the redemption budget guard is consistent with what was
  // paid. (giftWholeCaw * cawUsdRate dollars -> cents, min 1.)
  const giftUsd = Number(giftWholeCaw) * quote.cawUsdRate
  const budgetCapUsdCents = Math.max(1, Math.ceil(giftUsd * 100))

  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MS)

  const { rawCode, codeHash } = await createSponsorCode({
    tier: CODE_TIER,
    budgetCapUsdCents,
    maxDepositCawWei: giftCawWei.toString(),
    expiresAt,
    maxUses: 1,
    minUsernameLength: minLen,
    label: `bought:${senderId}`,
    purchasedByTokenId: senderId,
  })

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
