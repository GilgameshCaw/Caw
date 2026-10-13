import { prisma as _prismaDefault } from '../../prismaClient'

// The DM consent baseline asks "does followerId follow followingId?" in
// three places that have to agree: first-contact routing (Requests vs
// Main) in DmService.getOrCreateConversation and dm-relay.ts, and the
// cold/warm send bucket in dmRateLimit.ts.
//
// A confirmed (SUCCESS) follow counts. So does a PENDING one, so a user
// who follows and then messages straight away lands in Main without
// waiting for the batch. A FAILED one doesn't: txQueueFailure.ts leaves
// the row behind as action=FOLLOW, status=FAILED (the UI reads it to
// revert the button), and nothing removes it later, so matching on
// action alone would count a follow that never happened, permanently.
//
// The privacy gate (dm.ts, dm-relay.ts) is stricter and stays
// SUCCESS-only; this is only the softer baseline.
export const DM_BASELINE_FOLLOW_STATUSES = ['SUCCESS', 'PENDING'] as const

// Test seam: swap the Prisma client. null restores the shared one.
let _prismaOverride: typeof _prismaDefault | null = null
export function _setPrismaForTest(p: typeof _prismaDefault | null): void {
  _prismaOverride = p
}

export async function findDmBaselineFollow(followerId: number, followingId: number): Promise<{ id: number } | null> {
  const db = _prismaOverride ?? _prismaDefault
  return db.follow.findFirst({
    where: {
      followerId,
      followingId,
      action: 'FOLLOW',
      status: { in: [...DM_BASELINE_FOLLOW_STATUSES] },
    },
    select: { id: true },
  })
}
