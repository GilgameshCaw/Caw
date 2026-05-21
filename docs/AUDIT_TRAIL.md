# CAW Protocol — Audit Trail

This document decodes the audit-trail tags embedded in the V2 contract source code.
Readers landing on Etherscan or viewing the source directly will encounter references
like `H-6`, `Round 4 LZ agent`, or `Audit fix 2026-05-08`. This document explains
what those tags mean and where the underlying findings live.

---

## 1. Tag convention decoder

Tags appear in NatSpec comments and inline code comments. They are never stripped — they
are permanent source-level breadcrumbs that tie a specific line of code to the audit
finding that motivated it.

### Severity prefixes

| Tag      | Meaning                                                                 |
|----------|-------------------------------------------------------------------------|
| `C-N`    | Critical-severity finding number N in a given audit pass               |
| `H-N`    | High-severity finding number N                                         |
| `M-N`    | Medium-severity finding number N                                       |
| `L-N`    | Low-severity finding number N                                          |
| `INFO-N` | Informational finding number N (no exploit path; code quality / style) |

Numbering restarts per audit pass. `H-1` in the 2026-05-08 pass and `H-1` in the
2026-05-17 pass are different findings. The date in the surrounding comment (e.g.
`Audit fix 2026-05-08`) disambiguates.

### Round tags

`Round N` refers to the round of an adversarial review drill within a single audit
session. Each round was a fresh-eyes pass over a different contract cluster or
cross-contract interaction class.

`Round N <focus> agent` identifies a specialist sub-agent within that round. Examples:

| Tag seen in source                      | Meaning                                                                |
|-----------------------------------------|------------------------------------------------------------------------|
| `Round 3 CawActions adversarial agent`  | Round 3, adversarial-path focus on CawActions                         |
| `Round 4 CawActions LOW-1`              | Round 4, LOW-severity finding 1 from the CawActions sub-agent         |
| `Round 4 LZ agent LOW-3`               | Round 4, LOW-severity finding 3 from the LayerZero-focused sub-agent  |
| `Round 4 marketplace MED-1`            | Round 4, MED-severity finding 1 from the Marketplace sub-agent        |
| `Round 7`                               | Round 7 of the 2026-05-08/09 multi-pass session                       |
| `Round 7 econ HIGH-1`                   | Round 7, HIGH-severity finding 1 from the economics sub-agent         |
| `Round 7 CL-4`                          | Round 7, finding CL-4 (cross-contract layered finding 4)              |

### Integration audit tags

`Integration audit YYYY-MM-DD` refers to a focused pass over contract-to-contract
interaction paths on that date. `Integration audit #52 M-1` means finding M-1 from
integration audit session 52 (internal session numbering).

### Dated fix tags

`Audit fix YYYY-MM-DD` means a fix was committed on that calendar date. The change is
recoverable via `git log --grep="Audit fix YYYY-MM-DD"` or `git blame` on the specific
line. Example: `Audit fix 2026-05-08 (ARC-3)` means the fix for finding ARC-3 landed on
2026-05-08; `git log --grep="ARC-3"` or `git log --grep="2026-05-08"` will surface the
commit.

### Final audit tags

`Final audit YYYY-MM-DD` refers to a pre-deploy closing pass on that date that confirmed
no remaining blockers on the in-scope contracts.

---

## 2. Pre-deploy audit pass timeline

Seven distinct audit passes ran against the V2 contracts before deploy. Each is
described below in chronological order.

### Pass 1 — 2026-05-08: Multi-pass adversarial review (7 rounds)

**Date:** 2026-05-08 – 2026-05-09
**Scope:** CawActions, CawProfile (L1), CawProfileL2, CawActionsArchive,
CawChallengeRelay, CawNetworkManager (then CawClientManager), CawProfileMinter,
CawProfileMarketplace, CawBuyAndBurn, OnlyOnce, PathwayExpander, SigVerification.
**Structure:** Round 1 single-reviewer; Rounds 2–6 six parallel sub-agents (one per
contract cluster) plus cross-contract sequential passes; Round 7 economics deep-dive.
**Findings fixed in this pass:** ZK-B (ZK path skipped session expiry check),
L2-2 (registerSessionPersonal replay vulnerability), L2-5 (trapped ETH in bypassLZ
branch), ARC-3 (slash-loop DoS via unbounded validatorSubmissions array), C-1 (WITHDRAW
in bypassLZ mode silently lost CAW), H-1/WITHDRAW (double-debit on empty recipients),
H-1/authenticate (chosenChainIds not populated by standalone authenticate()),
M-1 (expired session fell through to ERC-1271 with owner authority), M-2 (zero-amount
depositFor polluted chosenChainIds), M-3/profile (peerWithMaxPendingTransfers panic on
empty peerIds), M-3/qs (malformed qs:/qx: payload reverted whole batch), CCM-1
(setFeeAddress missing zero-address check), plus LZ/marketplace/CawActions sub-agent
fixes (Archive MED-1, Archive MED-3 via renunciation reliance, CawActions M-1, M-3,
LOW-1, Round 4 marketplace MED-1, Round 7 econ HIGH-1).

