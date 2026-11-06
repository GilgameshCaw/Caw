import { ACTION_BASELINE_AND_CAP } from './cawActionCosts'

// Fixed protocol cost by action type, as CawActions charges it. The signed data
// carries the numeric code; /api/actions also accepts the lower-case name.
const FIXED_COST: Record<string, bigint> = {
  0: ACTION_BASELINE_AND_CAP.CAW.baseline, caw: ACTION_BASELINE_AND_CAP.CAW.baseline,
  1: ACTION_BASELINE_AND_CAP.LIKE.baseline, like: ACTION_BASELINE_AND_CAP.LIKE.baseline,
  3: ACTION_BASELINE_AND_CAP.RECAW.baseline, recaw: ACTION_BASELINE_AND_CAP.RECAW.baseline,
  4: ACTION_BASELINE_AND_CAP.FOLLOW.baseline, follow: ACTION_BASELINE_AND_CAP.FOLLOW.baseline,
}

type HeldRow = { pendingDepositTxHash: string | null; payload: unknown }

/**
 * The L2 balance, in wei, that the rows held for a deposit need: the fixed cost
 * plus every signed amount (tips, recipients, a withdrawal), which are in whole
 * CAW. Same sum as the FE's budget check in signAndSubmit, so a row the FE let
 * through on a deposit is covered once that deposit lands.
 *
 * Rows without a hash aren't waiting on a deposit and don't count. It leaves out
 * a session's implicit tip, which isn't in the signed data. A row that costs more
 * than this is simulated and fails as it would have anyway.
 */
export function depositHoldCostWei(rows: HeldRow[]): bigint {
  let whole = 0n
  for (const row of rows) {
    if (!row.pendingDepositTxHash) continue
    const data = (row.payload as { data?: { actionType?: unknown; amounts?: unknown } } | null)?.data
    whole += FIXED_COST[String(data?.actionType)] ?? 0n
    if (!Array.isArray(data?.amounts)) continue
    for (const amount of data.amounts) {
      try { whole += BigInt(amount) } catch { /* unparseable: the validator rejects it */ }
    }
  }
  return whole * 10n ** 18n
}
