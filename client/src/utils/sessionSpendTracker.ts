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

    // Compute the amount this action spent. Matches distributeAmounts in the
    // contract: sum of amounts except the last (which is the validator tip)
    // plus the fixed protocol cost for the action type.
    const ACTION_COST_BY_TYPE: Record<number, bigint> = {
      0: 5000n,   // CAW
      1: 2000n,   // LIKE
      3: 4000n,   // RECAW
      4: 30000n,  // FOLLOW
      // UNLIKE (2), UNFOLLOW (5), WITHDRAW (6), OTHER (7) have no fixed cost
    }
    const actionTypeNum = Number(data.actionType)
    const baseCost = ACTION_COST_BY_TYPE[actionTypeNum] ?? 0n

    // Sum distributed amounts (all entries including the last = validator tip)
    let distributed = 0n
    if (Array.isArray(data.amounts)) {
      for (const amt of data.amounts) {
        try { distributed += BigInt(amt) } catch {}
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

    // Update the SessionKey row. If it doesn't exist, skip — the indexer
    // will populate it eventually and future actions will be tracked.
    const existing = await prisma.sessionKey.findUnique({
      where: { ownerAddress_sessionAddress: { ownerAddress: owner, sessionAddress: signer } },
    })
    if (!existing) return

    const newSpent = BigInt(existing.spent || '0') + totalSpent
    await prisma.sessionKey.update({
      where: { ownerAddress_sessionAddress: { ownerAddress: owner, sessionAddress: signer } },
      data: { spent: newSpent.toString() },
    })
  } catch (err: any) {
    console.warn('[sessionSpendTracker] Failed to increment spent:', err?.message)
  }
}