**Findings deferred (real issues needing design work):** Archive HIGH-1
(future-checkpoint attack), Archive HIGH-2 (no srcEid binding for multi-source chains),
L1 M-1 (silent ETH retention on bypassLZ paths), L2 M-1 (LZ out-of-order ownership
desync), L2 M-3 (personal-sign replayable across L2 deployments), L2 M-4 (date parser
accepts invalid components), CawActions M-2 (ZK path session-revoke front-run reverts
whole batch).

**Test result:** 209 passing. 3 regression tests added.
**Findings list:** `docs/AUDIT_2026_05_08.md` (committed to this repo).

---

### Pass 2 — 2026-05-13: API/DB/smoothness + contract invariant deep-dive

**Date:** 2026-05-13
**Scope (contract portion):** CawProfileL2 session registration (ERC-1271 fallback
gap); full invariant deep-dive over all V2 state-evolution paths.
**Scope (off-chain portion):** API route auth (IDOR, mass-assignment), DB index
coverage, smoothness / scaling.
**Key contract fix:** CawProfileL2 `registerSession` / `registerSessionPersonal` —
added ERC-1271 fallback so smart-contract owners can register sessions.
**Contract invariant verdict:** CLEAN. Ten invariants checked; none broken. One
code-hygiene note (sessionSpent not zeroed on revoke) documented as non-exploitable.
**Findings list:** `docs/SECURITY_AUDIT_2026-05-13.md` (committed to this repo).

---

### Pass 3 — 2026-05-17: Full 10-domain sweep

**Date:** 2026-05-17
**Scope:** All V2 contracts plus backend services, frontend, indexers, DB, DM crypto,
devops, dependencies.
**Structure:** 10 parallel sub-agents (one per domain) plus orchestrator consolidation.
**Key contract fixes landed in this pass:**
- CawActions ZK mixed-sender guard (H-1 from the ZK domain report).
- CawActionsArchive `>` → `>=` finalize boundary fix (was off-by-one on the challenge
  window edge).
- CawActions sub-batch session-spend drift fix.
**Findings dismissed as overreach (with auditor notes left inline in source):**
- CawActions `_pendingWithdrawIds` nonReentrant claim: reentrancy chain unreachable.
- CawBuyAndBurn `block.timestamp` deadline: economic alignment is the safety mechanism.
- CawBuyAndBurn unchecked `CAW.transfer`: OZ-derived token reverts on failure.
**Findings list:** `messages/audit-2026-05-17/` (gitignored; internal). See inline
auditor notes in `CawActions.sol` and `CawBuyAndBurn.sol` for dismissed-finding
rationale.

---

### Pass 4 — 2026-05-19: Extensive 6-hour multi-agent V2 audit

**Date:** 2026-05-19
**Scope:** All V2 contracts. 22 per-contract reports + 18 themed reports + 9
cross-contract reports. Dedicated passes for economic invariants, ZK path, LZ message
path, session / signing UX, marketplace.
**Key contract fixes (H-priority blockers fixed on master):** H-1, H-2 (narrow variant),
H-3, H-5, H-6, H-8, H-9, H-10, H-13, H-15, H-17, H-19 (SP1 verifier provenance),
H-23. See commit range `d3ea6c29` → `2096c3db`.
**Findings dismissed after orchestrator verification:**
- T2 F-1 (`setPeer` without `onlyOwner`): FALSE POSITIVE. `OAppCore.setPeer` is
  `public virtual onlyOwner`; the overrides preserve access via `super.setPeer()`.
- X8 C-1 (buyAndBurn aliasing): DOWNGRADED to MEDIUM. Impacts only the specific
  network that aliased its own `feeAddress`; not cross-network.
- H-11 (`lockedWithdrawFee` permissionless griefing): DISMISSED. The lock is a ceiling
  (user pays `min(locked, current)`), not a floor. An attacker locking a high rate is
  benign because the user always pays the lower of locked vs current.
**Findings list:** `messages/audit-2026-05-19-extensive/` (gitignored; internal).
H-15 behavioral note: CawProfileMarketplace ETH proceeds are pull-pattern
(`pendingPayouts` + `withdrawPayouts`). Seller balance does not change on sale;
indexers and the frontend must call `withdrawPayouts` to observe settled proceeds.

---

### Pass 5 — 2026-05-19 (Round 2): Exploit drill — vault sovereignty + LZ semantics

