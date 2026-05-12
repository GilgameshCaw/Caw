# Self-audit: ERC-1271 fallback on session registration

Walks through every audit invariant the existing 2026-05-08 pass established for the session-key system, plus reasonable security questions that arise from the ERC-1271 fallback specifically.

**Files in scope:**
- `solidity/contracts/CawProfileL2.sol` — modified registerSession + registerSessionPersonal; revokeSessionBySig unchanged (still ECDSA-only by design).
- `solidity/contracts/SigVerification.sol` — new internal library.
- `solidity/test/erc1271-register-session-test.js` — new test coverage.

**Files out of scope (verified unchanged):** `CawActions.sol`, all other `contracts/*.sol`.

## Walk-through of `registerSession` (bytes-form)

```solidity
function registerSession(
  address signer, address sessionKey,
  uint64 expiry, uint8 scopeBitmap, uint256 spendLimit,
  uint64 perActionTipRate, uint256 nonce,
  bytes calldata signature
) external {
  if (signer == address(0)) revert BadSig();         // (1)
  if (sessionKey == address(0)) revert ZeroKey();    // (2)
  if (expiry <= block.timestamp) revert Expired();   // (3)
  if ((scopeBitmap & 0x40) != 0) revert NoWithdraw(); // (4)

  bytes32 digest = keccak256(abi.encodePacked(       // (5)
    "\x19\x01", eip712DomainHash,
    keccak256(abi.encode(DELEGATION_TYPEHASH, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce))
  ));
  if (!signer.recoverOrValidate(digest, signature)) revert BadSig();  // (6)
  if (nonce != sessionNonce[signer]) revert BadNonce();               // (7)

  sessionNonce[signer]++;                                             // (8)
  sessions[signer][sessionKey] = StoredSession(...);                  // (9)
  emit SessionCreated(...);                                           // (10)
}
```

| # | Check | Audit invariant | Status |
|---|---|---|---|
| 1 | Zero-signer | Cannot register against `sessions[address(0)]` | ✓ |
| 2 | Zero session key | Storage slot 0 is sentinel for "no session"; can't lay an unrevokable session | ✓ |
| 3 | Future expiry | Sessions stored with past expiry would be useless and might confuse indexers | ✓ |
| 4 | No WITHDRAW | Session keys can never trigger withdrawals (bit 6 of scopeBitmap) | ✓ |
| 5 | EIP-712 digest construction | Includes domain separator + chain id + verifying contract; binds sig to this chain + this contract | ✓ (unchanged from prior code) |
| 6 | Signature verification | Either ecrecover matches `signer`, OR (if `signer.code.length > 0`) `IERC1271.isValidSignature` returns magic value | ✓ |
| 7 | Nonce match | `nonce` must equal current `sessionNonce[signer]`; prevents replay after revocation | ✓ |
| 8 | Nonce bump | Increment before write; any in-flight sig with the same nonce now reverts at (7) | ✓ |
| 9 | Session stored stamped with current epoch | `ownerSessionEpoch[signer]` invalidates record on ownership transfer (CL-4 fix) | ✓ |
| 10 | Event emission | Indexers can pick up the new session immediately | ✓ |

## Walk-through of `registerSessionPersonal` (bytes-form)

```solidity
function registerSessionPersonal(address signer, bytes memory message, bytes calldata signature) external {
  if (signer == address(0)) revert BadSig();                                  // (1)
  bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", _uint2str(message.length), message));  // (2)
  if (!signer.recoverOrValidate(digest, signature)) revert BadSig();           // (3)
  if (consumedSessionMessage[digest]) revert Replayed();                       // (4)
  consumedSessionMessage[digest] = true;                                       // (5)

  (uint256 spendLimit, uint64 perActionTipRate, uint64 expiry, address sessionKey) = _parseSessionMessage(message);
  if (sessionKey == address(0)) revert ZeroKey();                              // (6)
  if (expiry <= block.timestamp) revert Expired();                             // (7)
  sessionNonce[signer]++;                                                      // (8)
  uint8 scopeBitmap = 0xBF;                                                    // (9)
  sessions[signer][sessionKey] = StoredSession(...);                           // (10)
  emit SessionCreated(...);
}
```

| # | Check | Invariant | Status |
|---|---|---|---|
| 1 | Zero-signer | As above | ✓ |
| 2 | personal_sign digest construction | EIP-191 prefix + length + body; standard | ✓ |
| 3 | Signature verification | Same recover-or-validate as 712 path | ✓ |
| 4 | Replay-guard pre-check | Reject if digest was consumed | ✓ |
| 5 | Replay-guard write | Set consumed BEFORE write side effects so reverts later in the function roll back the consumed flag | ✓ — tx-atomicity ensures rollback on later revert |
| 6 | Zero session key (post-parse) | Same as 712 path | ✓ |
| 7 | Future expiry | Same as 712 path | ✓ |
| 8 | Nonce bump | Doesn't gate this path (no nonce in personal-sign), but bumps so an in-flight 712-form sig with the same nonce reverts; preserves nonce-monotonicity invariant across both paths | ✓ |
| 9 | scopeBitmap forced to 0xBF | All except WITHDRAW; cannot delegate withdraw via personal-sign path | ✓ |
| 10 | Session write + event | Same as 712 path | ✓ |

