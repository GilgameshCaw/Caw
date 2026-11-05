# Manifesto / recovered R2 release review

this is a consolidated, open review of known release gaps, not a certification or a demand to merge any particular patch. the purpose is to make the implementation, its remaining authority and its evidence inspectable before a claim of manifesto completion.

**Baseline:** `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`. GitHub refresh: 2026-11-05 UTC (November 4 US Eastern); 423 PRs, including 12 open Xubu PRs. PR heads below are snapshots, not accepted fixes. No new live-chain, full-build or database experiment was performed for this documentation review. Source excerpts were checked against the pinned Git blobs; earlier experiments and reviewer reports retain their original boundaries.

## Source requirements

- **M-A — authority:** [manifesto](https://github.com/cawdevelopment/manifesto/blob/37399aeb55974d4b09d404014865b5ef8918e9de/README.md): “After deployment, the deployer must renounce any keys they have to the contracts.” It also requires no single person/entity/group with ultimate control or benefit and no person able to cripple the system in a meaningful way. A per-network owner is an authority surface even if the contract does not inherit Ownable.
- **M-R — release:** the same source requires a “cawmmunity reviewed and accepted contract on a public github”. Test counts, deadlines and repository merge rights are not substitutes for that review.
- **M-I — identity:** numbered requirements ii–iv describe NFT ownership as account ownership, including balances/DMs, and holding the NFT as the deposit/withdrawal key. Interpret transfer timing, sponsorship exceptions and historical DM access explicitly.
- **M-D — availability:** requirements iii, vii and viii cover on-chain ownership/management, trustless secure peer-to-peer messaging, permanence and absence of protocol blocking. The frontend paragraph permits frontend moderation and image hosting; those are not automatically protocol defects.
- **M-E — economics/text:** the username/action schedules, requirement v and appendices need a reconciled interpretation; proposal a specifies a maximum message length. A proposed improvement does not silently amend the text.
- **R-A — post-deploy equality:** [reproduced R2](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md) says “no dev backdoors, no proxy, no multisigs” and that after deployment the developers “do not matter more than any individual community member”.
- **R-C — changes:** R2 says “according to the manifesto (or if clear changes were agreed)”. Record the exact deviation, scope, alternatives and agreement; do not infer agreement from silence.
- **R-R — release:** R2 calls for something “solid, peer reviewed, contributed to by many and it is agreed to be released”. Its [replay/inverse check](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/REPRODUCE.md) establishes recovered bytes, not author identity.

**Interpretation:** releasing with retained special developer authority would contradict M-A/R-A unless a clear change had been agreed and disclosed. It would retain the developer dependency those passages warn against. This is a claim about observable powers and requirements, not about anyone's intentions. A missing receipt, open PR or missed deadline alone does not prove a backdoor or malicious conduct.

## Proposed evidence gates before a completion claim

1. Pin the candidate and all chains/contracts; publish source-to-bytecode and complete authority/dependency maps, including per-network roles and external endpoints.
2. Resolve explicit specification conflicts with public alternatives, objections and agreement. Do not silently fix policy through code.
3. Exercise sealed operation, sponsor compromise, gas changes, recipient withdrawal and interrupted multi-chain deployment without privileged recovery.
4. Independently rebuild agreed protocol state from empty storage and public inputs; reproduce failure/retry/reorg cases with the real database and clients. A mock pass is not this result.
5. Reproduce prover/toolchain/ELF/vkey/deployed-verifier binding and account/signature/transfer safety for the actual candidate.
6. Run an operator-disappearance exercise with replacement RPC, transport/storage and frontend access; record what cannot be recovered.
7. Obtain independent review and explicit release agreement for that exact candidate. These are proposed acceptance gates, not an assertion that the community has adopted them.

## Known-gap register

FACT denotes the pinned source or named public record. Consequences and requirement mappings are INFERENCE. Acceptance gates are proposals; missing evidence and specification decisions remain UNRESOLVED. Historical test descriptions below are attributed records, not reruns in this review. This is coverage of the known review inventory, not proof that every possible defect has been found.


### authority

#### GOV-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/PathwayExpander.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/PathwayExpander.sol#L72) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Owner retains peer/configuration/KYC expansion powers on master.

**Open acceptance gate:** Sealed multi-chain operational exercise remains; no merged acceptance.

Existing work: [#221](https://github.com/GilgameshCaw/Caw/pull/221) `9bfe9ea1e94af4e7ac7cee3ba38908b1fcb3d7a2` (open)

#### LZ-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/scripts/lz-dvn-config.js`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/scripts/lz-dvn-config.js#L309) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Endpoint default libraries are a mutable external dependency; #276 pins selected libraries.

**Open acceptance gate:** Pinning does not eliminate DVN/endpoint or chain liveness dependency.

Existing work: [#276](https://github.com/GilgameshCaw/Caw/pull/276) `47dfc2cd18fa663c87d88cb8ea7afc85c44a41cf` (open), [#221](https://github.com/GilgameshCaw/Caw/pull/221) `9bfe9ea1e94af4e7ac7cee3ba38908b1fcb3d7a2` (open)

#### NET-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawNetworkManager.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawNetworkManager.sol#L683) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Fee/ownership locks do not remove all network-owner authority.

**Open acceptance gate:** Terminal policy and canonical deployment integration unresolved.

Existing work: [#334](https://github.com/GilgameshCaw/Caw/pull/334) `4206f96cb0c1d1d70617fba4eabeb5b852768ed6` (open), [#342](https://github.com/GilgameshCaw/Caw/pull/342) `39435a853dd4673ac39ce5b34f97f7f0ef1e6299` (open, draft)

#### NET-02 — DESIGN DECISION

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawNetworkManager.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawNetworkManager.sol#L204) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: On master, sponsor membership is owner-managed even after both locks. The #342 candidate would freeze existing membership when it clears the owner; that is a proposal, not deployed master behavior.

**Open acceptance gate:** Explicitly choose treatment of existing exemptions and compromised sponsors; reproduce that choice through finalization and withdrawal/action paths.

Existing work: [#342](https://github.com/GilgameshCaw/Caw/pull/342) `39435a853dd4673ac39ce5b34f97f7f0ef1e6299` (open, draft), [#334](https://github.com/GilgameshCaw/Caw/pull/334) `4206f96cb0c1d1d70617fba4eabeb5b852768ed6` (open)

#### NET-03 — DESIGN DECISION

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawNetworkManager.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawNetworkManager.sol#L698) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Master retains capped, owner-only gas increases after both network locks. Clearing the owner in #342 would remove that recovery mechanism.

**Open acceptance gate:** Demonstrate post-finalization message liveness under changed gas requirements without a replacement privileged key; agree any finite supported envelope.

Existing work: [#342](https://github.com/GilgameshCaw/Caw/pull/342) `39435a853dd4673ac39ce5b34f97f7f0ef1e6299` (open, draft), [#334](https://github.com/GilgameshCaw/Caw/pull/334) `4206f96cb0c1d1d70617fba4eabeb5b852768ed6` (open)

#### NET-04 — SOURCE FINDING / OPEN PROOF

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawProfile.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfile.sol#L504) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Network owner may trigger a swap paying feeAddress; recipient has direct withdrawal rights.

**Open acceptance gate:** Recipient economics, slippage and terminal authority need separate agreement.

Existing work: [#342](https://github.com/GilgameshCaw/Caw/pull/342) `39435a853dd4673ac39ce5b34f97f7f0ef1e6299` (open, draft), [#334](https://github.com/GilgameshCaw/Caw/pull/334) `4206f96cb0c1d1d70617fba4eabeb5b852768ed6` (open)

#### EXPAND-01 — DESIGN DECISION

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/PathwayExpander.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/PathwayExpander.sol#L55) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: The current expansion path is owner-only. Sealing it removes that path. Indefinite addition of future chains is not itself an explicit requirement in the quoted sources.

**Open acceptance gate:** Choose a sealed supported network set or specify and test permissionless deterministic expansion. Do not call a developer key necessary compliance.

Existing work: [#221](https://github.com/GilgameshCaw/Caw/pull/221) `9bfe9ea1e94af4e7ac7cee3ba38908b1fcb3d7a2` (open), [#276](https://github.com/GilgameshCaw/Caw/pull/276) `47dfc2cd18fa663c87d88cb8ea7afc85c44a41cf` (open)

#### BIND-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawProfileMinter.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileMinter.sol#L26) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Minter Profile binding is internal and has no public getter.

**Open acceptance gate:** Binding proof through constructor/deployment evidence or reviewed getter design.

Existing work: [#332](https://github.com/GilgameshCaw/Caw/pull/332) `4345d928f769cca0de8caf1d4337d91362bfb7fe` (open), [#221](https://github.com/GilgameshCaw/Caw/pull/221) `9bfe9ea1e94af4e7ac7cee3ba38908b1fcb3d7a2` (open)

#### DEPLOY-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/scripts/deploy.js`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/scripts/deploy.js#L49) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Source-level sealing improvements do not establish a complete sealed multichain interrupted-recovery run.

**Open acceptance gate:** No full independent multi-chain sealed/recovery exercise evidenced.

Existing work: [#221](https://github.com/GilgameshCaw/Caw/pull/221) `9bfe9ea1e94af4e7ac7cee3ba38908b1fcb3d7a2` (open), [#276](https://github.com/GilgameshCaw/Caw/pull/276) `47dfc2cd18fa663c87d88cb8ea7afc85c44a41cf` (open), [#332](https://github.com/GilgameshCaw/Caw/pull/332) `4345d928f769cca0de8caf1d4337d91362bfb7fe` (open)

#### MIGRATE-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawProfile.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfile.sol#L19) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Immutable old deployments cannot inherit fresh-generation finalization functions.

**Open acceptance gate:** Generation-specific migration, user balances and continued access not designed.

Existing work: [#221](https://github.com/GilgameshCaw/Caw/pull/221) `9bfe9ea1e94af4e7ac7cee3ba38908b1fcb3d7a2` (open), [#342](https://github.com/GilgameshCaw/Caw/pull/342) `39435a853dd4673ac39ce5b34f97f7f0ef1e6299` (open, draft)

#### DEPLOY-ID-01 — PORTABILITY EVIDENCE GAP

Requirement: **M-A / R-A**. Priority: MEDIUM (review prioritization, not exploit rating).

Source: [`solidity/scripts/deploy.js`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/scripts/deploy.js#L127) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: The canonical deployment script contains EXPECTED_DEPLOYER and a fixed-address check. This is script policy, not proof of an on-chain exclusive right to deploy.

**Open acceptance gate:** Reconcile deterministic addresses, constructor wiring, beneficiaries and interrupted recovery for an independent deployer; do not merely delete the check.

Existing work: [#221](https://github.com/GilgameshCaw/Caw/pull/221) `9bfe9ea1e94af4e7ac7cee3ba38908b1fcb3d7a2` (open)

#### PROXY-01 — DEPLOYMENT EVIDENCE GAP

Requirement: **M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/SmartEOA.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/SmartEOA.sol#L29) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: No production upgrade-proxy or multisig finding is established by this register. Absence of a pattern in selected source is not a deployed dependency audit.

**Open acceptance gate:** Enumerate actual deployed bytecode, endpoints, delegatecall targets and external authority before claiming the complete system has no such dependency.

Existing work: No bounded implementation fix established by this record.

### recovery

#### HIST-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-D / M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`client/src/services/RawEventsGatherer/index.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/services/RawEventsGatherer/index.ts#L17) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Fresh-node floors can be absent or drawn from the wrong chain domain.

**Open acceptance gate:** End-to-end empty-DB acquisition and reconstruction incomplete.

Existing work: [#328](https://github.com/GilgameshCaw/Caw/pull/328) `38fbdd6d45c8e0079c17b35460811863f48163cb` (open, draft), [#329](https://github.com/GilgameshCaw/Caw/pull/329) `b57ce8e470778ef2034558a5ea770abe79dd54ac` (open, draft), [#242](https://github.com/GilgameshCaw/Caw/pull/242) `c3362e02ba6b19a40c7c8aa898d8e6f786e57928` (open), [#277](https://github.com/GilgameshCaw/Caw/pull/277) `583ad3af7bef3fffe5864c25dc44e0c83693ccd0` (open)

#### HIST-02 — SOURCE FINDING / OPEN PROOF

Requirement: **M-D / M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/scripts/deploy.js`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/scripts/deploy.js#L2482) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Master samples a post-phase head rather than every relevant contract creation receipt.

**Open acceptance gate:** Receipt trust/source and all deployment generations still require validation.

Existing work: [#328](https://github.com/GilgameshCaw/Caw/pull/328) `38fbdd6d45c8e0079c17b35460811863f48163cb` (open, draft), [#329](https://github.com/GilgameshCaw/Caw/pull/329) `b57ce8e470778ef2034558a5ea770abe79dd54ac` (open, draft)

#### REPLAY-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-D / M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`client/src/services/ChainSyncService/index.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/services/ChainSyncService/index.ts#L827) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Primary writes may fail while checkpoint advances; simple retry exposes partial accounting state.

**Open acceptance gate:** PR #349 remains draft: preserved failed-write/session-reset interleaving overwrote an intervening update. Current atomic candidate has modeled checks only; real PostgreSQL/Prisma rollback, concurrency and timeout behavior remain unproved.

Existing work: [#349](https://github.com/GilgameshCaw/Caw/pull/349) `11610f6abb89d9f64ace4b753102f24696272582` (open, draft), [#345](https://github.com/GilgameshCaw/Caw/pull/345) `e2462760e661dc389643b94d89b92dd4c14dc5e8` (open), [#290](https://github.com/GilgameshCaw/Caw/pull/290) `a08f47b24fdfdc109f9cc5d27d88c6665b27a20f` (open), [#311](https://github.com/GilgameshCaw/Caw/pull/311) `76fabc02076b9d3e04471ce1dd0e857e7cca25aa` (open)

**#349 remains draft.** The failed-write / SessionCreated spent-reset interleaving can overwrite an intervening update. Preserve that failing reproduction. Modeled atomicity is not real Prisma/PostgreSQL concurrency, rollback or timeout proof.

#### REPLAY-02 — EVIDENCE GAP

Requirement: **M-D / M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`client/src/services/ChainSyncService/index.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/services/ChainSyncService/index.ts#L807) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: ChainSyncService includes bounded lookbacks and special missing-row handling. Complete reorg/backfill recovery is not established by those mechanisms.

**Open acceptance gate:** Inventory every cursor and derived table; test absent rows, crash/restart, overlap, duplicate delivery and rollback against real database transactions.

Existing work: [#290](https://github.com/GilgameshCaw/Caw/pull/290) `a08f47b24fdfdc109f9cc5d27d88c6665b27a20f` (open), [#311](https://github.com/GilgameshCaw/Caw/pull/311) `76fabc02076b9d3e04471ce1dd0e857e7cca25aa` (open), [#329](https://github.com/GilgameshCaw/Caw/pull/329) `b57ce8e470778ef2034558a5ea770abe79dd54ac` (open, draft), [#345](https://github.com/GilgameshCaw/Caw/pull/345) `e2462760e661dc389643b94d89b92dd4c14dc5e8` (open), [#349](https://github.com/GilgameshCaw/Caw/pull/349) `11610f6abb89d9f64ace4b753102f24696272582` (open, draft), [#346](https://github.com/GilgameshCaw/Caw/pull/346) `5b270d7c040cbc2baee5bdfa013878ac4ec18e12` (open)

#### ZK-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-D / M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/zk/sig-recovery/VKEY_REPRODUCIBILITY.md`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/zk/sig-recovery/VKEY_REPRODUCIBILITY.md#L1) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Committed vkey/current toolchain reproducibility discrepancy is publicly recorded.

**Open acceptance gate:** Reproduce source/toolchain/ELF/vkey/contract linkage.

Existing work: [#330](https://github.com/GilgameshCaw/Caw/pull/330) `f141ba65c3d84ae8a9ff777c9cb930eecaf04007` (open, draft)

The intentional #330 mismatch must not be made green by weakening the check. It does not itself establish that the verifier is exploitable.

#### DEP-01 — EVIDENCE GAP

Requirement: **M-D / M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`install.sh`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/install.sh#L17) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: A public 15-surface operator-disappearance map now exists. Mapping a dependency is not demonstrating its replacement.

**Open acceptance gate:** Run the mapped loss/replacement exercises without original operators, secrets or private state. Record surviving and unavailable functionality separately.

Existing work: [#221](https://github.com/GilgameshCaw/Caw/pull/221) `9bfe9ea1e94af4e7ac7cee3ba38908b1fcb3d7a2` (open), [#276](https://github.com/GilgameshCaw/Caw/pull/276) `47dfc2cd18fa663c87d88cb8ea7afc85c44a41cf` (open), [#274](https://github.com/GilgameshCaw/Caw/pull/274) `82428f5f2b7fad370069bc3680c3eaf94be16fbb` (open), [#328](https://github.com/GilgameshCaw/Caw/pull/328) `38fbdd6d45c8e0079c17b35460811863f48163cb` (open, draft), [#330](https://github.com/GilgameshCaw/Caw/pull/330) `f141ba65c3d84ae8a9ff777c9cb930eecaf04007` (open, draft), [#316](https://github.com/GilgameshCaw/Caw/pull/316) `cf765087a8b76b50b3cbd2f66b6d504515a82191` (open)

[15-surface replacement map](https://github.com/Xubu-Trad/CawUsernames/blob/295168daf06f92f2f9fd30c7fece23a82baeb9f8/docs/community/OPERATOR_DISAPPEARANCE_MAP.md): RPC/archive, LayerZero/DVNs, Civic/KYC, Postgres, Redis, indexers, credentials, DM/user keys, hosting/DNS/TLS, source/dependencies and prover/release inputs.

#### REGISTRY-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-D / M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`client/src/services/InstanceRegistryService/index.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/services/InstanceRegistryService/index.ts#L26) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: Registry depends on historical code search; pruned-state limitation is already disclosed by #316.

**Open acceptance gate:** Receipt-derived manager floor integration with ordering/completeness guarantees.

Existing work: [#314](https://github.com/GilgameshCaw/Caw/pull/314) `3ff8dfd245728e43b8b688ad19330a6efa5e86c6` (open), [#316](https://github.com/GilgameshCaw/Caw/pull/316) `cf765087a8b76b50b3cbd2f66b6d504515a82191` (open), [#328](https://github.com/GilgameshCaw/Caw/pull/328) `38fbdd6d45c8e0079c17b35460811863f48163cb` (open, draft)

#### FE-01 — UNCONFIRMED CONCERN

Requirement: **M-D / M-A / R-A**. Priority: MEDIUM (review prioritization, not exploit rating).

Source: [`client/src/services/FrontEnd/src/store/instanceStore.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/services/FrontEnd/src/store/instanceStore.ts#L29) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: The instance store has an active API host and node-discovery state. That alone does not prove an irreplaceable host or an exploitable authentication migration.

**Open acceptance gate:** Trace callers and reproduce authenticated failover before claiming a defect or opening a patch.

Existing work: No bounded implementation fix established by this record.

#### FE-02 — EVIDENCE GAP

Requirement: **M-D / M-A / R-A**. Priority: MEDIUM (review prioritization, not exploit rating).

Source: [`client/src/services/FrontEnd/src/store/instanceStore.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/services/FrontEnd/src/store/instanceStore.ts#L211) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: chunkedGetLogs uses bounded backward windows. A finite search is not proof that every historical instance can be discovered.

**Open acceptance gate:** Test sparse history, empty windows and alternate providers with known older registrations; reconcile #177/#347 before a new change.

Existing work: [#177](https://github.com/GilgameshCaw/Caw/pull/177) `61495f8065b80aa95e69251ded116d308d8e735e` (open), [#347](https://github.com/GilgameshCaw/Caw/pull/347) `d0b600a441e5f4a42147f811e215fea41e6dd206` (open)

#### RELEASE-01 — EVIDENCE GAP

Requirement: **M-D / M-A / R-A**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`install.sh`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/install.sh#L19) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: The installer defaults to mutable source and allows repository overrides. #421 now disables replacement-object lookup for pinned acquisition, verification and reset; the amendment has eleven local fixture scenarios and expected failing controls.

**Open acceptance gate:** Independently review the replacement amendment and integrate #237; verify installer/bootstrap trust, dependencies, filters/hooks/conversions and independent installation. #421 alone is not supply-chain closure.

Existing work: [#330](https://github.com/GilgameshCaw/Caw/pull/330) `f141ba65c3d84ae8a9ff777c9cb930eecaf04007` (open, draft), [#421](https://github.com/GilgameshCaw/Caw/pull/421) `b210d060e247684edaab2021c3d8653d0c885ee5` (open)

### account

#### WITHDRAW-01 — SPECIFICATION / AUTHORITY CONFLICT

Requirement: **M-I / M-D / R-C**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawProfileMinter.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileMinter.sol#L331) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: A profile with recorded gate state waits 180 days at level 1, or requires its configured verifier at level 2 and above with no time fallback. Profiles with mintedAt == 0 are unrestricted by this gate; other withdrawal checks still apply. unlockWithdraw requires the same time/verifier condition before clearing it.

**Open acceptance gate:** Record an agreed exception to NFT-holder withdrawal access or redesign sponsorship without silently changing its economics. Reproduce verifier disappearance, NFT transfer and later deposits. #274 repairs wiring, not this policy.

Existing work: [#274](https://github.com/GilgameshCaw/Caw/pull/274) `82428f5f2b7fad370069bc3680c3eaf94be16fbb` (open)

#### NFT-01 — EVIDENCE GAP

Requirement: **M-I / M-D / R-C**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawProfile.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfile.sol#L792) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: transferAndSync transfers the NFT on L1 and queues/flushes updates to other chains. Cross-chain ownership propagation is asynchronous.

**Open acceptance gate:** Reproduce old-owner, new-owner and session permissions during delayed, reordered and replayed transfer messages. No concrete exploit window is certified by source inspection alone.

Existing work: No bounded implementation fix established by this record.

#### DM-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-I / M-D / R-C**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`client/src/services/FrontEnd/src/services/DmCryptoService.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/services/FrontEnd/src/services/DmCryptoService.ts#L109) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: DM key derives from wallet signature; replacement owner does not automatically receive historical key.

**Open acceptance gate:** Transfer privacy/key continuity design; no central escrow assumption.

Existing work: [#218](https://github.com/GilgameshCaw/Caw/pull/218) `422153af1e63856c3cc76b8daa7cd641ab8c99ff` (open)

#### DM-02 — EVIDENCE GAP

Requirement: **M-I / M-D / R-C**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`client/src/api/dmSenderSig.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/api/dmSenderSig.ts#L80) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: verifyDmSenderSig exists. A blanket claim that this implementation has no sender-signature checks is unsupported.

**Open acceptance gate:** Trace identity registration, key binding, handshake and send/receive/sync enforcement across transfers and instances. Test rejected identities; do not equate one verifier function with end-to-end proof.

Existing work: [#185](https://github.com/GilgameshCaw/Caw/pull/185) `54b842b77ff7099f3dd143fb2322efa823a8f676` (open), [#218](https://github.com/GilgameshCaw/Caw/pull/218) `422153af1e63856c3cc76b8daa7cd641ab8c99ff` (open), [#348](https://github.com/GilgameshCaw/Caw/pull/348) `60295f42b216d274c6ca1b4da09d7281d12cbc62` (open), [#350](https://github.com/GilgameshCaw/Caw/pull/350) `bdcdcea1ed9d0abacaf7f962054ab5e5068f36e9` (open)

#### DM-03 — SPECIFICATION / EVIDENCE GAP

Requirement: **M-I / M-D / R-C**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`client/src/services/DmRelayService/index.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/services/DmRelayService/index.ts#L159) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: DM relay persistence and replication depend on instance storage; no complete independent DM-recovery result is established by this register.

**Open acceptance gate:** Resolve permanence versus privacy/deletion and transferred-NFT history access. Demonstrate the agreed encrypted-data recovery without central key escrow.

Existing work: [#218](https://github.com/GilgameshCaw/Caw/pull/218) `422153af1e63856c3cc76b8daa7cd641ab8c99ff` (open), [#350](https://github.com/GilgameshCaw/Caw/pull/350) `bdcdcea1ed9d0abacaf7f962054ab5e5068f36e9` (open)

#### META-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-I / M-D / R-C**. Priority: MEDIUM (review prioritization, not exploit rating).

Source: [`client/prisma/schema.prisma`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/prisma/schema.prisma#L28) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: User mixes on-chain identity with local profile metadata.

**Open acceptance gate:** Which text fields are protocol data rather than frontend conveniences?

Existing work: No bounded implementation fix established by this record.

### economics

#### ECON-01 — SPECIFICATION DECISION

Requirement: **M-E / R-C**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawActions.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActions.sol#L1267) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: CawActions contains dynamic action-cost cap logic. A lower price is still a change from a fixed literal schedule.

**Open acceptance gate:** Publish the exact one-action accounting and reconcile body/appendix conflicts. Record agreement on the dynamic rule rather than declaring it automatically compliant.

Existing work: [#193](https://github.com/GilgameshCaw/Caw/pull/193) `873f39193caa55bd857c09eae9ccf88258174ba0` (open), [#112](https://github.com/GilgameshCaw/Caw/pull/112) `c30771952390c38822adb3f340b867588fcd32e9` (closed)

#### ECON-02 — SPECIFICATION DECISION

Requirement: **M-E / R-C**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawProfile.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfile.sol#L434) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: CawProfile.payFee accrues the fee to feeAddress and the buy-and-burn address, returning twice the input fee. This is an intentional code path, not by itself evidence of theft.

**Open acceptance gate:** Pin each deployed network beneficiary and explain its purpose against the no-special-benefit and economic clauses. Agree deviations and reproduce total charges and payouts.

Existing work: [#334](https://github.com/GilgameshCaw/Caw/pull/334) `4206f96cb0c1d1d70617fba4eabeb5b852768ed6` (open), [#342](https://github.com/GilgameshCaw/Caw/pull/342) `39435a853dd4673ac39ce5b34f97f7f0ef1e6299` (open, draft)

#### BURN-01 — SPECIFICATION DECISION

Requirement: **M-E / R-C**. Priority: MEDIUM (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawProfileMinter.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileMinter.sol#L312) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: The minter recipient differs from the literal recipient specified in the manifesto.

**Open acceptance gate:** Resolve token compatibility and the exact intended burn semantics publicly; do not silently substitute an address or claim economic equivalence proves literal compliance.

Existing work: No bounded implementation fix established by this record.

#### TEXT-01 — SOURCE FINDING / OPEN PROOF

Requirement: **M-E / R-C**. Priority: MEDIUM (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawActions.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActions.sol#L206) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: The contract counts smltxt-compressed payload bytes. The pinned codec round-trips 600 ASCII characters into 227 bytes, below the 420-byte check. This is not only a Unicode-counting ambiguity; full transaction acceptance was not tested.

**Open acceptance gate:** Agree the decoded-character versus compressed-byte rule and protocol enforcement; preserve signed encoding and replay compatibility. See [the pinned reproduction](TEXT_LIMIT_REVIEW.md).

Existing work: No bounded implementation fix established by this record.

### review

#### GOV-02 — RELEASE DECISION

Requirement: **M-R / R-R / M-D**. Priority: HIGH (review prioritization, not exploit rating).

Source: [`solidity/scripts/deploy.js`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/scripts/deploy.js#L3023) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: A public builder-coordination proposal exists; its existence is not adoption of a release or governance process.

**Open acceptance gate:** Publish the candidate, independent review, objections, participants and explicit release agreement. Do not substitute Xubu for an indispensable maintainer.

Existing work: No bounded implementation fix established by this record.

#### CONTENT-01 — NO NEW DEFECT ESTABLISHED

Requirement: **M-R / R-R / M-D**. Priority: MEDIUM (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawActions.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActions.sol#L49) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: This register does not establish a protocol content-admin function. Frontend moderation is explicitly distinguished from protocol blocking in the manifesto.

**Open acceptance gate:** Keep protocol admission/censorship tests separate from permissible frontend policy; do not infer universal censorship resistance.

Existing work: No bounded implementation fix established by this record.

#### MEDIA-01 — NO NEW DEFECT ESTABLISHED

Requirement: **M-R / R-R / M-D**. Priority: LOW (review prioritization, not exploit rating).

Source: [`client/prisma/schema.prisma`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/prisma/schema.prisma#L42) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: The manifesto explicitly permits frontend image hosting. Centralized optional image hosting alone is not a protocol violation.

**Open acceptance gate:** Classify optional hosted bytes versus protocol records and disclose retention/replacement limits.

Existing work: No bounded implementation fix established by this record.

#### ADMISSION-01 — NO NEW DEFECT ESTABLISHED

Requirement: **M-R / R-R / M-D**. Priority: MEDIUM (review prioritization, not exploit rating).

Source: [`solidity/contracts/CawActions.sol`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActions.sol#L374) at `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

Observation: The reviewed validator-admission path uses a minted profile rather than a special developer allowlist.

**Open acceptance gate:** Retain independent admission and liveness tests; no duplicate allowlist-removal patch is justified.

Existing work: No bounded implementation fix established by this record.

## Additional current security review

[#422](https://github.com/GilgameshCaw/Caw/pull/422) reports missing SmartEOA delegation enforcement in the sponsor relay and proposes rejecting other implementations before forwarding value. [#423](https://github.com/GilgameshCaw/Caw/pull/423) proposes retiring unused sponsor-funded routes lacking a sponsor-consent check. These are nyaromesama's existing bounded patches; do not duplicate them. Their descriptions report focused tests and limitations, including fake RPC or unconfigured-service coverage rather than full live operation. This review has not independently rerun those cases. Resolve sponsor safety before relying on a sponsored path as release evidence; neither patch settles M-I withdrawal policy.

## Reproduce the source review

From a repository containing the baseline, `git show 97cd13f3a1423f702d411472fdd2b2a2e7bfbd59:<path>` emits the exact bytes for each path in the companion JSON. Hash those bytes with SHA-256 and compare its `sources` entry. Inspect the listed symbol and its callers; the URL pins the source line. This verifies source identity and the source-level observation, not deployed state. Follow each linked PR's own reproduction instructions for behavioral evidence and retain failures. The source files must match before carrying conclusions to another revision.

## Review evidence and maintenance

The companion [JSON register](MANIFESTO_R2_RELEASE_REVIEW.json) lists exact PR heads and links to independent discussion records fetched for Xubu's PRs. A linked comment may contain objections or limited source review, not approval. In particular, #345's independent ABI/checkpoint review does not establish live L1 replay; #328's independent content/merge review does not establish complete history. Keep #334 (documentation), #342 (policy-sensitive terminal-state proposal) and #274 (Civic wiring) separate from acceptance of the policies they expose.

For each response, identify the row, candidate commit, test/reproduction or public decision, and residual limitation. Close a row only when its own evidence gate is met or a source-backed no-defect classification is recorded. Prefer amending existing PRs. No runtime changes or automatic acceptance/merging are proposed here. Technical discussion belongs in the applicable PR; cross-cutting agreed specifications and release governance belong in the shared builder-coordination thread.


### #421 amendment — 2026-11-05 UTC

The R-01 commit-replacement case was reproduced against the prior installer and addressed at `b210d060e247684edaab2021c3d8653d0c885ee5`. Eleven local cases and two expected failing controls are recorded in the linked PR. This updates RELEASE-01 only; full installation, independent build, concurrency and #237 integration remain unproved. The initial register capture remains historical.


### TEXT-01 reproduction — 2026-11-05

[The codec/source-predicate reproduction](TEXT_LIMIT_REVIEW.md) sharpens the prior generic byte/character concern: 421 ASCII characters compress to160 bytes and600 compress to227. All round-trip. No EVM, API, valid signed action or deployed transaction was exercised. R2 permits clear agreed changes; the review asks for the rule and enforcement decision, not a silent behavioral change.


Related existing work: [#380](https://github.com/GilgameshCaw/Caw/pull/380) handles bot compatibility with the compressed-byte ceiling. Its reported Japanese-text tests are attributed, not rerun here. TEXT-01 asks the separate protocol-rule question; no duplicate bot patch is proposed.


### DM-03 storage trace — 2026-11-05

[The retention decision record](DM_PERMANENCE_REVIEW.md) distinguishes per-user hiding from nulling ciphertext/history and replacing group ciphertext. It links existing #215 rather than duplicating it. Source inspection alone does not prove every copy is lost or resolve whether the permanent-data promise includes these DMs. The title warning labels a compliance review, not a verdict that every row is a demonstrated violation.


### NFT-01 same-block owner-stamp review

[The source trace](NFT_OWNER_STAMP_REVIEW.md) identifies a possible local owner-mirror divergence when two transfers share a block stamp. Predicate-model evidence is not contract execution. Actual-contract reproduction and replay-safe design remain required before a behavioral patch.


### DEP-01 / HIST-01 archive challenge-window boundary

[The archive review](ARCHIVE_CHALLENGE_WINDOW_REVIEW.md) traces the two-day monitoring and resolution assumption, including delivered-but-unresolved challenges. Source inspection does not establish a live exploit or disqualify optimistic designs. Independent outage/recovery and reader-rejection evidence remain necessary; existing archive PRs are linked rather than duplicated.


### NFT-01 stale marketplace listings — existing #351

[The ownership review](STALE_LISTING_OWNERSHIP_REVIEW.md) traces settlement paying the recorded seller while transferring from the current approved NFT owner. Existing draft #351 addresses this and reports contract regressions; those results are attributed, not independently rerun here. Separate stale-listing cleanup is not a settlement ownership check. No duplicate PR.