**Date:** 2026-05-19 (same session as Pass 4, second phase)
**Scope:** Five escalated exploit scenarios (vault drain, session hijack without
phishing, censorship under determined attacker, LZ message forge, gas budget on mainnet
fork) plus two LZ V2 deep-dives.
**Key fixes landed:**
- `setWithdrawable` gas budget raised (22k+19k×n → 35k+24k×n, mainnet fork measured).
- `setERC1271Sibling` locked with OnlyOnce.
- `MIN_STAKE` raised from 0.01 ETH to 0.5 ETH on CawActionsArchive.
- 10-minute cooldown on `checkpointClaimed` after slash.
- `MAX_SESSION_SPEND` cap added (1B CAW).
**Key resolutions (do not re-litigate):**
- CAW vault `rewardMultiplier` is conservative: `totalCaw` is invariant; no
  over-withdraw path exists.
- LZ V2 enforces exactly-once delivery atomically: `_clearPayload` + `lzReceive` are
  in the same tx; reverts restore payload hash; retries are safe.
- `endpoint.lzReceive()` is permissionless: anyone can retry a stuck message with more
  gas; no admin needed.
**Findings list:** `messages/audit-2026-05-19-extensive/EXPLOIT_DRILL_ROUND_2_SYNTHESIS.md`
(gitignored; internal).

---

### Pass 6 — 2026-05-21: V5 SmartEOA + sponsor integration audit

**Date:** 2026-05-21
**Scope:** SmartEOA.sol (EIP-7702 delegate), CawProfileMinter.sol (three sponsored
entry points), ISmartEOA interface. New code only — the 7702 passkey sponsorship design
landed in this commit set.
**Key fixes from this pass:**
- `depositForSponsored` Step 3b: pull-and-approve was missing; HIGH-1 from integration
  audit fixed at `CawProfileMinter.sol` line 449.
