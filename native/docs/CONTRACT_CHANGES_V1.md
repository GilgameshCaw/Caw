# Contract changes for v1

The only contract change required before deploy is **per-tokenId session scoping**. Everything else needed for the 7702 + passkey-signer path is either already in the contracts (ERC-1271 fallback, ownerSessionEpoch) or off-chain (validator service extensions, native app code).

This doc is the spec. The implementation tasks are tracked separately.

## Why per-tokenId sessions are mandatory pre-deploy

Today's sessions are keyed `sessions[wallet][sessionKey]`. A session key registered for a wallet has authority over **every profile that wallet owns at registration time**. The recently-added `ownerSessionEpoch` mechanism handles profiles acquired *after* registration (the wallet's epoch bumps on outbound transfer, invalidating all stamped-at-old-epoch sessions). But within a single registration moment, the session applies to every profile the wallet currently holds.

This is fine for the single-profile / single-frontend default case but breaks down for:

- **Multi-profile users.** A user with `alice` and `alice_dev` profiles in one wallet, who enables Quick Sign on a frontend that thinks it's working with `alice`, has just authorized that frontend's session key to spend from `alice_dev` too. Surprising.
- **Multi-frontend ecosystem (the manifesto goal).** Two different CAW frontends (or one CAW frontend + one third-party app like a gamefi client) each registering their own session keys on the same wallet. Each frontend has authority over every profile, including profiles that belong to *the other* frontend's use case. No isolation.
- **External app delegation.** A gamefi app or AI agent wants control over one specific profile, not the user's whole wallet. Today there's no way to grant that.

The wallet-scoped path is still right for the simple case ("one user, one wallet, one frontend, enable Quick Sign across all my profiles"). We're not removing it — we're adding a *parallel* token-scoped path. Both coexist; token-scoped wins on lookup when both exist.

## What stays unchanged

To make sure nothing important breaks:

- `sessions[wallet][sessionKey]` mapping, `sessionNonce[wallet]`, `ownerSessionEpoch[wallet]`, `consumedSessionMessage[digest]` — unchanged.
- `registerSession`, `registerSessionPersonal`, `revokeSession`, `registerSessionFromL1` — unchanged.
- `validSession(owner, sessionKey)` view — unchanged. Used by L2 bridge code and any external caller that asks specifically about wallet-scoped sessions.
- The expired-session invariant in `CawActions._verifySignatureMem` (line 1343) — preserved. We do not let an expired session of *either* flavor fall through to ERC-1271.
- `ownerSessionEpoch` bump on transfer — unchanged. Wallet-scoped sessions correctly belong to the wallet and follow it through ownership changes.
- ERC-1271 cold-path fallback — unchanged. The new code only adds the token-scoped lookup; it doesn't alter the contract-owned-profile path.

## What's added

### Storage in `CawProfileL2`

```solidity
struct StoredSession {
  uint64  expiry;
  uint8   scopeBitmap;
  uint256 spendLimit;
  uint64  perActionTipRate;
  uint32  epoch;  // for wallet-scoped: ownerSessionEpoch[owner] at registration.
                  // for token-scoped:  unused (always 0). transfer hook deletes the
                  //                    record entirely, so an epoch field would be
                  //                    redundant.
}

/// @notice tokenId => sessionKey => stored session data.
///         Distinct from `sessions[owner][sessionKey]`. Token-scoped sessions
///         are cleared on transfer; they do NOT survive ownership changes.
mapping(uint32 => mapping(address => StoredSession)) public tokenSessions;

/// @notice Per-tokenId nonce for token-session delegation signatures (prevents
///         replay after revocation). Independent of the wallet-scoped
///         `sessionNonce[wallet]` counter so they can't interfere.
mapping(uint32 => uint256) public tokenSessionNonce;

/// @notice Active token-scoped session keys per tokenId, for transfer-time
///         clear iteration. EnumerableSet so we can list/delete on transfer.
mapping(uint32 => EnumerableSet.AddressSet) private _activeTokenSessionKeys;

/// @notice Set of consumed personal_sign digests for token-session registration.
///         Separate namespace from `consumedSessionMessage` (which is for
///         wallet-scoped). A given digest can only be consumed by the
///         registration path that produced it.
mapping(bytes32 => bool) public consumedTokenSessionMessage;

/// @notice Cumulative CAW spent by a token-scoped session key. Separate from
///         the wallet-scoped `sessionSpent[owner][sessionKey]` counter so a
///         per-token budget doesn't eat the per-wallet budget (or vice versa).
mapping(uint32 => mapping(address => uint256)) public tokenSessionSpent;
```

