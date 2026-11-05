# Archive source-chain binding — existing PR #305

Baseline `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`. This is a concrete archive-integrity discrepancy with an existing proposed fix, distinct from the challenge-window availability assumption. No duplicate PR is needed.

## FACT — pinned source trace

- [CawChallengeRelay.relayNonExistence](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawChallengeRelay.sol#L146) reads the action count on its own chain and sends that chain's checkpoint height.
- [CawActionsArchive._lzReceive](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L480) does not use its `Origin` parameter when handing the payload to `_processChallenge`. Peer authentication is not submission-source-chain binding.
- [_processNonExistence](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L544) checks pending status and network ID, then slashes if the submission end exceeds the supplied source height. It does not establish that the supplied height describes the chain whose data the submission copied.
- [_executeSlash](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActionsArchive.sol#L601) clears the validator stake and invalidates pending submissions, with the reward credited through the pull-payment ledger. Claims are keyed by network ID and checkpoint, without a source-chain dimension on master.

## Consequence and prerequisites

If an archive has a peered relay for another chain where the same network ID has a lower or zero action count, a non-existence message from that relay can satisfy the master's slash condition even though the archived submission is honest for its actual source chain. This requires the relevant configured peer and pending submission; it is not an arbitrary untrusted caller bypassing LayerZero peer authentication. Mixing streams also means network ID alone is not sufficient provenance for checkpoint claims.

The [manifesto](https://github.com/cawdevelopment/manifesto/blob/main/README.md) requires trustless, permanent data storage and resistance to crippling the system. Slashing an honest archive participant using evidence from the wrong chain undermines archive integrity and availability; an ownership-renunciation claim does not address it. The [reproduced R2 text](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md) requires peer-reviewed release and developer independence. This is an implementation-correctness finding, not evidence of a retained developer key or intent. Text recovery does not establish R2 author identity.

## Existing fix and attributed evidence

[PR #305](https://github.com/GilgameshCaw/Caw/pull/305), head `a9db052504ee7de80e7f3292ac44e818b02df9a6`, state open, draft=false, adds source EIDs to submission identity and claim keys and checks incoming message origin for both challenge types. It does not add an administrator to choose canonical data. Its declared source identifies the stream; readers still need to choose the correct canonical stream rather than treating every declared stream as authoritative.

The author reports an actual-contract local regression where a non-existence message from a different peered L2 slashes on master and is rejected by the fix, plus source-chain fraud controls and separate-stream claim tests. The checked-in `solidity/test/archive-source-eid-test.js` and fixed archive source were fetched for review. **These test outcomes are attributed to the author, not independently rerun in this pass.** The report also documents full-suite failures, a skipped fork case, stale tests, transport/shim limitations and ABI/redeployment requirements. No deployed-chain exploit is alleged.

## Release gate and non-duplication

Use #305 for the implementation and reviewer discussion; do not create a second patch or a new administrator-based binding mechanism. Independently rerun its negative controls and verify both normal and non-existence challenge origin checks, stream separation, honest submissions, and validator/client ABI compatibility. A new archive deployment does not repair old immutable archives; operator migration and historical reader behavior need explicit evidence. The absence of an active non-existence monitor is a separate operating-coverage issue, not a defense against a permissionless incorrect slash path.

Status: pinned-source corroboration and existing external regression report; merge acceptance, independent local rerun and deployment verification are not claimed.
