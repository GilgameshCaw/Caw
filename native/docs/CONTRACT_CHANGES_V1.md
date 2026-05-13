# Contract changes for v1

**One change** is required before deploy: add an ERC-1271 fallback to session-key registration in `CawProfileL2`.

That's it. Everything else needed for the 7702 + passkey-signer flow is already in the contracts:

- `CawActions._verifySignatureMem` and `_verifyBatchSignature` already have ERC-1271 fallback (audited 2026-05-08).
- `ownerSessionEpoch` invalidates sessions on transfer (CL-4 fix).
- `mintFor` / `mintAndDepositFor` / `depositFor` already exist on `CawProfileMinter` and `CawProfile`.
- ERC-1271's variable-length signatures can already be packed into the existing `bytes` storage on the action path.

The one gap is that `CawProfileL2.registerSession`, `registerSessionPersonal`, and `revokeSessionBySig` all do ecrecover-only — so a 7702-delegated smart EOA whose primary signer is a passkey **cannot register a session key** today. Action signing works (because of the 1271 fallback in `CawActions`), but the user can't get to the point of having a session key without a contract change.

Per-tokenId session scoping was scoped here in an earlier revision of this doc and has been **deferred to a later version**. The wallet-scoped design + `ownerSessionEpoch` + scope bitmap + spend limit + short expiry is good enough for v1; per-token scoping is a real improvement for the external-app-delegation use case but isn't load-bearing for the magic-wallet user we're building for.

## The change

Three functions on `CawProfileL2` need ERC-1271 fallback:

1. `registerSession` — the EIP-712 path
2. `registerSessionPersonal` — the personal_sign path
3. `revokeSessionBySig` — the sig-based revocation path (also ecrecover-only today)

The pattern mirrors `CawActions._checkERC1271`. For each function, the change is:

- Try ecrecover first. If it recovers to the expected signer, accept (existing behaviour preserved).
- If ecrecover fails or doesn't match, and `signer.code.length > 0`, call `IERC1271(signer).isValidSignature(digest, signatureBytes)` and accept if it returns the magic value `0x1626ba7e`.
- Otherwise revert.

## Signature shape

The existing functions take `(uint8 v, bytes32 r, bytes32 s)`. ERC-1271 signatures are variable-length `bytes` (passkey signatures are ~128 bytes, multisig signatures even longer). We have two options:

**Option A: add new `bytes`-signature overloads alongside the existing tuple-form ones.**
Two entry points per operation: the old `(v,r,s)` form for ECDSA users, and a new `bytes signature` form for smart-EOA users. Backwards-compatible without thinking about it. Slight bytecode duplication.

**Option B: replace the tuple form with a `bytes signature` form and convert legacy callers.**
Cleaner long-term. Breaks any external caller (backends, scripts, the frontend) that constructs sigs in the old shape. We control all those callers, but it's more churn for v1 ship.

**Decision: Option A.** Backwards compat keeps the existing test suite green without modification. The new overloads are additive; the audit surface is bounded; the frontend can migrate incrementally. The old `(v,r,s)` form remains the fast path for ECDSA users (and the validator service's own bookkeeping) — gas slightly cheaper than the bytes-form for ECDSA because we skip a memory copy.

## Internal refactor

To avoid duplicating logic between the tuple- and bytes-form overloads, extract a private helper:

```solidity
function _registerSession(
  address signer,
  bytes32 digest,
  address sessionKey,
  uint64 expiry,
  uint8 scopeBitmap,
  uint256 spendLimit,
  uint64 perActionTipRate,
  uint256 nonce
) internal {
  if (sessionKey == address(0)) revert ZeroKey();
  if (expiry <= block.timestamp) revert Expired();
  require((scopeBitmap & 0x40) == 0, "no WITHDRAW");
  require(nonce == sessionNonce[signer], "Invalid nonce");

  sessionNonce[signer]++;
  sessions[signer][sessionKey] = StoredSession(
    expiry, scopeBitmap, spendLimit, perActionTipRate, ownerSessionEpoch[signer]
  );
  emit SessionCreated(signer, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate);
}
```

Then both public overloads recover the signer (ecrecover for `(v,r,s)`, 1271 for `bytes`) and call into `_registerSession`. Same for `registerSessionPersonal` and `revokeSessionBySig`.

## Audit invariants to preserve

The 2026-05-08 audit pass added several invariants that must remain intact:

1. **Replay protection.** `sessionNonce[signer]` for EIP-712 sigs, `consumedSessionMessage[digest]` for personal_sign sigs. The new bytes-form overloads must check the same things. **No "skip nonce because it's a 1271 sig" shortcut** — replay protection is independent of signer type.

2. **Expired-session fallthrough.** The matching code in `CawActions` reverts with "Session expired" rather than letting an expired session fall through to ERC-1271 silently re-validating it as the owner. We're not touching `CawActions` here, but the new code in `CawProfileL2` must not introduce an analogue — specifically, **a 1271 contract's `isValidSignature` returning `true` is sufficient authorization for the registration; we don't separately check whether the contract is "still" the owner of some token, because session registration is wallet-scoped and the signer *is* the wallet identity.**

3. **No WITHDRAW delegation.** The `scopeBitmap & 0x40 == 0` check must remain regardless of signer type.

4. **Gas-bounded 1271 calls.** Mirror the gas-limit pattern from `CawActions._checkERC1271`. A malicious 1271 contract should not be able to grief the registration call with a gas-eating implementation.

5. **Zero-signer rejection.** ecrecover can return `address(0)` on a malformed sig; we need to reject that. The 1271 path doesn't have an analogue, but we should reject `signer == address(0)` regardless (it's a meaningless registration).

## Risk surface

The change adds these new behaviours:

- Smart-EOAs (Safe, 7702-delegated) can now register session keys via their 1271 path. **This is the goal.**
- The validator service, frontend, and any external script must understand both signature shapes when constructing or consuming registration calls. Backwards compat means existing callers don't need changes; new callers can use the bytes form.
- The bytecode for `CawProfileL2` grows. We need to check the 24576-byte limit and factor out if needed.

The change does **not** alter:
- Action signing (`CawActions` is unchanged).
- Spend-limit enforcement.
- Transfer behaviour or `ownerSessionEpoch`.
- The L1-bridged session path (`registerSessionFromL1`) — that's a privileged path callable only from L1 via LZ, not a user-sig path, so no ERC-1271 question arises.

## Implementation plan

1. Extract `_registerSession` / `_registerSessionPersonal` / `_revokeSessionBySig` private helpers from the existing functions (pure refactor — should not change behaviour).
2. Add bytes-form public overloads that perform ERC-1271 recovery before calling the helper.
3. Add a private `_checkERC1271(signer, digest, signature)` helper (or import the one from CawActions if it's library-able).
4. Run existing solidity tests — must all still pass.
5. Add new tests covering: smart-EOA registers a session, smart-EOA with bad sig rejected, smart-EOA revokes, smart-EOA personal_sign path.
6. Self-audit against the invariants list above.
7. Check contract size against 24576-byte limit; factor if necessary.

## What this doesn't ship

To be clear about the scope:

- No per-tokenId sessions. Deferred until external-app delegation is a real use case.
- No `registerSessionFromL1` ERC-1271 path. The L1 contract is the sole caller of that and it's not signing on behalf of a user.
- No multi-signer / threshold registration. A smart-EOA implementing 1271 can internally enforce whatever signer rules it wants — that's the 1271 contract's job, not ours.
- No on-chain registry of which addresses are smart EOAs. We detect via `code.length > 0` at call time. Simple, correct, no maintenance.