### New EIP-712 typehash

```solidity
bytes32 private constant TOKEN_DELEGATION_TYPEHASH = keccak256(
  "TokenSessionDelegation(uint32 tokenId,address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)"
);
```

Note the leading `uint32 tokenId` — that's what distinguishes a token-scoped delegation from a wallet-scoped one cryptographically, so a sig from one path can't be replayed against the other.

### New entry points

```solidity
function registerTokenSession(
  uint32 tokenId,
  address sessionKey,
  uint64 expiry,
  uint8 scopeBitmap,
  uint256 spendLimit,
  uint64 perActionTipRate,
  uint256 nonce,
  uint8 v, bytes32 r, bytes32 s
) external;

function registerTokenSessionPersonal(
  uint32 tokenId,
  bytes memory message,
  uint8 v, bytes32 r, bytes32 s
) external;

function revokeTokenSession(uint32 tokenId, address sessionKey) external;  // gated by ownerOf
function revokeTokenSessionBySig(uint32 tokenId, address sessionKey, uint256 nonce, uint8 v, bytes32 r, bytes32 s) external;
```

Behaviour notes:

- `registerTokenSession`: recovers signer via ecrecover, requires `signer == ownerOf[tokenId]`. Pushes to `_activeTokenSessionKeys[tokenId]`. Bumps `tokenSessionNonce[tokenId]`.
- `registerTokenSessionPersonal`: parses the personal-sign message (new line format that includes `Profile: alice` or the tokenId), recovers signer, requires `signer == ownerOf[tokenId]`. Digest goes into `consumedTokenSessionMessage`.
- WITHDRAW (`scopeBitmap & 0x40`) stays rejected on both registration paths.
- Both registration paths emit a new event `TokenSessionCreated(tokenId, owner, sessionKey, ...)`.

### New view: `sessionFor`

```solidity
/// @notice Returns the effective session record for (tokenId, signer).
///         Token-scoped wins when both exist; falls through to wallet-scoped
///         (via the existing `validSession` semantics) when token-scoped is
///         empty. Returns a zeroed struct when neither exists or the
///         resolved session is invalid (expired-epoch for wallet-scoped).
function sessionFor(uint32 tokenId, address signer) external view returns (StoredSession memory s);
```

Logic:

```
s = tokenSessions[tokenId][signer];
if (s.expiry != 0) return s;  // token-scoped exists (any expiry — caller checks)

address owner = ownerOf[tokenId];
s = sessions[owner][signer];
if (s.epoch != ownerSessionEpoch[owner]) return StoredSession(0,0,0,0,0);
return s;
```

Subtlety: a token-scoped session with `expiry < block.timestamp` is still "found" (`s.expiry != 0`), so we return it as-is and the caller (`CawActions`) handles the expired branch. This matches the existing pattern — `validSession` returns the wallet-scoped record even if it's expired, and the caller's expired-session invariant (line 1343) determines whether to revert or fall through to ERC-1271. **Critical: we must preserve that invariant for token-scoped sessions too.** An expired token-scoped session must **not** fall through to ERC-1271 silently elevating the signer to owner authority.

### Transfer hook

In `_setOwnerOf` (CawProfileL2.sol:527), after the existing epoch bump for the old owner:

