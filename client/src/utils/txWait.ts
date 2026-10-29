/**
 * Bounded wait for a sent transaction's receipt.
 *
 * ethers' `tx.wait()` has no timeout by default. A receipt that never comes
 * (tx dropped from the mempool, an RPC that stops answering) leaves the
 * validator poll awaiting forever, until the poll watchdog restarts the
 * service.
 *
 * The timeout is also passed to `tx.wait()` so ethers drops its block
 * listener when we stop waiting. Its own timer only starts after the first
 * receipt lookup (and the replacement check), so the outer timer here also
 * covers an RPC call that hangs before that.
 *
 * Callers must treat TxWaitTimeoutError as "unknown outcome", not as a
 * revert: the tx may still land after we stop waiting. The message contains
 * "timeout" so the validator's transient-error checks keep the rows pending.
 * The code is TX_WAIT_TIMEOUT, not ethers' TIMEOUT, so a retry ladder that
 * re-sends on TIMEOUT can tell it apart.
 */

export const TX_WAIT_TIMEOUT_CODE = 'TX_WAIT_TIMEOUT'

export class TxWaitTimeoutError extends Error {
  readonly code = TX_WAIT_TIMEOUT_CODE
  constructor(public readonly txHash: string, public readonly timeoutMs: number) {
    super(`receipt wait timeout after ${Math.round(timeoutMs / 1000)}s (tx ${txHash})`)
    this.name = 'TxWaitTimeoutError'
  }
}

export interface WaitableTx<R> {
  hash: string
  wait(confirms?: number, timeout?: number): Promise<R>
}

export async function waitForReceipt<R>(tx: WaitableTx<R>, timeoutMs: number): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TxWaitTimeoutError(tx.hash, timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([tx.wait(1, timeoutMs), deadline])
  } catch (err: any) {
    // ethers' own wait timeout, or a request timeout inside it.
    if (err?.code === 'TIMEOUT') throw new TxWaitTimeoutError(tx.hash, timeoutMs)
    throw err
  } finally {
    clearTimeout(timer)
  }
}
