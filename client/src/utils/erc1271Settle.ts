import { TxWaitTimeoutError } from './txWait'

/**
 * What to do with a row of an ERC-1271 group whose submit failed.
 *
 * A failed submit does not mean the action did not land:
 *   - the receipt wait timed out, and the tx is still pending or landed late
 *   - the tx landed just before a restart; after the restart the row went
 *     back to pending and was sent again, and the second tx reverts with
 *     CawonceUsed
 *   - a peer mirror landed the same action first
 * Marking every row failed records a failure for an action that is on
 * chain. The ECDSA bisect path checks resolveCawonceUsed for the same reason.
 *
 * So ask the cawonce bitmap first (CawActions.isCawonceUsed; the ERC-1271
 * sibling applies actions through CawActions, so they share it), and only
 * run resolveCawonceUsed for a cawonce that is used. The order matters on
 * this path: submitERC1271Actions sends even when estimateGas fails, so a
 * row put back to 'pending' on resolveCawonceUsed's 'awaiting_indexer' (or
 * on a used cawonce that is not ours) would be sent again and revert every
 * poll. Used cawonces therefore end as validated_by_peer, awaiting_indexer
 * (rechecked by fetchPendingQueue without re-sending) or failed, never
 * pending.
 *
 * A cawonce that is not used goes back to 'pending' only when the submit
 * error is retryable (isRetryableERC1271SubmitError): an unknown outcome
 * after the send (the tx may be dropped or still in the mempool; if it lands
 * meanwhile, the re-send reverts and this check settles the row next time),
 * or an RPC blip before anything was sent. The same holds when the bitmap
 * can't be read. Any other error keeps its old verdict, failed.
 */

/**
 * Whether a failed ERC-1271 submit may go back to 'pending' (see above).
 *
 *   - receipt wait timeout: unknown outcome.
 *   - after the send, anything but a revert (CALL_EXCEPTION from the
 *     receipt's status 0): an RPC error from the receipt lookup inside
 *     tx.wait(), or a replaced tx. The tx may still land, so this is an
 *     unknown outcome too, not a failure. tx.wait() throws RPC errors only
 *     from its first lookups, right after the send, so the tx is usually
 *     still in the mempool then.
 *   - before the send (fee data, nonce, the broadcast itself): a transient
 *     RPC error, as in the ECDSA caller, or a nonce held by another of our
 *     txs (NONCE_EXPIRED, REPLACEMENT_UNDERPRICED). The latter is what the
 *     re-send after an unknown outcome hits while the first tx is still in
 *     flight, and it clears once that tx is mined or dropped. Any other
 *     error would put the row back every poll, and nothing times out a
 *     pending row.
 *
 * "Sent" means sendTransaction returned. ethers' broadcastTransaction also
 * reads the block number and network alongside the broadcast, so an error
 * there can come after the tx went out; it is then retried only as above,
 * and the re-send reverts with CawonceUsed and settles via the bitmap.
 */
export function isRetryableERC1271SubmitError(
  err: any,
  sent: boolean,
  isTransientRpcError: (err: any) => boolean,
): boolean {
  if (err instanceof TxWaitTimeoutError) return true
  if (sent) return err?.code !== 'CALL_EXCEPTION'
  if (err?.code === 'NONCE_EXPIRED' || err?.code === 'REPLACEMENT_UNDERPRICED') return true
  return isTransientRpcError(err)
}

export type FailedERC1271Verdict =
  | { kind: 'landed' }
  | { kind: 'awaiting_indexer' }
  | { kind: 'pending' }
  | { kind: 'failed'; reason: string }

export async function settleFailedERC1271Row(opts: {
  submitError: string
  retryable: boolean
  isCawonceUsed: () => Promise<boolean>
  resolveCawonceUsed: () => Promise<'done' | 'failed' | 'awaiting_indexer'>
}): Promise<FailedERC1271Verdict> {
  let used: boolean | null
  try {
    used = await opts.isCawonceUsed()
  } catch {
    used = null
  }
  if (used === true) {
    const resolution = await opts.resolveCawonceUsed()
    if (resolution === 'done') return { kind: 'landed' }
    if (resolution === 'awaiting_indexer') return { kind: 'awaiting_indexer' }
    return { kind: 'failed', reason: 'Cawonce already used' }
  }
  if (opts.retryable) return { kind: 'pending' }
  return { kind: 'failed', reason: opts.submitError }
}
