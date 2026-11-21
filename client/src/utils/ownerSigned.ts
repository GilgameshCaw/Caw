import { prisma } from '../prismaClient'

/**
 * Has the wallet that holds a name signed anything with it? A name can be sent
 * to any wallet (mintFor, a transfer), so the address on its profile does not
 * show that the owner joined. An Action with senderId = tokenId was signed by
 * the owner or by a session key of theirs.
 *
 * Only actions since the current owner took the name count. "Since" is the L2
 * block of the ledger's OwnerSet event, so it does not depend on when this node
 * indexed the rows.
 */

/** Record an OwnerSet event. An older event (a replay) or the same owner again (a re-stamp) is ignored. */
export async function recordOwnerSet(tokenId: number, owner: string, blockNumber: number, logIndex: number): Promise<void> {
  const ownerLc = owner.toLowerCase()
  const block = BigInt(blockNumber)
  const row = await prisma.tokenOwnerSince.findUnique({ where: { tokenId } })
  if (row) {
    if (block < row.sinceBlock || (block === row.sinceBlock && logIndex <= row.sinceLogIndex)) return
    if (row.owner === ownerLc) return
  }
  await prisma.tokenOwnerSince.upsert({
    where: { tokenId },
    update: { owner: ownerLc, previousOwner: row?.owner ?? null, sinceBlock: block, sinceLogIndex: logIndex },
    create: { tokenId, owner: ownerLc, previousOwner: null, sinceBlock: block, sinceLogIndex: logIndex },
  })
}

/**
 * True if the owner has signed something with the name since they got it. With
 * no row every action counts. So does the first OwnerSet this node saw for a
 * name that already had actions (it may be a re-stamp, not a change of owner).
 * An action in the same L2 block as the OwnerSet does not count.
 */
export async function ownerHasSigned(tokenId: number): Promise<boolean> {
  const since = await prisma.tokenOwnerSince.findUnique({
    where: { tokenId },
    select: { sinceBlock: true, previousOwner: true },
  })
  let after: bigint | null = since ? since.sinceBlock : null
  if (since && since.previousOwner === null) {
    const earlier = await prisma.action.findFirst({
      where: { senderId: tokenId, rawEvent: { blockNumber: { lte: since.sinceBlock } } },
      select: { id: true },
    })
    if (earlier) after = null
  }
  const row = await prisma.action.findFirst({
    where: {
      senderId: tokenId,
      ...(after !== null ? { rawEvent: { blockNumber: { gt: after } } } : {}),
    },
    select: { id: true },
  })
  return row !== null
}
