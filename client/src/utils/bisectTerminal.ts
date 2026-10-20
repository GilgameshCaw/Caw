// Verdict for one row at the end of the validator's revert bisection
// (bisectAndSubmit's terminal case: the sub-batch can't be split further
// and its tx still reverted).
//
// The revert is either a real reverter or a cawonce race lost to a peer
// mirror. The two are told apart on chain: CawActions.isCawonceUsed is
// false when the action never landed. Only a used cawonce goes on to the
// Action-table check (resolveCawonceUsed), which can wait for the indexer.
//
// Without the on-chain check, a real reverter went to resolveCawonceUsed
// too, found no Action row, and was put back to pending to wait. Each poll
// then re-sent it and reset its updatedAt (the wait's start), so the wait
// never ran out: the row stayed pending and every poll sent a reverting tx.

export type TerminalVerdict =
  | 'reverted'          // cawonce unused on chain: this action is the reverter
  | 'done'              // landed via a peer; the Action row matches
  | 'failed'            // a different action holds this cawonce
  | 'awaiting_indexer'  // cawonce used on chain, Action row not indexed yet

// Errors from isCawonceUsed propagate; the caller treats them as transient.
export async function resolveBisectTerminal(opts: {
  isCawonceUsed: () => Promise<boolean>
  resolveCawonceUsed: () => Promise<'done' | 'failed' | 'awaiting_indexer'>
}): Promise<TerminalVerdict> {
  if (!(await opts.isCawonceUsed())) return 'reverted'
  return opts.resolveCawonceUsed()
}
