# L2 event write retry - draft atomic candidate

baseline: `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

session creation, revocation and authentication handlers previously logged
primary database failures and returned, allowing the checkpoint to advance.
propagating these errors alone retained the checkpoint but exposed successful
earlier writes. replaying creation could then reset an intervening spending-cache
update. the earlier reproduction is preserved at
`1d1617b72f1eca62ec530e0a6739c6ed59c68012`.

the current candidate applies each fetched range and its checkpoint in one
Prisma transaction. handlers receive the transaction client, including their
nested database work. RPC log acquisition remains outside the transaction.
primary write failures propagate and roll back the range. no contract, signature
or economic policy changes. genuine new session creation still resets spending.

## focused reproduction

with node 24 and ethers 6.16 installed, run from the repository root:

```sh
node --test solidity/test-deploy/l2-event-retry.test.cjs
```

seven checks pass: both create/revoke orderings, creation/revocation/authentication
write failures, checkpoint write failure, and failed-range visibility. tests use
the actual extracted poll/handlers, real ethers ABI encoding/decoding, and a
simulated transactional database. accessing the global client during the modeled
transaction throws, checking that handler calls use the supplied client.

historical control: save ChainSyncService/index.ts from
`1d1617b72f1eca62ec530e0a6739c6ed59c68012`, then run:

```sh
CAW_L2_SOURCE=path/to/previous-index.ts node --test solidity/test-deploy/l2-event-retry.test.cjs
```

the control explicitly expects partially visible state in the older source;
its passing assertions describe a defect, not safety. this is seven checks in
two modes, not fourteen independent safety checks.

## draft gates

real PostgreSQL/Prisma rollback, concurrent spending updates, concurrent pollers,
and transaction timeout behavior still require validation. the transaction uses
Prisma defaults; dense ranges and nested queue work may exceed those limits.
this candidate does not prove acceptable sustained indexing throughput.

nested TxQueue/signature recovery catches retain their prior best-effort behavior.
missing session rows, fresh-node lookback, reorganizations, corrupted cursors and
complete cold-start recovery are not solved. #290 addresses failed cursor reads,
#345 the L1 event-write path, #182 frontend revocation confirmation, and #324
DataCleaner batch signer recovery. no full client typecheck or full-service run
is claimed. do not merge or deploy this draft until the database/concurrency
and liveness gates are satisfied.

reliable replay supports independent operators and the manifesto/R2 goal of
not depending on an indispensable developer. it is not proof of complete
protocol decentralization. no on-chain spending-limit bypass is demonstrated.
