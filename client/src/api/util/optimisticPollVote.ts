import type { PrismaClient } from '@prisma/client'

/**
 * The only part of the Prisma client the optimistic vote write needs. It works
 * with the global client and with a transaction client.
 */
export type VoteWriteClient = Pick<PrismaClient, 'vote'>

export interface OptimisticVoteParams {
  pollId: number
  voterId: number
  /** null = unvote */
  optionIndex: number | null
  multiSelect: boolean
  cawonce: number
}

/**
 * Optimistic (pre-confirmation) write for a poll vote. POST /api/actions calls
 * it so the UI can show the vote right after a refresh; the indexer
 * (handleVoteAction) confirms it when the action lands on chain.
 *
 * Rule: never delete or rewrite a CONFIRMED row here. handleVoteAction needs it
 * to be there, unchanged, to tell "change from X" from "fresh vote" and
 * "toggle OFF" from "toggle ON", and it does the delete and the totalVotes
 * decrement itself when the action confirms. Deleting a confirmed row early (or
 * flipping it back to pending) makes the indexer count the same vote twice on
 * the node that took the API request, while mirror nodes, which only run the
 * indexer, stay correct. A confirmed row's cawonce is also left alone: the
 * orphan-replay check treats a confirmed row's cawonce as proof that an action
 * has already been applied.
 *
 * Known window: an unvote and a multi-select toggle OFF write nothing here, so
 * until the on-chain action confirms, a server refetch (reload, navigation,
 * another device) still returns the confirmed vote and counts it. The
 * frontend's own optimistic state hides this within the session. Hiding it
 * everywhere would need a marker on the confirmed row (a new column).
 */
export async function writeOptimisticPollVote(client: VoteWriteClient, p: OptimisticVoteParams): Promise<void> {
  const { pollId, voterId, optionIndex, multiSelect, cawonce } = p

  // Unvote: nothing to write (see the known window above). handleVoteAction
  // deletes the confirmed row(s) and decrements totalVotes when it confirms.
  if (optionIndex === null) return

  const key = { pollId_voterId_optionIndex: { pollId, voterId, optionIndex } }

  if (multiSelect) {
    // Multi-select toggle for this specific (pollId, voterId, optionIndex).
    const existing = await client.vote.findUnique({ where: key })
    if (existing) {
      // Toggle OFF. Only an optimistic row (pending, never counted in
      // totalVotes) can go now. A confirmed row stays for the indexer to
      // delete and decrement; the pending condition also keeps this from
      // deleting a row the indexer confirmed since the read above.
      await client.vote.deleteMany({ where: { id: existing.id, pending: true } })
    } else {
      // Toggle ON: write a pending row; the indexer confirms and counts it.
      await client.vote.create({ data: { pollId, voterId, optionIndex, cawonce, pending: true } })
    }
    return
  }

  // Single-select vote or change-vote. Do not delete a prior row on another
  // option: handleVoteAction needs it to know this is a change and to
  // decrement the old option. Just write the new pick as pending.
  const existing = await client.vote.findUnique({ where: key })
  // Same option, already confirmed: leave it as it is. Flipping it back to
  // pending would make the indexer count it a second time on confirm.
  if (existing && !existing.pending) return
  await client.vote.upsert({
    where: key,
    update: { cawonce },
    create: { pollId, voterId, optionIndex, cawonce, pending: true },
  })
}