```solidity
function _setOwnerOf(uint32 tokenId, address newOwner, uint64 stamp) internal {
  if (stamp < lastOwnerUpdateBlock[tokenId]) return;
  lastOwnerUpdateBlock[tokenId] = stamp;
  address prev = ownerOf[tokenId];
  if (prev != newOwner && prev != address(0)) {
    unchecked { ownerSessionEpoch[prev]++; }
    _clearTokenSessions(tokenId);  // NEW
  }
  emit OwnerSet(tokenId, newOwner);
  ownerOf[tokenId] = newOwner;
}

function _clearTokenSessions(uint32 tokenId) internal {
  EnumerableSet.AddressSet storage keys = _activeTokenSessionKeys[tokenId];
  uint256 n = keys.length();
  for (uint256 i = n; i > 0; --i) {
    address k = keys.at(i - 1);
    delete tokenSessions[tokenId][k];
    // tokenSessionSpent[tokenId][k] intentionally NOT cleared — a fresh registration
    // gets a fresh tracker via the nonce bump, so stale counters are harmless. Clearing
    // them would be an unbounded SSTORE per transfer, which is a gas footgun.
    keys.remove(k);
  }
  tokenSessionNonce[tokenId]++;  // invalidate any held delegation sigs for this token
}
```

**Gas concern:** clearing N session keys on transfer is O(N). To bound this, we should enforce a cap (e.g., `MAX_TOKEN_SESSIONS = 16`) in `registerTokenSession` — refuse to register if the active-keys set is already at the cap. 16 is more than any realistic UX would produce and bounds the transfer-time gas hit. Existing wallet-scoped registration has no such cap because it doesn't need transfer-time iteration.

### CawActions changes

Two callsites in `CawActions.sol`:

- `_verifySignatureMem` at line 1332: `CawProfileL2.StoredSession memory sess = cawProfile.validSession(owner, signer);` → `cawProfile.sessionFor(data.senderId, signer);`
- `_verifyBatchSignature` at line 1395: `uint64 expiry = cawProfile.validSession(owner, signer).expiry;` → `cawProfile.sessionFor(senderId, signer).expiry;` (and consider returning the full struct if `_verifyBatchSignature` needs more than expiry — check current code).

The rest of the verification logic is unchanged. The expired-session-fallthrough invariant works identically — `sessionFor` returns the (token-scoped or wallet-scoped) session record, and the existing `if (sess.expiry != 0) revert("Session expired")` guard catches both flavors.

### Spend limit accounting

Wherever `CawActions._applyAction` increments `sessionSpent[owner][signer]`, we need to know which flavor matched and increment the right counter:

- **Token-scoped match**: increment `tokenSessionSpent[senderId][signer]`, check against `sess.spendLimit`.
- **Wallet-scoped match**: increment `sessionSpent[owner][signer]` (existing behaviour).

`sessionFor` returns the struct but not the flavor. Options:

- A. Add a flag to the return: `(StoredSession memory s, bool isTokenScoped)`. Simple, explicit, one extra return slot.
- B. Have `CawActions` call `tokenSessions[tokenId][signer]` and `sessions[owner][signer]` separately. Two SLOADs instead of one — slower hot path.
- C. Pack the flag into an unused bit of `StoredSession`. Saves a slot but is fragile.

**Pick A.** Adds one bool to the return, no storage impact, makes the caller's branching explicit.

### Events

Mirror the wallet-scoped events:

```solidity
event TokenSessionCreated(uint32 indexed tokenId, address indexed owner, address indexed sessionKey, uint64 expiry, uint8 scopeBitmap, uint256 spendLimit, uint64 perActionTipRate);
event TokenSessionRevoked(uint32 indexed tokenId, address indexed sessionKey);
event TokenSessionsClearedOnTransfer(uint32 indexed tokenId, uint256 count);
```

