/**
 * Split ERC-1271 txQueue rows into the units the validator submits to
 * CawActionsERC1271.processActionsERC1271, one unit per tx.
 *
 * The contract reads packedActions as one `[uint16 groupSize][actions]`
 * segment per signature group, and verifies a group of 1 against the
 * ActionData digest and a larger group against the ActionBatch digest.
 * The validator packs a single uint16 count for the whole tx (as do the
 * decoders downstream of it: submitERC1271Actions' receipt check, the
 * RawEventsGatherer ERC-1271 paths and the validator backstop), so the two
 * formats agree only when a tx carries exactly one group. Mixing two
 * senders, or two single-signed rows of one sender, made the contract
 * check every action against the first signature and revert the whole tx.
 *
 * Groups:
 *   - rows of one batch: one ActionBatch signature over all of them, never
 *     split across txs. A batch is keyed by (senderId, batchId, signedTx),
 *     not batchId alone: the API allocates batchId as Date.now() & 0x7fffffff,
 *     so two batches created in the same millisecond share it. The API stores
 *     one sender and the batch sig on every row of a batch.
 *   - rows without a batchId: one ActionData signature each, a group of 1
 * Groups come out in the order of their first row, and rows keep their
 * queue order inside a group.
 */
export function groupERC1271Rows<T extends { senderId: number; batchId?: number | null; signedTx?: string | null }>(
  rows: readonly T[]
): T[][] {
  const groups: T[][] = []
  const byBatch = new Map<string, T[]>()
  for (const row of rows) {
    if (row.batchId == null) {
      groups.push([row])
      continue
    }
    const key = `${row.senderId}:${row.batchId}:${row.signedTx ?? ''}`
    let group = byBatch.get(key)
    if (!group) {
      group = []
      byBatch.set(key, group)
      groups.push(group)
    }
    group.push(row)
  }
  return groups
}

function hexByteLength(hex: string): number {
  return hex.startsWith('0x') ? (hex.length - 2) / 2 : hex.length / 2
}

/**
 * Estimated calldata bytes for one ERC-1271 group submitted on its own:
 * base ABI overhead, the packed fields of every action, and the group's
 * signature blob once (rows of a batch all store the same blob).
 */
export function estimateERC1271GroupBytes(
  group: ReadonlyArray<{ signedTx?: string | null; payload: any }>
): number {
  let size = 500 // base ABI encode overhead
  for (const entry of group) {
    const data = entry.payload?.data
    const textHex = typeof data?.text === 'string' ? data.text : ''
    const recipientsLen = Array.isArray(data?.recipients) ? data.recipients.length * 4 : 0
    const amountsLen = Array.isArray(data?.amounts) ? data.amounts.length * 8 : 0
    size += 25 + hexByteLength(textHex) + recipientsLen + amountsLen
  }
  if (group.length > 0) size += hexByteLength(group[0].signedTx ?? '')
  return size
}
