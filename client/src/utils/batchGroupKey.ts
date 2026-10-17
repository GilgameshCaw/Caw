/**
 * Which ActionBatch signature group a txQueue row belongs to, for the ECDSA
 * packer (buildMultiActionData) and the calldata bound in fetchPendingQueue.
 *
 * Rows of one API batch share one batch signature and must be packed as one
 * group; a row without a batchId is its own group (null here). batchId alone
 * is not enough to tell batches apart: the API allocates it as
 * Date.now() & 0x7fffffff (api/routes/actions.ts), so two batches created in
 * the same millisecond share it. Two senders' batches then packed as one
 * group revert with MixedSenders, and one sender's two batches with
 * contiguous cawonces would be checked against the first batch's signature.
 * The API stores one sender and the batch signature on every row of a
 * batch, so (senderId, batchId, signedTx) identifies the batch.
 */
export function batchGroupKey(row: { senderId?: number | null; batchId?: number | null; signedTx?: string | null }): string | null {
  if (row.batchId == null) return null
  return `${row.senderId ?? ''}:${row.batchId}:${row.signedTx ?? ''}`
}

/**
 * Sizes of the signature groups buildMultiActionData packs, in order:
 * adjacent rows with the same non-null batchGroupKey form one group.
 */
export function adjacentGroupSizes(rows: ReadonlyArray<Parameters<typeof batchGroupKey>[0]>): number[] {
  const sizes: number[] = []
  let lastKey: string | null = null
  for (const row of rows) {
    const key = batchGroupKey(row)
    if (key != null && key === lastKey && sizes.length > 0) {
      sizes[sizes.length - 1] += 1
    } else {
      sizes.push(1)
    }
    lastKey = key
  }
  return sizes
}
