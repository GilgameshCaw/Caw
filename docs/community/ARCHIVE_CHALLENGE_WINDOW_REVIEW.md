# Archive challenge deadline and operator disappearance

Baseline: `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`. This expands DEP-01 / HIST-01 review evidence. It identifies an explicit availability assumption and an unproven recovery boundary, not a new demonstrated exploit or a finding that every optimistic protocol violates the manifesto.

## FACT — pinned contract paths

1. [The archive trust model and deadline](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L20) require an honest monitor during a two-day challenge period (`CHALLENGE_PERIOD`, line62).
2. [`_processChallenge`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L502) records canonical hashes and `challengeDelivered`, but does not decide whether a committed leaf differs. That requires the separate proof supplied to `resolveChallenge`.
3. [`finalizeSubmission`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L379) checks pending status and the elapsed deadline, then finalizes. It does not inspect `challengeDelivered`. Therefore delivery alone is not a finalization hold or completed fraud resolution.
4. [`resolveChallenge`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L565) requires pending status. Once finalized, it cannot resolve a mismatch. The incoming challenge/nonexistence handlers also drop non-pending submissions. `slashIncoherentRoot` likewise requires pending status.
5. Finalization reduces `pendingCount`; [`withdraw`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L254) allows stake withdrawal when that count is zero. Finalization does not clear `checkpointClaimed`; [`isRangeAvailable`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L800) treats a nonzero claim as unavailable for a replacement submission in this contract.

## INFERENCE — what independence must demonstrate

The required job is not merely detecting suspicious data or sending a challenge. At least one independent party must obtain the data and proof, get the canonical hash delivered through transport, and resolve a valid mismatch before finalization wins. If all available monitors disappear, cannot obtain transaction data, lose RPC access, or cannot complete the transport/resolution path in time, a fraudulent submission could pass this contract's time-based finalization gate. A returning operator cannot undo that finalization using the listed challenge functions.

This is conditional source analysis, not evidence that a fraudulent submission has finalized. It does not show that independent readers must trust it: readers might reject it using retained canonical history. That separate validation/recovery path must be demonstrated. The contract itself discloses the honest-monitor assumption; it is not a hidden developer backdoor.

## Manifesto / R2 boundary

The [manifesto](https://github.com/cawdevelopment/manifesto/blob/main/README.md) requires permanent, trustless data storage and a system no single person can cripple. The [reproduced R2 text](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md) requires developer independence and a peer-reviewed, agreed release. This makes independent monitoring, acquisition and recovery a release-evidence requirement. It does not establish that every temporary outage violates the manifesto or that a particular two-day interval is forbidden. Any departure from the promised storage guarantee needs explicit scope and agreement. Recovered R2 bytes do not authenticate their author.

## Required bounded experiment

Use actual contracts in an isolated deployment with synthetic data. Compare timely resolution with (a) hash delivered before the deadline but resolution after finalization, (b) delayed transport, (c) monitor stopped throughout the window, and (d) independent monitor continuing while the original operator is stopped. Check status, stake, claim replacement and reader acceptance separately. Test an honest submission too: simply blocking finalization whenever someone requests a canonical hash can create a denial of service, because a delivered hash is not itself proof of fraud.

Then demonstrate a fresh reader rejecting an invalid finalized archive record and reconstructing canonical history without the original operator's database, credentials or hosted service. Do not add an administrator override as a recovery shortcut. Do not assume extending the timer proves permanence.

## Existing work and evidence limits

- [#57](https://github.com/GilgameshCaw/Caw/pull/57), `ceff433303ccef0b09164f0b4737bdb3835515eb` (closed): fix(validator): retry stranded finalize failures instead of losing them past the checkpoint.
- [#168](https://github.com/GilgameshCaw/Caw/pull/168), `668cceb10de926f08a9916ca7035dc98c5ff071e` (open): fix(validator): scanArchiveEvents ignored its event filter under ethers v6.
- [#169](https://github.com/GilgameshCaw/Caw/pull/169), `aa0f8752727af7d032ba9a643009d9c3f22f0216` (open): fix(validator): auto-finalize never finalized a submission.
- [#210](https://github.com/GilgameshCaw/Caw/pull/210), `1c00e72a0dc6ddf348a0551c15aa6c3a5661110d` (open): fix(validator): derive optimistic-replication lookback ranges from measured block time.

These PRs address scanning, finalization or lookback behavior. Their heads and descriptions were refreshed; their tests were not rerun in this review. They must not be duplicated or mistaken for proof of the entire disappearance/recovery scenario. The current title/body census is only a bounded duplicate check, not review of every historical diff and comment.

Evidence here: exact source inspection and recorded API metadata. No EVM, live-chain, fraud transaction or operator-outage experiment was performed. Status: architecture/release-proof gap within existing DEP-01/HIST-01; no new behavioral PR justified yet.
