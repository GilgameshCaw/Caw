import { PrismaClient } from '@prisma/client'
import { ethers } from 'ethers'

/**
 * Increment the locally-tracked spent amount for a session key, matching
 * what the on-chain CawActions contract does in distributeAmounts. Keeps
 * the SessionKey.spent field reasonably in sync without a live RPC call
 * on every /api/actions request.
 *
 * The validator calls this after a TxQueue entry transitions to 'done'
 * for session-key-signed actions. If the signer turns out to be the
 * token owner (not a session key), this is a no-op — owners don't have
 * a spend limit.
 *
 * The contract enforces the real limit. This tracker is an optimization
 * for the server's early-rejection check — if we under-count (e.g.
 * missed an increment), the contract still blocks at the real limit.
 * If we over-count (double-increment on retry), the user gets blocked
 * earlier than necessary but can always renew their session.
 */
export async function incrementSessionSpent(
  prisma: PrismaClient,
  payload: { data: any; domain: any; types: any },
  signedTx: string,
): Promise<void> {
  try {
    const { data, domain, types } = payload
    if (!data || !domain || !types?.ActionData) return

    // Recover signer
    let signer: string
    try {
      signer = ethers.verifyTypedData(
        domain,
        { ActionData: types.ActionData },
        data,
        signedTx,
      ).toLowerCase()
    } catch {
      return
    }

    // Compute actionCost, matching CawActions._processAction exactly:
    //   1. Base protocol cost per action type (from the if-else branch)
    //   2. distributeAmounts return value:
    //      - For WITHDRAW: SKIPS amounts[0] (withdrawal amount), sums amounts[1..n-2],
    //        plus amounts[n-1] (validator tip counted separately in the contract).
    //      - For others: sums amounts[0..n-2] plus amounts[n-1] (tip).
    //      In both cases the last element is the validator tip and always counted.
    const ACTION_COST_BY_TYPE: Record<number, bigint> = {
      0: 5000n,   // CAW
      1: 2000n,   // LIKE
      3: 4000n,   // RECAW
      4: 30000n,  // FOLLOW
      // UNLIKE (2), UNFOLLOW (5), WITHDRAW (6), OTHER (7) have no fixed protocol cost
    }
    const actionTypeNum = Number(data.actionType)
    const baseCost = ACTION_COST_BY_TYPE[actionTypeNum] ?? 0n

    // distributeAmounts returns totalWholeTokens which includes:
    //   - amounts[last] (validator tip, always)
    //   - amounts[startIndex..numRecipients-1] (recipient distributions)
    // For WITHDRAW, startIndex=1 so amounts[0] (the withdrawal amount itself)
    // is excluded from the spend total.
    const isWithdraw = actionTypeNum === 6
    let distributed = 0n
    if (Array.isArray(data.amounts) && data.amounts.length > 0) {
      const n = data.amounts.length
      const numRecipients = Array.isArray(data.recipients) ? data.recipients.length : 0
      // Validator tip (always the last element)
      try { distributed += BigInt(data.amounts[n - 1]) } catch {}
      // Recipient distributions (skip amounts[0] for withdraw)
      const startIndex = isWithdraw ? 1 : 0
      for (let i = startIndex; i < numRecipients; i++) {
        try { distributed += BigInt(data.amounts[i]) } catch {}
      }
    }
    const totalSpent = baseCost + distributed
    if (totalSpent === 0n) return

    // Identify owner — the action's senderId maps to the token owner in DB.
    const user = await prisma.user.findUnique({
      where: { tokenId: Number(data.senderId) },
      select: { address: true },
    })
    if (!user?.address) return
    const owner = user.address.toLowerCase()

    // If signer IS the owner, there's no session key to charge.
    if (signer === owner) return

    // Atomically increment spent at the DB layer. spent is stored as a string
    // (BigInt serialized), so we use raw SQL with numeric addition to avoid
    // the read-modify-write race between concurrent validator workers.
    // The cast to numeric handles PostgreSQL's text column type safely.
    const increment = totalSpent.toString()
    const result = await prisma.$executeRaw`
      UPDATE "SessionKey"
         SET "spent" = (COALESCE(NULLIF("spent", '')::numeric, 0) + ${increment}::numeric)::text,
             "updatedAt" = NOW()
       WHERE "ownerAddress" = ${owner}
         AND "sessionAddress" = ${signer}
    `
    if (result === 0) {
      // Row doesn't exist — the indexer hasn't seen this session yet.
      // That's fine; the spend check on the API side will RPC-fallback
      // and cache the session on first use.
    }
  } catch (err: any) {
    console.warn('[sessionSpendTracker] Failed to increment spent:', err?.message)
  }
}
