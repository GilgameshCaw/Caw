// Status writes for a multi-network sub-batch in ValidatorService, and what
// its catch does with the rows when the error isn't transient.
//
// The writes after a simulation or a submission used to run in a
// Promise.all. A write that threw sent the loop to the sub-batch's catch
// while the other rows' writes were still running, and that catch wrote
// `failed` (by id alone) to every row of the sub-batch: rows already done,
// and rows the simulation had rejected and that were never sent.
//
// The validator passes in its own status writes, so this file has no prisma
// of its own.

/**
 * Run `write` for every row and wait for all of them. A write that throws
 * is passed to `writeFailed` and the row is left as it is; a row still in
 * processing goes back to pending in fetchPendingQueue's 30-second sweep.
 * Never throws.
 */
export async function settleEachWrite<T extends { id: number }>(
  entries: T[],
  write: (entry: T, idx: number) => Promise<unknown>,
  writeFailed: (ids: number[], err: unknown) => void,
): Promise<void> {
  const results = await Promise.allSettled(entries.map(async (entry, idx) => write(entry, idx)))
  results.forEach((result, idx) => {
    if (result.status === 'rejected') writeFailed([entries[idx].id], result.reason)
  })
}

export interface SubBatchFailure<T extends { id: number }> {
  entries: T[]
  /** The rows put in the transaction, or null when the error came before that. */
  sentIds: ReadonlySet<number> | null
  /** The ids, of those given, whose row is still in processing. */
  stillProcessing: (ids: number[]) => Promise<number[]>
  /** Put rows still in processing back to pending. */
  resetToPending: (ids: number[]) => Promise<unknown>
  markFailed: (entry: T) => Promise<unknown>
  writeFailed: (ids: number[], err: unknown) => void
}

/**
 * Only the rows that were sent share the error, and only while they are
 * still in processing: a row another write has moved on (done,
 * validated_by_peer, ...) keeps its status. Rows the simulation rejected
 * were never sent; they go back to pending and the next poll simulates them
 * again. Never throws.
 */
export async function failSubBatch<T extends { id: number }>(f: SubBatchFailure<T>): Promise<void> {
  const sent = f.sentIds ? f.entries.filter(e => f.sentIds!.has(e.id)) : f.entries
  const unsentIds = f.sentIds ? f.entries.filter(e => !f.sentIds!.has(e.id)).map(e => e.id) : []

  if (unsentIds.length > 0) {
    try {
      await f.resetToPending(unsentIds)
    } catch (err) {
      f.writeFailed(unsentIds, err)
    }
  }

  const sentIds = sent.map(e => e.id)
  if (sentIds.length === 0) return
  let processing: Set<number>
  try {
    processing = new Set(await f.stillProcessing(sentIds))
  } catch (err) {
    f.writeFailed(sentIds, err)
    return
  }
  await settleEachWrite(sent.filter(e => processing.has(e.id)), entry => f.markFailed(entry), f.writeFailed)
}
