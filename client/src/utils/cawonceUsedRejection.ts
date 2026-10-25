// Settles a TxQueue row that the simulation rejected with "Cawonce already
// used" while other rows of its batch passed.
//
// When every row of a batch is rejected, ValidatorService sends each
// "Cawonce already used" row through resolveCawonceUsed, so a row whose
// action a peer mirror landed ends as validated_by_peer. When some rows
// passed, the rejected ones used to go straight to markTxQueueFailed with
// the raw rejection. This gives them the same resolution.
//
// The validator passes in its own resolveCawonceUsed and status writes, so
// this file has no prisma or provider of its own.

export type CawonceUsedResolution = 'done' | 'failed' | 'awaiting_indexer'

/**
 * What the caller still has to do with the row:
 *   'done'             — marked validated_by_peer here; reconcile as succeeded.
 *   'awaiting_indexer' — moved to awaiting_indexer here; the recheck in
 *                        fetchPendingQueue takes it from there.
 *   'failed'           — nothing written; the caller fails the row as before.
 *   'retry'            — resolve threw (reset to pending here), or a status
 *                        write threw (the row is left as it was). Leave the
 *                        row out; a row still in processing goes back to
 *                        pending in fetchPendingQueue's 30-second sweep.
 */
export type CawonceUsedSettlement = CawonceUsedResolution | 'retry'

export interface CawonceUsedSettlers {
  resolve: () => Promise<CawonceUsedResolution>
  markValidatedByPeer: () => Promise<unknown>
  markAwaitingIndexer: () => Promise<unknown>
  resetToPending: (err: unknown) => Promise<unknown>
  writeFailed: (err: unknown) => void
}

export function isCawonceUsedRejection(rejection: string | null | undefined): boolean {
  return (rejection ?? '').includes('Cawonce already used')
}

// The rows that passed were already submitted, so nothing here may throw into
// the batch's catch: the poll's catch would put those rows back to pending,
// and the multi-network sub-batch catch would mark them failed.
export async function settleCawonceUsedRejection(s: CawonceUsedSettlers): Promise<CawonceUsedSettlement> {
  let resolution: CawonceUsedResolution
  try {
    resolution = await s.resolve()
  } catch (err) {
    await tryWrite(s, () => s.resetToPending(err))
    return 'retry'
  }
  if (resolution === 'failed') return 'failed'
  const wrote = await tryWrite(s, resolution === 'done' ? () => s.markValidatedByPeer() : () => s.markAwaitingIndexer())
  return wrote ? resolution : 'retry'
}

async function tryWrite(s: CawonceUsedSettlers, write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write()
    return true
  } catch (err) {
    s.writeFailed(err)
    return false
  }
}
