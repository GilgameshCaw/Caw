import { prisma } from '../prismaClient'

/**
 * Cross-node dedup for the fraud-challenge pipeline.
 *
 * Multiple validator instances sharing a database can race to send the same
 * LZ challenge or call resolveChallenge, burning fees for no benefit. These
 * helpers use an INSERT...ON CONFLICT DO NOTHING semantic (via Prisma's
 * unique-key handling) to guarantee only one node acts per (kind, submission,
 * checkpoint) tuple.
 *
 * Stale locks (a node crashed before release) are reclaimable after
 * `expiresAt`. Default TTL is 5 minutes — long enough for a tx to land on L2
 * and receipt to be parsed, short enough that a dead node doesn't block real
 * work for long.
 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

function lockKey(kind: string, submissionId: bigint | number, checkpointId: bigint | number = 0) {
  return `${kind}:${submissionId}:${checkpointId}`
}

/**
 * Try to claim a lock. Returns true if this caller now holds it, false if
 * another caller already holds a non-expired lock.
 *
 * The expired-lock takeover path uses `updateMany` with a `where` that
 * includes the old expiry — this makes the takeover atomic (two nodes
 * racing each other will collide on the key, and the second writer's
 * `where` will fail once the first has bumped `claimedAt`).
 */
export async function tryClaimChallengeLock(
  kind: string,
  submissionId: bigint | number,
  checkpointId: bigint | number,
  holder: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<boolean> {
  const key = lockKey(kind, submissionId, checkpointId)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs)

  try {
    await prisma.challengeLock.create({
      data: {
        key, kind,
        submissionId: BigInt(submissionId),
        checkpointId: BigInt(checkpointId),
        holder,
        claimedAt: now,
        expiresAt,
      },
    })
    return true
  } catch (err: any) {
    // P2002 = Unique constraint violation — someone else has the key.
    // Check whether it's stale; if so, try to take it over.
    if (err?.code !== 'P2002') throw err
  }

  // Expired takeover: only succeeds if the current holder's expiresAt is in
  // the past. The `where` condition ensures this is atomic vs another node
  // taking it at the same time.
  const taken = await prisma.challengeLock.updateMany({
    where: { key, expiresAt: { lt: now } },
    data: { holder, claimedAt: now, expiresAt, outcome: null, txHash: null },
  })
  return taken.count === 1
}

/** Release a lock by marking its outcome and letting it expire naturally. */
export async function releaseChallengeLock(
  kind: string,
  submissionId: bigint | number,
  checkpointId: bigint | number,
  outcome: 'success' | 'error',
  txHash?: string,
): Promise<void> {
  const key = lockKey(kind, submissionId, checkpointId)
  try {
    await prisma.challengeLock.update({
      where: { key },
      data: { outcome, txHash: txHash ?? null },
    })
  } catch { /* lock was cleaned up or never existed — ignore */ }
}

/** Look up whether a lock exists and is still valid. */
export async function getChallengeLock(
  kind: string,
  submissionId: bigint | number,
  checkpointId: bigint | number,
) {
  return prisma.challengeLock.findUnique({ where: { key: lockKey(kind, submissionId, checkpointId) } })
}
