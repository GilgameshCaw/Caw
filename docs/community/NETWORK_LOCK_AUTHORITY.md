# network locks are not authority removal

source baseline: `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`, `solidity/contracts/CawNetworkManager.sol`.

both locks can be set while the same owner retains these powers:

| operation | gate | effect after both locks |
|---|---|---|
| fee setters, fee recipient, fee ceilings, tip target/ceiling | onlyNetworkOwnerNotFeeLocked | blocked |
| changeOwner | onlyNetworkOwnerNotOwnershipLocked | blocked; zero-address transfer is also rejected |
| addAuthorizedSponsor / removeAuthorizedSponsor | onlyNetworkOwner | still callable; changes deposit-fee exemptions |
| CawProfile.withdrawFeesFor | ownerAddress check in CawProfile | still callable; owner chooses when to trigger the fee swap and minCawOut; output goes to feeAddress, not necessarily the owner |
| setGasOverride | onlyNetworkOwner | still callable; strictly increases the per-selector override up to MAX_GAS_OVERRIDE |

`onlyNetworkOwner` checks ownerAddress against msg.sender and does not check either lock. the lock functions set flags; neither clears ownerAddress. this is source evidence of retained per-network control, not a claim about any current deployment's state. On this baseline, PathwayExpander documents `renounceOwnership()` as ending its additions-only authority. The finalization changes proposed in PR #221 are separate; they are not part of this baseline or this PR.

## terminal-state decisions still needed

- existing sponsor exemptions cannot simply be frozen without considering compromised sponsor keys. decide whether a terminal state disables exemptions, permits their continuation, or uses a separately agreed mechanism. the nested mapping is not enumerable on-chain. its current entries can be reconstructed off-chain from complete, correctly ordered `AuthorizedSponsorSet` add/remove logs, subject to chain history availability and reorg handling; that does not make on-chain enumeration available.
- freezing gas overrides removes the current cross-chain recovery mechanism. making increases permissionless would let anyone raise costs to the cap. neither choice follows automatically from locking ownership.
- fee entitlement and swap-trigger authority are distinct. `CawProfile.withdrawFeesFor` checks only the network owner and forwards the owner-selected `minCawOut` to `_withdrawFees`, even after both locks. `_withdrawFees` consumes fees accrued by feeAddress and a matching amount up to the available protocol pool, then calls `swapAndSplit`. the feeAddress can independently use `withdrawFees`. removing owner authority must address the delegated trigger without erasing the recipient's existing claim or silently changing distribution policy.
- define the terminal-state event and readback, and require tests that every affected owner entry point rejects after finalization while permissionless operations and user exits still work.

this change corrects the renounce-equivalent description only. it does not add a terminal state, change runtime behavior, settle economics, or establish manifesto compliance. a behavioral patch needs explicit sponsor/gas policy and corresponding regression coverage.

## independent review record

[tentencaw reviewed head 213af9b6](https://github.com/GilgameshCaw/Caw/pull/334#issuecomment-6255525806) and reports seven passing authority tests on master and that head, plus comparisons of 277 compiled artifacts after masking Solidity metadata. these are reviewer-reported results, not independently rerun here. source inspection confirms the additional withdrawFeesFor path and the sponsor event writes. [the reviewer subsequently supplied the test source and exact commands](https://github.com/GilgameshCaw/Caw/pull/334#issuecomment-6264310519) and reports the same seven tests and 277-artifact comparison on `377fa67e`. the full forge build has not been rerun here. the supplied comparator is a report, not yet an automated acceptance gate: a local Linux check using two synthetic unequal bytecode artifacts printed `CODE DIFFERS` but returned exit 0. artifact-set differences also do not change its exit status by source inspection. [the requested correction](https://github.com/GilgameshCaw/Caw/pull/334#issuecomment-6266353273) is to fail on code differences or unequal artifact sets. this synthetic check does not challenge or independently reproduce the reported contract build.


## comparator follow-up

[the reviewer supplied a corrected comparator](https://github.com/GilgameshCaw/Caw/pull/334#issuecomment-6279728839). five synthetic Linux checks were rerun here: identical artifacts and metadata-only differences exit 0; runtime differences, unequal artifact sets and empty inputs exit 1. this closes the exit-status issue described above. the full forge build and seven authority tests remain reviewer-reported. the comparison masks a specific Solidity metadata encoding; these checks do not establish general semantic equivalence or protocol readiness.

## behavioral patch review gates

these are proposed acceptance checks, not an adopted policy or implemented terminal state. recording them does not authorize a deployment.

| decision | evidence required before accepting a behavioral patch |
|---|---|
| sponsor exemptions after finalization | state the chosen treatment of existing exemptions; test an existing sponsor, a revoked sponsor, an unlisted address, and a compromised former owner; prove no owner-controlled exemption path remains |
| cross-chain gas recovery | state whether overrides freeze or a separately agreed recovery mechanism remains; test each affected selector at its existing value and cap, and messages already in flight; permissionless increases to the cap must not be treated as an agreed substitute |
| delegated fee swaps | separate entitlement from trigger authority; show a former owner acting solely in that role cannot choose a swap's timing or minCawOut, while feeAddress retains its agreed claim and distribution is unchanged |
| finalization transition | specify the event, permanent readback and repeat-call behavior; test both lock orderings, partial locks and already-locked networks; prove no ownership transfer, upgrade or other owner route can reactivate powers |
| user continuity | exercise withdrawals, ordinary actions and instance registration/update under the agreed policy after finalization; include existing user balances and queued operations |
| reproducibility | pin source, toolchain and dependencies; run the full owner-entry-point regression set; make artifact comparisons fail on differences; publish independent results and unresolved limitations |

the next implementation review should link each selected policy to its tests. do not infer agreement from silence, a documentation merge, or the existing locks.
