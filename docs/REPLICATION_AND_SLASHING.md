# Replication and Slashing

Operator-facing guide to the optimistic replication system: how validators
stake to participate, how the fraud-proof pipeline works, what happens on a
slash, and how to safely run the end-to-end fraud test in development.

For the contract-level architecture see `solidity/contracts/CawActionsArchive.sol`
and `solidity/contracts/CawChallengeRelay.sol`. This doc focuses on what an
operator needs to know.

---

## Trust model in one paragraph

A validator stakes ETH on the archive chain (currently Arbitrum Sepolia) and
gets to submit checkpoint roots cheaply — no LayerZero fee per batch. If they
ever submit something fraudulent, ANY honest observer can challenge them: the
challenge reads the canonical hash from the source chain (Base Sepolia)
through `CawChallengeRelay`, sends it to the archive over LayerZero, and the
archive slashes the validator's entire stake to whoever submitted the
resolving transaction. The system tolerates any number of dishonest
validators as long as at least one honest observer monitors during the 2-day
challenge window.

---

## First-time setup: depositing stake

The validator no longer auto-deposits stake on startup (see [AUTO_RESTAKE](#auto_restake)
below). Before your validator can submit anything to the archive, it needs
at least `MIN_STAKE` (currently `0.01 ETH`) deposited on the archive
contract.

Use the bundled helper:

```bash
cd client
npx tsx scripts/archive-deposit.ts VALIDATOR 0.02
```

Args: `<role> <amountEth>`. Role is `VALIDATOR` (uses `VALIDATOR_PRIVATE_KEY`)
or `REPLICATOR` (uses `REPLICATOR_PRIVATE_KEY` — only relevant for fraud
testing, see below). Amount is in ETH.

After the deposit lands the validator picks it up on its next replication
cycle (~30s) and starts submitting.

If you start the validator without stake, you'll see this message **once** at
the first replication cycle that has work to do, then it goes quiet:

```
┌─ Replication paused: under-staked ─────────────────────┐
│ Your VALIDATOR wallet (0xF71338f3…) has 0 ETH
│ staked on archive 0x78569305…, but the
│ minimum is 0.01 ETH.
│
│ To replicate, deposit stake first:
│   cd client
│   npx tsx scripts/archive-deposit.ts VALIDATOR 0.02
│
│ (or set AUTO_RESTAKE=true to auto-top-up every cycle)
└────────────────────────────────────────────────────────┘
```

---

## The pipeline

```
       [L2 Base Sepolia]                        [L2b Arbitrum Sepolia]
       ─────────────────                        ──────────────────────
   ┌─ CawActions ──────┐                        ┌─ CawActionsArchive ─┐
   │  honest checkpoint│                        │  submissions[]       │
   │  hashes           │                        │  stakes[]            │
   └─────────────△─────┘                        │  challengeHash[][]   │
                 │ read                          │  dataCommitment      │
   ┌─ CawChallengeRelay┐                        └────────△─────△──────┘
   │  relayChallenge   │   LZ message            challenge│     │ submit
   │  relayChallengeBatch───────────────────────▶ delivery│     │ (stake-gated)
   └────────△──────────┘                                  │     │
            │                                          ┌──┴─────┴───┐
            │ (anyone)                                 │  Validator  │
   ┌────────┴──────┐                                   │  service    │
   │  Monitor      │ ── Mode A → slashIncoherentRoot   │             │
   │  service      │ ── Mode B → relayChallenge +      │             │
   │               │              resolveChallenge     └─────────────┘
   └───────────────┘
```

### Submission

`optimisticReplicationLoop()` in `ValidatorService` looks for unclaimed
checkpoint ranges on the archive and calls
`submitReplication(clientId, startCp, endCp, packedActions, r[], merkleRoot, entryHash)`.
The contract:

- Requires `stakes[msg.sender] >= MIN_STAKE`
- Requires the range is unclaimed
- Stores a `dataCommitment = keccak256(keccak(packed), keccak(r), entryHash)`
- Sets `finalizedAt = block.timestamp + 2 days`
- Emits `SubmissionCreated` and `ActionsArchived`

After 2 days anyone can call `finalizeSubmission(submissionId)` and the
data is permanently archived.

### Backpressure

`MAX_PENDING_SUBMISSIONS` (default `1`) caps how many unfinalized submissions
a single validator can have outstanding. Without it, a fraudster can pile up
many fraudulent batches before the first slash lands. With it, one bad
submission = one slash, then the loop pauses until the next submission
finalizes (or all pending get bulk-invalidated by a slash).

### Detection: two fraud modes

The monitor reads the archive's `ActionsArchived(submissionId)` event to
get the submitter's own `packedActions + r[]`, rebuilds their hash chain
locally (`foldCheckpointHashes` util) and their merkle tree, then:

| Comparison | Verdict | Slash path |
|---|---|---|
| `submitterRoot != sub.merkleRoot` | **Mode A — incoherent root**. Submitter's data doesn't even hash to the root they committed. No valid merkle proof exists. | `slashIncoherentRoot(submissionId, packed, r, entryHash)`. Contract re-folds on-chain, verifies dataCommitment, slashes if rebuilt root differs. **Single tx, no LZ needed.** |
| `submitterRoot == sub.merkleRoot` AND any `submitterHashes[i] != L2.clientHashAtCheckpoint(clientId, startCp+i)` | **Mode B — fake actions**. Submitter committed consistent fake data. Each fraudulent leaf is provable in the submitter's tree. | `relayChallengeBatch(destEid, sid, cid, cps[])` from L2 → LZ delivers correctHashes to archive → `resolveChallenge(sid, cp, claimedHash, proof)` slashes. **Two-round, ~2-5 min via LZ.** |
| otherwise | Honest. | `[Monitor] Submission N verified OK` |

### Slash effects

A successful slash:

- Submitter's `stakes[validator] = 0` (entire stake taken)
- ALL their pending submissions are flipped to `SLASHED`
- Their checkpoint claims are released (so honest validators can re-submit
  the same range)
- The reward (= the slashed stake) is sent to `msg.sender` of the
  resolving tx, not the LZ relayer
- `validatorSubmissions[validator]` is `delete`d so a re-staked validator
  starts fresh

### Dedup

Two layers prevent the monitor from re-firing forever:

1. **On-chain**: before relaying, check `archive.challengeDelivered(sid, cp)` —
   if true, skip. LZ-delivered hashes are write-once-effective so a re-relay
   is wasted fee.
2. **Cross-node**: a Postgres `ChallengeLock` row is claimed via INSERT-on-
   conflict-do-nothing before either relay or resolve. Multiple validator
   instances sharing a database can't race. Stale locks (crashed node)
   become reclaimable after 10 minutes.

### LZ channel safety

`_lzReceive` is wrapped in a try/catch with a self-call. If anything inside
the body reverts (malformed payload, unforeseen check, future code change),
the contract emits `ChallengeDeliveryFailed(payload, reason)` and the LZ
nonce advances normally. Without this, a single bad payload would stall
the channel forever, blocking all subsequent challenges from L2.

---

## Environment variables

### `AUTO_RESTAKE`

Default: `false` (any value other than literal `"true"`).

When `false`, a validator that drops below `MIN_STAKE` does NOT
automatically deposit more. Instead it logs the boxed CLI prompt above
once and pauses replication.

Why off by default: a stake drop during live operation almost always means
a slash, which means the validator just produced fraudulent data. Silently
topping up keeps bleeding funds while the underlying bug or compromised
key stays hidden. Manual deposit forces an operator to consciously
acknowledge the situation.

Set `AUTO_RESTAKE=true` for local dev or known-honest test loops where
you want the validator to keep going regardless.

### `MAX_PENDING_SUBMISSIONS`

Default: `1`. Pause new submissions when this many are already pending on
the archive. Prevents pre-slash spam during fraud and bounds exposure
during normal LZ/monitor latency windows.

### `REPLICATOR_PRIVATE_KEY`

Optional. If set, the validator submits from this wallet instead of
`VALIDATOR_PRIVATE_KEY`. The monitor still uses the main key. This is
intended for fraud testing — you can watch slashed ETH visibly transfer
from REPLICATOR to VALIDATOR. Don't set this in production.

### `CORRUPT_REPLICATION` and `CORRUPT_MODE`

**Twin-key gate.** Both must be set explicitly to enable fraud injection.
A single-key configuration is rejected at startup with a clear refusal
log — this is intentional defense against accidental activation in
production.

- `CORRUPT_REPLICATION=true` alone → does nothing, logs a refusal.
- `CORRUPT_REPLICATION=true CORRUPT_MODE=A` → submitter commits a garbage
  merkle root over honest packedActions. Triggers Mode A slash via
  `slashIncoherentRoot`.
- `CORRUPT_REPLICATION=true CORRUPT_MODE=B` → submitter flips one byte of
  packedActions and rebuilds a consistent root over the corrupted data.
  Triggers Mode B slash via `relayChallengeBatch` + `resolveChallenge`.

When active, the validator emits a loud `⚠️ CORRUPT_REPLICATION=true
CORRUPT_MODE=X` warning **every replication cycle** (~30s), so it's
impossible to leave on accidentally without noticing.

---

## Running the end-to-end fraud test

Prerequisites: validator running on testnet with `REPLICATOR_PRIVATE_KEY`
set and the REPLICATOR wallet funded with ~0.05 ETH on Arbitrum Sepolia.

### Mode A (incoherent root, on-chain only)

```bash
# .env
CORRUPT_REPLICATION=true
CORRUPT_MODE=A
AUTO_RESTAKE=false

cd client
npx tsx scripts/archive-deposit.ts REPLICATOR 0.02
# restart validator
```

Post enough caws to roll a checkpoint (32 actions). You should see:

```
[OptimisticReplication] ⚠️ CORRUPT_REPLICATION=true CORRUPT_MODE=A — every submission this cycle will be FRAUDULENT
[OptimisticReplication] ⚠️ MODE A CORRUPTION: cp N hash 0x... → 0x...
[OptimisticReplication] Submitted! tx: 0x...
[OptimisticReplication] pendingCount=1 >= MAX_PENDING_SUBMISSIONS=1 — waiting...
[Monitor] MODE A FRAUD (incoherent root) in submission 1: ...
[Monitor] Calling slashIncoherentRoot(1)...
[Monitor] Mode A SLASHED submission 1! tx: 0x...
┌─ Replication paused: under-staked ─...
```

Total time: ~1 minute. No LZ involved.

### Mode B (fake actions, full LZ round-trip)

Same setup but `CORRUPT_MODE=B`. You'll see:

```
[OptimisticReplication] ⚠️ MODE B CORRUPTION: flipped packedBytes[3]
[OptimisticReplication] Submitted! tx: 0x...
[Monitor] MODE B FRAUD in submission 1 cp 1: submitterClaimed=0x... L2=0x...
[Monitor] MODE B FRAUD in submission 1 cp 2: ...   (3 more)
[Monitor] Challenge batch relayed (mode B) for submission 1 cps=[1,2,3,4]. tx: 0x...
# wait 2-5 min for LZ delivery
[Monitor] Resolving challenge for submission 1 checkpoint 1...
[Monitor] SLASHED submission 1! tx: 0x...
```

Total time: ~5 min. One LZ tx total, regardless of cp count (batched).

### After the test

Both modes leave the REPLICATOR with `0 ETH` staked. Set
`CORRUPT_REPLICATION=` (unset) and restart, optionally re-deposit
REPLICATOR's stake if you want it to keep submitting honestly.

### Manual slash (debugging)

If the monitor is offline or you want to slash a specific submission by
hand, there's a CLI for the Mode A path:

```bash
cd client
npx tsx scripts/slash-incoherent.ts <submissionId>
```

It reads the submission from the archive, fetches the submitter's
packedActions from `ActionsArchived`, verifies the dataCommitment,
runs a staticCall to confirm the root really is incoherent, then sends
the real `slashIncoherentRoot` tx. Mode B has no equivalent CLI — the
two-round flow (relay challenge → wait for LZ → resolve) is more easily
done by just letting the monitor run.

---

## Operational invariants

These are properties the system maintains; if any of them break, something
is wrong.

1. **Anyone can challenge anyone.** No allowlist on `relayChallenge` or
   `resolveChallenge` or `slashIncoherentRoot`. The fraud reward goes to
   `msg.sender` of the resolving tx.
2. **Slashing is irreversible.** No admin can un-slash a submission or
   restore a slashed stake.
3. **Honest data wins.** A correctly-submitted submission cannot be
   slashed because:
   - Mode A: `slashIncoherentRoot` requires `computedRoot != sub.merkleRoot`
     and the dataCommitment check pins the submitter's exact bytes.
   - Mode B: `resolveChallenge` requires `correctHash != claimedHash`
     where correctHash comes from L2 and claimedHash is in the submitter's
     own tree.
4. **At least one honest monitor must observe within 2 days.** This is
   the optimistic-rollup liveness assumption. If nobody challenges,
   bad data finalizes.
5. **The archive contract has no owner functions** affecting funds. The
   only `onlyOwner` function is `setPeer` (LZ peer wiring at deploy
   time), which the deployer is expected to call once and then renounce.

---

## Known limitations

- **LZ delivery latency.** Mode B challenges depend on LayerZero
  delivering within the 2-day window. We've observed ~30s-5min in
  practice on testnet, but a stalled DVN/executor could in principle
  push past finality. Mode A slashes don't have this dependency
  (purely local to the archive chain).
- **Single canonical relay per source chain.** The archive's `peers`
  mapping is 1:1 (eid → relay address). Adding a new source chain
  requires the archive owner to call `setPeer` once. After that, anyone
  can use that relay; no per-Network config needed.
- **Submission size.** `relayChallengeBatch` payload caps out around
  ~30KB packedActions for the resolveChallenge / slashIncoherentRoot
  path to stay within RPC providers' tx-size limits. The submitter's
  loop already trims to `L2B_CALLDATA_LIMIT = 30_000` for this reason.