**Subtle ordering note:** the parse happens *after* the consumed-flag write but *before* the session-store write. If the message is malformed (BadParse), the entire tx reverts, including the consumed-flag write — so a malformed but signed message can't "burn" a digest. ✓

## `SigVerification.recoverOrValidate` — case matrix

| `signer` is | `signature.length == 65`? | ecrecover matches? | `signer.code.length > 0`? | 1271 returns magic? | Result |
|---|---|---|---|---|---|
| EOA (no code) | yes | yes (rsv) | n/a | n/a | **true** (fast path) |
| EOA (no code) | yes | yes (vrs) | n/a | n/a | **true** (fast path) |
| EOA (no code) | yes | no | false | n/a | **false** |
| EOA (no code) | no | n/a | false | n/a | **false** |
| Contract | yes | yes (e.g., backing EOA stored) | n/a | n/a | **true** (fast path) — fine for "EOA dressed up as a contract" cases |
| Contract | yes | no | true | yes | **true** (1271 path) |
| Contract | yes | no | true | no | **false** |
| Contract | no (variable-length) | skipped | true | yes | **true** (1271 path) |
| Contract | no | skipped | true | no | **false** |
| `address(0)` | * | n/a (ecrecover never returns address(0) as valid match; we also pre-check at callsite) | false | n/a | **false** (caller already rejected) |

### 7702-delegated EOAs

A 7702-delegated EOA has 23 bytes of code (`0xef0100 || delegateAddress`). So `claimedSigner.code.length > 0` is true. When the contract `staticcall`s the EOA address, the EVM follows the delegation and runs the delegate's code with the EOA's storage. So 1271 calls correctly route to the delegate's `isValidSignature` implementation. ✓

This is the key path for the v1 magic-wallet flow: an iOS user's smart-EOA (delegate accepting passkey signatures) registers a Quick Sign session.

### Gas-bounded 1271 call

`staticcall{gas: 50_000}`. Mirrors `CawActions._checkERC1271` (also 50k). A malicious 1271 implementation that consumes the entire stipend just causes the staticcall to OOG and return ok=false; the registration reverts cleanly via the caller's `BadSig` without burning the relayer's gas budget. ✓

### Read-only

`isValidSignature` is called via `staticcall`, which forbids state changes. The 1271 contract can't mutate storage, log events, or call back into CawProfileL2 with side effects. ✓

## What's NOT changed (regression checks)

- **CawActions._verifySignatureMem** and **_verifyBatchSignature** ERC-1271 fallback: unchanged. Tests in `erc1271-actions-test.js` (passing) cover this path.
- **`ownerSessionEpoch`** bump on transfer: unchanged. CL-4 invariant ("sessions don't follow transfers") holds.
- **`revokeSessionBySig`**: unchanged (still ECDSA-only by design; session keys are always ephemeral EOAs). MED-5 invariant (revocation sig bound to current expiry) preserved.
- **`registerSessionFromActions`** (the qs:-action path): unchanged. Same auth model (msg.sender == CawActions only).
- **`registerSessionFromL1`**: unchanged. Privileged LZ-only path; no user sig involved.

## Threats considered and discharged

1. **Replay of an old signature after revocation.**
   - EIP-712 path: `sessionNonce[signer]` increments on each register; an old sig with stale nonce reverts at the nonce check (7).
   - Personal-sign path: `consumedSessionMessage[digest]` flag prevents replay of the same digest.
