/**
 * Validator txs whose receipt wait timed out (TxWaitTimeoutError), and the
 * actions they carry.
 *
 * A timed-out tx may still land. Its rows go back to pending, and while no
 * blocks are mined the next poll's simulation still passes for them, so
 * without a hold every poll sends the same actions again; when blocks
 * resume, the first tx lands and the rest revert. The validator skips the
 * held actions until the tx is settled:
 *   - it has a receipt (landed or reverted): the next simulation sees the
 *     chain as it is, and "Cawonce already used" goes to resolveCawonceUsed;
 *   - the account's mined nonce has moved past it: some other tx took that
 *     nonce, so this one can't land any more;
 *   - maxHoldMs has passed: a tx dropped from the mempool would otherwise
 *     hold its rows forever. A long halt then costs one re-send per
 *     maxHoldMs instead of one per poll.
 * An RPC error, or a check that takes longer than callTimeoutMs, keeps the
 * hold, so a slow RPC can't stall the validator poll.
 *
 * In memory only: a restart forgets the holds and the next poll may send
 * the rows once more, as before.
 */

export interface InFlightTx {
  hash: string
  nonce: number
  /** actionKey() of every action in the tx */
  keys: string[]
  heldSince: number
}

export interface InFlightChain {
  getTransactionReceipt(hash: string): Promise<unknown | null>
  getTransactionCount(address: string, blockTag: 'latest'): Promise<number>
}

export type SettleReason = 'receipt' | 'nonce-used' | 'expired'

export const actionKey = (senderId: number | string, cawonce: number | string) =>
  `${Number(senderId)}-${Number(cawonce)}`

export class InFlightTxs {
  private txs: InFlightTx[] = []

  constructor(
    private readonly maxHoldMs: number,
    private readonly now: () => number = Date.now,
    private readonly callTimeoutMs: number = 10_000,
  ) {}

  private bounded<T>(call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`in-flight check timeout after ${this.callTimeoutMs}ms`)), this.callTimeoutMs)
    })
    return Promise.race([call, deadline]).finally(() => clearTimeout(timer))
  }

  add(hash: string, nonce: number, keys: string[]): void {
    this.txs = this.txs.filter(t => t.hash !== hash)
    this.txs.push({ hash, nonce, keys, heldSince: this.now() })
  }

  get size(): number {
    return this.txs.length
  }

  heldKeys(): Set<string> {
    return new Set(this.txs.flatMap(t => t.keys))
  }

  /** Drop every tx that is settled; returns what was dropped and why. */
  async settle(chain: InFlightChain, address: string): Promise<Array<{ tx: InFlightTx; reason: SettleReason }>> {
    const settled: Array<{ tx: InFlightTx; reason: SettleReason }> = []
    const open: InFlightTx[] = []
    for (const tx of this.txs) {
      if (this.now() - tx.heldSince >= this.maxHoldMs) {
        settled.push({ tx, reason: 'expired' })
        continue
      }
      try {
        if (await this.bounded(chain.getTransactionReceipt(tx.hash))) {
          settled.push({ tx, reason: 'receipt' })
          continue
        }
      } catch { /* keep the hold */ }
      open.push(tx)
    }
    if (open.length > 0) {
      let mined: number | null = null
      try {
        mined = await this.bounded(chain.getTransactionCount(address, 'latest'))
      } catch { /* keep the holds */ }
      for (let i = open.length - 1; i >= 0; i--) {
        // 'latest' count = nonces 0..count-1 are mined.
        if (mined != null && mined > open[i].nonce) {
          settled.push({ tx: open[i], reason: 'nonce-used' })
          open.splice(i, 1)
        }
      }
    }
    this.txs = open
    return settled
  }
}
