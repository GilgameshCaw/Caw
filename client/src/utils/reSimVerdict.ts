// Simulation rejections that mean "try again later", not "this action is
// bad". Shared by the main simulation path (rows go back to pending) and
// recoverBatchFailure's re-simulation.
export function isTemporaryRejection(msg: string | undefined): boolean {
  const lowerMsg = msg?.toLowerCase() || ''
  return lowerMsg.includes('timeout') ||
         lowerMsg.includes('network') ||
         lowerMsg.includes('connection') ||
         lowerMsg.includes('rpc') ||
         lowerMsg.includes('will retry') ||
         lowerMsg.includes('too many requests') ||
         lowerMsg.includes('429') ||
         lowerMsg.includes('rate limit') ||
         lowerMsg.includes('missing response') ||
         // Auth state hasn't been relayed from L1 to L2 yet — the
         // user just submitted the authenticate tx and we're waiting
         // on LayerZero (typically 1-5 min). Same race the pre-sim
         // pendingDepositTxHash hold handles for deposits, but that
         // gate doesn't fire here because there's no tx hash on the
         // queued action. Retry on next poll until L2 catches up.
         lowerMsg.includes('not authenticated with this client') ||
         // Quick Sign session may not have landed on L2 yet — same
         // L1→L2 race as deposit/auth. The pre-sim hold for
         // pendingQuickSignTxHash handles the common case; this is
         // a fallback for actions whose row didn't carry the hash
         // (e.g. submitted shortly after, or after we cleared it on
         // a transient watcher gap). Retry on next poll.
         lowerMsg.includes('session expired or not found')
}

// Verdict for one entry of recoverBatchFailure's re-simulation, after a
// batch tx reverted.
//
// Only a rejection that is the action's own fault fails the entry:
//   - "Cawonce already used": the action may have landed (in another tx of
//     ours, or via a peer). Back to pending: the next poll either finds the
//     Action row before simulating (validated_by_peer) or gets the same
//     rejection from the simulation, which resolveCawonceUsed settles
//     without sending a tx.
//   - a temporary rejection (RPC timeout, network, rate limit, …): back to
//     pending, as on the main simulation path.
// No rejection: back to pending, it gets a fresh batch next poll.
export type ReSimVerdict = { pending: true } | { succeeded: false; reason: string }

export function reSimVerdict(rejection: string | undefined): ReSimVerdict {
  if (!rejection) return { pending: true }
  if (rejection.includes('Cawonce already used')) return { pending: true }
  if (isTemporaryRejection(rejection)) return { pending: true }
  return { succeeded: false, reason: rejection }
}
