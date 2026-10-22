# network-created event signature correction

baseline: `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

CawNetworkManager emits NetworkCreated with the full16-field CawNetwork tuple.
ChainSyncService's minimal event ABI included only14 fields, omitting
`tipTargetWei` and `tipCeilingWei`. tuple types participate in the event signature,
so the old filter selects a different topic and does not match the current
contract's NetworkCreated logs. it is not merely discarding two decoded fields.

the patch adds the missing fields in contract order. no contract, database schema,
fee policy or deployment behavior changes. the existing periodic full network
sync is a separate fallback; this finding does not establish total network
invisibility or permanent data loss.

four focused checks pass using Node24.20.0 and ethers6.16.0: topic agreement with
the source-declared struct, complete field decoding, a baseline mismatch control,
and the real ethers query-filter topic. the test derives field order from the
repository's CawNetwork struct and checks the event declaration. RPC/storage and
a live deployment were not exercised; full client typecheck was not run.

from solidity/ with ethers6.16.0 available:

```sh
node --max-old-space-size=256 --test test-deploy/network-created-abi.test.cjs
```

CAW_ETHERS_PACKAGE can point to an existing verified CommonJS/UMD installation.
the checked local run used the existing verified ethers UMD, not a fresh dependency
installation. no source-to-bytecode equivalence claim is implied by this ABI test.

this supports independently reconstructing network registrations from chain
history. it does not resolve the existing finite lookback, cursor scoping, reorgs
or swallowed database failures in other handlers. the new draft NetworkFinalized
event in #342 is a separate change; this correction is valid on current master.

## failed-write retry

the creation, fee and ceiling handlers previously logged database write failures
and returned normally. the poll could then advance its checkpoint past the
rejected event. these handlers now propagate write failures to the existing
range retry path. the existing P2025 missing-row/full-sync fallback remains
unchanged; this is not a complete missing-history fix.

with node 24 and ethers 6.16 installed, run from the repository root:

```sh
node --test solidity/test-deploy/network-created-abi.test.cjs solidity/test-deploy/network-event-retry.test.cjs
```

the ABI suite passes 4 checks; the retry suite passes 5. the latter executes the
actual extracted poll and handlers with real ethers event encoding/decoding,
but simulated RPC and database responses. creation, fee and ceiling failures
hold the range checkpoint; the next invocation replays successfully. a baseline
control removes exactly the three new throws and reproduces the skipped write.
partial database writes are not transactional; replay reapplies the range.

an additional local combined run with draft #342 at
`39435a853dd4673ac39ce5b34f97f7f0ef1e6299` passes 7 checks, including creation,
fee changes, finalization, failed refresh and retry. these include the same five
retry checks, not seven additional independent checks. to reproduce, assemble
the two sources with the helper and set CAW_REPLAY_SOURCE to its output:

```sh
python solidity/test-deploy/combine-network-replay.py path/to/342-index.ts client/src/services/ChainSyncService/index.ts combined-index.ts
CAW_REPLAY_SOURCE=./combined-index.ts node --test solidity/test-deploy/network-event-retry.test.cjs
```

the helper is test preparation only, not a proposed merge or release artifact.
no full service, live database/RPC, reorg recovery, historical backfill or client
typecheck is claimed. unknown fee types and missing decoded arguments retain
their existing behavior. #342 remains a separate draft policy decision.

## cursor-read integration with #290

five focused checks pass with #290's L1 cursor reader at
`a08f47b24fdfdc109f9cc5d27d88c6665b27a20f` substituted into this PR's actual
poll. the baseline reproduces a failed read bootstrapping beyond the saved
cursor. the combined reader throws before any log query or checkpoint write,
and retries from the saved cursor after recovery. a genuine absent row retains
the existing bootstrap behavior. checkpoint write failure also retains the old
cursor and retries the same empty range.

```sh
CAW_CURSOR_SOURCE=path/to/pr290-index.ts node --test solidity/test-deploy/network-cursor-retry.test.cjs
```

without CAW_CURSOR_SOURCE, the three standalone checks run and the two combined
checks are explicitly skipped. the test substitutes only the L1 reader; it does
not test #290's L2 reader or prove a conflict-free full merge. RPC and database
operations are simulated. the empty-range checkpoint check does not model
partial event writes or concurrent polling. the 50,000-block fresh-database
lookback remains unchanged and is not complete cold-start reconstruction.