The `TokenSessionsClearedOnTransfer` event is for indexers that track active sessions — they need to know to drop their cached list.

## Test plan

In `solidity/test/`:

1. **Registration happy path**: token owner signs `TokenSessionDelegation`, anyone submits, record is stored.
2. **Replay protection**: same sig submitted twice rejected via `tokenSessionNonce` mismatch (EIP-712 path) and `consumedTokenSessionMessage` (personal_sign path).
3. **Non-owner registration rejected**: someone else signs a `TokenSessionDelegation` for a tokenId they don't own — must revert.
4. **WITHDRAW scope rejected**: register with `scopeBitmap & 0x40 != 0` — must revert.
5. **Active-keys cap**: register `MAX_TOKEN_SESSIONS` keys, next registration reverts.
6. **Token wins over wallet**: register a wallet-scoped session AND a token-scoped session for the same (wallet, tokenId, sessionKey). Submit an action; `sessionFor` must return the token-scoped record. Spend increment must hit `tokenSessionSpent`, not `sessionSpent`.
7. **Wallet fallback when token absent**: only a wallet-scoped session exists; action succeeds via fallback.
8. **Transfer clears token-scoped**: register a token-scoped session, transfer the token, attempt to use the session — must fail.
9. **Transfer does NOT clear wallet-scoped, but epoch bump invalidates them**: wallet-scoped session registered for wallet W, profile X transfers out, wallet W's epoch bumps, the wallet-scoped session is stale-epoch and `validSession` zeroes it. (Existing behaviour — confirm it still works after `sessionFor` changes.)
10. **Expired token session doesn't fall through to ERC-1271**: register, expire (warp time), submit action signed by sessionKey, must revert with "Session expired" not "Invalid signature." Critical audit invariant.
11. **Spend limit per-token independent of per-wallet**: register a token-scoped session with spendLimit=100, register a wallet-scoped session with spendLimit=1000. Spend 50 via token-scoped — `tokenSessionSpent` is 50, `sessionSpent` is 0, both limits respected.
12. **Multiple tokens, one wallet, separate budgets**: wallet owns A and B, register token-scoped session for A only. Action signed for A succeeds; action signed for B falls through to wallet-scoped (or fails if no wallet session exists).
13. **L1-bridged sessions**: `registerSessionFromL1` (wallet-scoped) still works — no regression. (We don't add an L1-bridged variant of token-scoped sessions in v1 — defer until there's a use case.)
14. **Stale tokenSessionSpent doesn't double-charge**: register token-session, spend 50, revoke, re-register with same sessionKey, spend 30. `tokenSessionSpent[tokenId][sessionKey]` is now 30 vs the new limit, not 80. (Verifies the "fresh registration → fresh tracker" property. If we keep the existing counter across re-registrations, the test fails and the design needs revisiting — clear on registration if so.)

## What we explicitly defer

- **`registerTokenSessionFromL1`**: bridging token-scoped sessions from L1. Not needed for any v1 flow. The use cases (gamefi, agents, multi-frontend) all register on L2 directly. Add later if a real need emerges.
- **Owner-side bulk operations**: "revoke all token-scoped sessions on tokenId X" via a single call. Useful for power users but the EnumerableSet iteration is what enables it cheaply — defer the entry point, keep the data structure.
- **Per-action selector scoping** (beyond the existing scope bitmap). E.g., "this session can only post to thread T." Real use cases exist but not v1.

## Implementation order

The task list mirrors this:

1. Storage additions only (no entry points). Compile, no test impact.
2. Registration entry points + EIP-712 typehash + personal_sign parser. Test #1, #2, #3, #4, #5.
3. `sessionFor` view helper. Test #6, #7.
4. Transfer hook. Test #8.
5. `CawActions` lookup swap. Test #6 again (end-to-end), #7, #10.
6. Spend-limit accounting per flavor. Test #11, #12, #14.
7. Events finalized, audit pass against the invariants list above.