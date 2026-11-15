// Which transactions hold the actions a replication submission needs, read
// from the node's own index (RawEvent / Action) instead of from eth_getLogs.
//
// reconstructCheckpointData needs every ActionsProcessed transaction from the
// first action of the checkpoint range up to the newest one. Walking
// eth_getLogs back from the head costs one call per window of blocks, however
// few actions there are: on a quiet network the range start can be millions of
// blocks behind the head (32 actions took four days on Base Sepolia in
// November 2026, at 0.2 s per block), and that walk does not finish inside
// the loop's watchdog timeout. The indexer has already stored one RawEvent row
// per action with its block, transaction and emitting contract, so the same
// list of transactions is a few indexed queries away.
//
// The index is only used to find WHICH transactions to read. The action bytes
// still come from each transaction's calldata on the chain, and the caller
// still checks the rebuilt hash chain against networkHashAtCheckpoint on the
// chain before anything is submitted. A missing, stale or wrong index can
// therefore only make that check fail (and the caller falls back to the
// eth_getLogs walk); it cannot change what is submitted.

export interface IndexedTx {
  transactionHash: string
  /** Emitting contract, lower-case (CawActions or its ERC-1271 sibling). */
  address: string
}

export interface ReplicationTxIndex {
  /** Every indexed transaction from the block of the range's first action on. */
  txs: IndexedTx[]
  /** Number of executed actions the index holds. The transactions in `txs`
   *  end at this position, so positions are counted back from it. */
  endCount: number
  /** Block the transactions start at. */
  fromBlock: number
}

/** The three reads the lookup needs; see prismaIndexReader for the real one. */
export interface IndexReader {
  /** Executed actions the index holds for this network. */
  countExecuted(): Promise<number>
  /** Block of the n-th newest executed action (1 = the newest), or null. */
  blockOfNthNewest(n: number): Promise<number | null>
  /** Distinct transactions with an indexed action at or after `block`. */
  txsFromBlock(block: number): Promise<IndexedTx[]>
}

/**
 * Returns the transactions to read for a checkpoint range that starts at
 * action position `rangeStartPos` (0-based) and needs `actionsNeeded` actions,
 * or null when the index does not hold the whole range.
 */
export async function txsFromIndex(
  reader: IndexReader,
  rangeStartPos: number,
  actionsNeeded: number,
): Promise<ReplicationTxIndex | null> {
  if (!Number.isInteger(rangeStartPos) || rangeStartPos < 0) return null
  if (!Number.isInteger(actionsNeeded) || actionsNeeded <= 0) return null
  const endCount = await reader.countExecuted()
  if (!Number.isInteger(endCount) || endCount < rangeStartPos + actionsNeeded) return null
  // Everything from the range's first action to the newest indexed one.
  const fromBlock = await reader.blockOfNthNewest(endCount - rangeStartPos)
  if (fromBlock === null || !Number.isFinite(fromBlock)) return null
  const seen = new Set<string>()
  const txs: IndexedTx[] = []
  for (const tx of await reader.txsFromBlock(fromBlock)) {
    if (!tx.transactionHash || seen.has(tx.transactionHash)) continue
    seen.add(tx.transactionHash)
    txs.push({ transactionHash: tx.transactionHash, address: String(tx.address).toLowerCase() })
  }
  if (txs.length === 0) return null
  return { txs, endCount, fromBlock }
}

/** The part of a Prisma client the reader uses. */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>
}

/**
 * Reads the index through Prisma. `contracts` are the addresses whose
 * ActionsProcessed events count (CawActions and, if deployed, its ERC-1271
 * sibling); rows left by an earlier deployment on the same chain are ignored.
 */
export function prismaIndexReader(
  db: RawQueryClient,
  chainId: number,
  networkId: number,
  contracts: string[],
): IndexReader {
  const addrs = contracts.filter(Boolean).map(a => a.toLowerCase())
  const scope =
    `r."chainId" = $1 AND r.data->>'networkId' = $2 AND lower(r."contractAddress") = ANY($3::text[])`
  const args = [chainId, String(networkId), addrs]
  return {
    async countExecuted() {
      const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "Action" a JOIN "RawEvent" r ON r.id = a."rawEventId" WHERE ${scope}`,
        ...args,
      )
      return Number(rows[0]?.n ?? 0)
    },
    async blockOfNthNewest(n: number) {
      if (!Number.isInteger(n) || n < 1) return null
      const rows = await db.$queryRawUnsafe<Array<{ b: string }>>(
        `SELECT r."blockNumber"::text AS b FROM "Action" a JOIN "RawEvent" r ON r.id = a."rawEventId" ` +
        `WHERE ${scope} ORDER BY r."blockNumber" DESC, r."logIndex" DESC OFFSET $4 LIMIT 1`,
        ...args, n - 1,
      )
      return rows.length ? Number(rows[0].b) : null
    },
    async txsFromBlock(block: number) {
      const rows = await db.$queryRawUnsafe<Array<{ h: string; a: string }>>(
        `SELECT r."transactionHash" AS h, lower(r."contractAddress") AS a, min(r."blockNumber") AS b ` +
        `FROM "RawEvent" r WHERE ${scope} AND r."blockNumber" >= $4 ` +
        `GROUP BY 1, 2 ORDER BY 3, 1`,
        ...args, block,
      )
      return rows.map(r => ({ transactionHash: r.h, address: r.a }))
    },
  }
}