- Re-audit LOW finding noted at line 427.
**Findings list:** Internal (`messages/` / session history). Inline auditor notes in
`CawProfileMinter.sol` document the wallet compatibility analysis (integration audit
#52 M-1).

---

### Pass 7 — 2026-05-21: Final pre-deploy closing pass

**Date:** 2026-05-21
**Scope:** All V2 contracts; focus on any issues introduced by the V5 SmartEOA
additions and the per-fee ceiling feature.
**Verdict:** READY TO DEPLOY for the 7 contracts reviewed. No new blockers found.
**Notable L-1 (low, informational):** CawProfile `transferAndSync` — a timestamp hint
was embedded in the LZ payload for indexer convenience. Noted inline at
`CawProfile.sol` line 495 as `Final audit 2026-05-21 L-1`.
**Findings list:** Internal (session history).

---

## 3. Findings intentionally dismissed (do not re-flag)

The following findings were raised by one or more audit agents and subsequently
confirmed non-issues by a verification pass. They are listed here so a re-auditor does
not spend time re-investigating closed paths.

| Finding ID | Contract | Claim | Why dismissed |
|---|---|---|---|
| T2 F-1 | CawActionsArchive / CawProfile / CawProfileL2 | `setPeer` callable without `onlyOwner` | FALSE POSITIVE. `OAppCore.setPeer` is `public virtual onlyOwner`; CAW overrides call `super.setPeer()` which preserves the modifier. Verified in `@layerzerolabs/oapp-evm` node module. |
| X8 C-1 | CawBuyAndBurn | Aliasing `feeAddress` to `buyAndBurnAddress` bricks all networks | DOWNGRADED. The underflow is real but is scoped to the single network that performed the aliasing. No cross-network impact. |
| H-11 | CawProfileL2 | `lockedWithdrawFee` permissionless grief: attacker locks a high rate | DISMISSED. Lock is a ceiling (`min(locked, current)`). Locking a high value is harmless; user always pays the lower of locked vs current fee. |
| V5 (pass 2) | ValidatorService | `resolveCawonceUsed` silently loses actions | VERIFIED CLEAN. Function asks "is this on-chain action OURS?" — the chain stores only the bitmap, not content. The indexer-aware timeout is by design, not a gap. |
| V6 (pass 2) | ValidatorService | Mixed batch failures mass-fail non-cawonce entries | VERIFIED CLEAN. `recoverBatchFailure` (line 1624) does per-entry re-simulation; the `every()` short-circuit at line 2236 is only the initial check before recovery. |
| H-1 nonReentrant | CawActions | `_pendingWithdrawIds` needs `nonReentrant` | DISMISSED. Reentrancy chain unreachable: LZ endpoint cannot callback same-tx; bypassLZ path makes no external calls during `_pendingWithdrawIds` traversal. Auditor note in `CawActions.sol`. |
| BB deadline | CawBuyAndBurn | `deadline: block.timestamp` is unsafe | DISMISSED. Economic alignment is the safety mechanism: the network operator who triggers `withdrawFees` receives half the swap output, giving them equal incentive to supply a tight `minCawOut`. CawProfile is immutable so a future caller cannot pass `minCawOut=0`. |
| BB transfer | CawBuyAndBurn | Unchecked `CAW.transfer` return value | DISMISSED. The canonical CAW ERC-20 is OpenZeppelin-derived and reverts on failure; the missing return check is a no-op against the deployed token. Auditor note in `CawBuyAndBurn.sol`. |

---

## 4. Known open items (deferred, not ignored)

These are real issues that were identified and deliberately deferred. They are not
exploitable in the current single-source-chain deployment, or they require design work
beyond a single-line fix.

- **Archive HIGH-1 (future-checkpoint attack):** A validator can submit replication for
  checkpoints that do not yet exist on the source L2. If L2 does not catch up within
  the 2-day challenge window, neither fraud-proof mode can fire. Requires an L2-liveness
  mechanism. Only exploitable once a validator submits for a future cp AND L2 doesn't
  catch up. No known cases.

- **Archive HIGH-2 (no srcEid binding):** Relevant only when a second source chain is
  peered to the archive. Not triggered in single-source deployments.

- **L2 M-3 (personal-sign cross-deployment replay):** `registerSessionPersonal` does
  not bind to chain ID or contract address. The same user-signed message replays on any
  L2 deployment of CawProfileL2. Requires a coordinated FE + contract change to fix
  fully. Impact is limited to session setup only; session keys themselves are
  chain-specific once registered.

- **L2 M-4 (date parser edge cases):** `_parseExpiryValue` accepts invalid date
  components (e.g., Feb 31). Parses silently rather than rejecting. Not a loss-of-funds
  path; the resulting expiry may differ from user intent.

---

## 5. Reading order for security researchers

For a fresh audit of the CAW V2 contracts, the following reading order is recommended:

1. **`SmartEOA.sol`** — Start here for the EIP-7702 passkey sponsorship model (V5).
   The Caller Audit at the bottom of the file documents every external entry point.

2. **`CawProfileMinter.sol`** — Three sponsored entry points
   (`mintAndDepositSponsored`, `depositForSponsored`, `authenticateSponsored`). The
   `_checkPermit` function is the trust boundary for EIP-712 + ERC-1271 + ISmartEOA
   nonce verification. Read the wallet-compatibility note in the sponsor-entry-points
   block comment.

3. **`CawActions.sol`** — The action-processing core. Two entry points
   (`processActions` sig path, `processActionsWithZkSigs` ZK path). The sig-path
   verification functions (`_verifySignatureMem`, `_verifyBatchSignature`) and the ZK
   path's `_zkProcessOneGroup` are the densest security surface. Pay attention to the
   session-expiry checks and the ERC-1271 fallback ordering (M-1 from the 2026-05-08
   pass was a fallback-ordering bug).

4. **`CawActionsArchive.sol`** — The optimistic-archive challenge model. `submitReplication`,
   `resolveChallenge`, `slashIncoherentRoot`, and `finalizeSubmission` are the four
   functions that determine whether fraud gets slashed. Note the `CHALLENGE_PERIOD`,
   `MIN_STAKE`, and the `validatorSubmissions` pruning (H-6 fix) that bounds slash-loop
   gas.

5. **`CawChallengeRelay.sol`** — Permissionless; anyone can call `relayChallenge`.
   Read in tandem with `CawActionsArchive` to understand the full fraud-proof flow.

6. **`CawProfile.sol`** and **`CawProfileL2.sol`** — Token custody (L1) and balance /
   session management (L2). The cross-chain ownership sync (`chosenChainIds`,
   `_updateNewOwners`) and the session-key model (registration, revocation, epoch
   bumping for the CL-4 out-of-order-delivery defence) are the main complexity.

7. **`SigVerification.sol`** — Extracted library for bounded ERC-1271 staticcalls.
   Read before diving into CawProfileL2's session-registration paths.

8. **`CawCapOracle.sol`** + **`CawL1PriceReader.sol`** — TWAP oracle and L1 price
   reader for the ETH-denominated per-action cost cap. Review the ring buffer
   overflow handling and the `>24h stale` dormancy policy.

9. **`CawProfileMarketplace.sol`** — Pull-pattern ETH payouts (H-15) and the English
   auction escape hatch (H-17). Every external entry point is `nonReentrant`.

10. **`CawBuyAndBurn.sol`** — Simple swap-and-burn wrapper. Read the auditor notes at
    the top for the two intentionally-dismissed findings before raising them again.

---

*This document is part of the CAW V2 contract source. Pre-deploy audit passes: 7.
Findings list locations: `docs/AUDIT_2026_05_08.md` (public), `docs/SECURITY_AUDIT_2026-05-13.md`
(public); remaining passes logged internally at `messages/audit-2026-05-17/` and
`messages/audit-2026-05-19-extensive/` (gitignored).*
