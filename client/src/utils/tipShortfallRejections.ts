// Per-entry reasons for the validator's "tip is less than gas cost" branch.
//
// That branch used to fail every polled entry with the batch's shortfall
// reason: the rows already marked 'underpriced' were overwritten, and rows the
// simulation had rejected lost their own reason, so a "Cawonce already used"
// row never reached resolveCawonceUsed and was failed even when a peer had
// landed the same action. Only the entries that passed simulation are short
// on tip; the others keep their simulation rejection, the same as the branch
// where every entry is rejected (updateQueueStatuses with rejectionMessages).
//
// simRejections is index-aligned with the simulated entries ('' = passed).

export function tipShortfallRejections(
  simRejections: string[],
  count: number,
  shortfallReason: string,
): string[] {
  return Array.from({ length: count }, (_, i) => simRejections[i] || shortfallReason)
}