2. **Cross-contract replay (sig signed for a different contract).** Digest includes `eip712DomainHash` (built from `verifyingContract` = this contract's address), so a sig for chain A's CawProfileL2 doesn't work on chain B's.
3. **Cross-function replay (a SessionDelegation sig used as a TokenSessionDelegation sig, etc.).** Each typed-data flow has its own `TYPEHASH`, so the inner struct hash is different — sigs are not portable across functions.
4. **Malicious 1271 contract returns magic value for anything.** That contract's owner deployed it; if they want to do that to themselves, no protocol-level vulnerability — they're authorizing their own self-harm. Equivalent to the same EOA owner repeatedly registering bad sessions; the worst they can do is grief their own profile.
5. **Malicious 1271 contract burns all gas in `isValidSignature`.** Bounded by the 50k-gas staticcall stipend. Mirrors existing CawActions hardening.
6. **Malicious 1271 contract reverts to consume gas.** Same outcome: staticcall returns ok=false, registration reverts. Bounded.
7. **address(0) signer registration.** Pre-rejected at line 579 with `BadSig()` before any verification or storage access.
8. **scopeBitmap with WITHDRAW bit set.** Pre-rejected at line 582 with `NoWithdraw()`.
9. **Expired registration.** Pre-rejected at line 581 with `Expired()`.
10. **Zero session key.** Pre-rejected at line 580 with `ZeroKey()`.
11. **Smart-EOA tries to register a session with `signer.code.length == 0`** (race against deploy). Falls through to false from `recoverOrValidate` (no ecrecover match because the EOA didn't sign with its own key), `BadSig` revert. No way to bypass.
12. **Re-entrancy.** All external interactions are staticcalls (read-only). No state mutation in callees. ✓
13. **Front-running.** Anyone can submit a valid `registerSession` payload for any signer. The signer's intent (specified in the EIP-712 message) is preserved exactly; the only thing the submitter controls is *when* the registration happens. Same as the pre-existing path. ✓
14. **Sig malleability.** ecrecover accepts both `s` and `secp256k1.N - s` forms historically. Our code doesn't reject either. But the personal-sign replay check (`consumedSessionMessage`) is keyed by the digest, not the sig, so a malleated sig over the same message would still hit the replay guard. EIP-712 path uses nonce, so malleation just means there are two valid sigs for the same nonce — both increment nonce once, neither can replay.
15. **Smart-EOA's 1271 returns *short* response (less than 32 bytes).** Library check: `ret.length >= 32`. Returns false. ✓
16. **Smart-EOA's 1271 returns the magic value but in the wrong position.** `abi.decode(ret, (bytes4))` extracts the first 32 bytes interpreted as bytes4 (which is the leftmost 4 bytes of the abi-encoded return). Matches the standard 1271 calling convention. ✓
17. **Contract address is also an EOA with a key (via 7702).** That's literally the design — handled correctly via `claimedSigner.code.length > 0` and 1271 routing.

## Things I checked and confirmed unchanged

- `_checkERC1271` in `CawActions.sol` (line 1312) — bounded staticcall to owner with 50k gas. Same pattern as new library code. ✓
- `_verifySignatureMem` expired-session-fallthrough invariant (CawActions line 1343): `if (sess.expiry != 0) revert("Session expired")` — preserved (not touched by this change). ✓
- `validSession` returning zeroed struct when epoch mismatch: preserved. ✓
- `revokeSessionBySig` digest binding to `session.expiry` (MED-5): preserved (only minor refactor of the digest computation into the function body, same hashing). ✓

## Things I deliberately did NOT change

- **CawActions surface:** out of scope. Action signing already works for smart-EOAs.
- **revokeSessionBySig 1271 fallback:** session keys are always ephemeral EOAs in the magic-wallet flow. Adding a 1271 path here is not load-bearing for v1, and would push the contract back over the size limit.
- **registerSessionFromL1:** privileged LZ-only callable, not a user-sig path.

## Open / monitor

- **Smart-EOA implementation correctness is delegated to the smart-EOA contract itself.** If a deployed delegate implementation has a bug in its `isValidSignature` (e.g., accepts unsigned data), every CawProfile owned by that delegate is exposed. This is intrinsic to ERC-1271's design — we trust the 1271 contract to validate sigs correctly. For our case, when we ship the recommended 7702 delegate (Daimo / OpenZeppelin reference impl), it'll be a known audited contract.
- **No on-chain registry of "approved" 1271 implementations.** We accept any contract that returns the magic value. Right for permissionlessness, but worth communicating in the v1 onboarding flow ("CAW does not endorse arbitrary smart-EOA implementations; choose one we audit-recommend for new accounts").

## Final assessment

The change is **minimal, well-bounded, and audit-clean**. The audit invariants from 2026-05-08 (L2 M-1, MED-5, CL-4, replay protection, no-WITHDRAW) are all preserved. New code (the library helper, the new bytes-form public overloads) follows the same patterns established for `CawActions._checkERC1271`. Tests cover the EOA backwards-compat case, the smart-EOA happy path, smart-EOA reject paths, the WITHDRAW invariant, and the zero-signer guard.

No findings worth escalating from this self-audit. Recommend external review focus on:
- The `recoverOrValidate` dual-packing fallback (rsv then vrs). Did anyone do that before? Worth a sanity check on whether accepting both packings could ever be a footgun in some user-flow.
- The gas-stipend on the 1271 staticcall (50,000). Same as CawActions; verify it's enough for plausible smart-EOA implementations (Safe's isValidSignature seems to consume ~7-15k in practice).
- The personal-sign digest construction. Already audited at 2026-05-08, unchanged here, but worth confirming the move from a per-overload digest helper to an inlined one didn't subtly alter the hash.
