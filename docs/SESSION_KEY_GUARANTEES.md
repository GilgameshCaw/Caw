# Session-Key Guarantees

Closes **C41** / `PROOF_OF_COMPLIANCE_BACKLOG.md` item 8.

A session key is a delegated signer registered against a profile owner. This
document is the citable evidence bundle for the five bounds a session key
**cannot** cross:

1. delegate `withdraw`
2. spend over `spendLimit`
3. survive expiry
4. survive transfer
5. replay

Each bound below cites a **specific test file and assertion line**, plus the
**contract line that enforces it**. Line numbers are pinned to the commit noted
at the bottom; re-pin them when the referenced files change.

---

## Running these

```bash
cd solidity
npm install --legacy-peer-deps
forge install foundry-rs/forge-std      # not vendored — see "Prerequisites"
forge test --match-path 'test-foundry/Session*.t.sol'
```

Expected: **25 passed, 0 failed.**

### Prerequisites

- `forge-std` is not vendored and there is no `.gitmodules`, so `forge test`
  fails at parse on a fresh clone until `forge install foundry-rs/forge-std` is
  run.
- `npm install` requires `--legacy-peer-deps` (LayerZero peer conflict).

### Truffle counterparts

`test/*.js` is a **Truffle** suite (not Hardhat). Several files contain
session-bound assertions covering the same ground — `token-scoped-sessions-test.js`,
`session-tip-batched-test.js`, `session-personal-replay-test.js`. They are
currently **not runnable**: `CawProfileLedger.new()` fails with `contains
unresolved libraries: SessionMessageParser` even when the linker helper runs
first. See `test/helpers/link-libraries.js` (task **#195**).

Foundry links `SessionMessageParser` from artifact metadata and is unaffected.
**Every bound below is therefore cited against `test-foundry/`** — that is the
runner these guarantees are provable on today. The Truffle tests remain valuable
(they exercise the real L1→LayerZero→L2 transfer path, which the Foundry tests
deliberately shortcut) and should be re-cited here once #195 is resolved.

---

## 1. The five bounds

### ① A session key cannot delegate `withdraw`

`withdraw` is `ActionType.WITHDRAW` = 6 (`CawActions.sol:83`), i.e. bit 6
(`0x40`) of `scopeBitmap`. **No registration path can set it.** Enforcement
depends on whether the path accepts a caller-supplied bitmap — see §2.

| Enforcement | Contract | Test | Assertion |
|---|---|---|---|
| **revert** (wallet-scoped) | `CawProfileLedger.sol:741` — `if ((scopeBitmap & 0x40) != 0) revert NoWithdraw();` | `test-foundry/SessionRegisterFuzz.t.sol` — `testFuzz_WithdrawDelegationBlocked` (L200) | **L213** `vm.expectRevert(abi.encodeWithSelector(CawProfileLedger.NoWithdraw.selector));` |
| **mask** (token-scoped) | `CawProfileLedger.sol:824` — `uint8 bm = scopeBitmap & 0xBF;` | `test/token-scoped-sessions-test.js` — test 9 (L554) — *blocked by #195* | **L563** `expect(Number(sess.scopeBitmap)).to.equal(0xBF, ...)` |

The fuzz test sets bit 6 **plus arbitrary other bits**
(`uint8 scope = 0x40 | (extraBits & 0xBF)`, L206) across the full fuzz domain, so
the guarantee is not tied to one bitmap value. 1000 runs.

> **Integrator note.** The two paths differ. Registering `0xFF` on a
> **wallet-scoped** session **reverts** `NoWithdraw()`; registering `0xFF` on a
> **token-scoped** session **succeeds silently** and stores `0xBF`. Both are safe
> — withdraw is never delegated — but the API surface is not symmetric.

---

### ② A session key cannot spend over `spendLimit`

Enforcement: `CawActions.sol:1386` — `if (ba.groupSpent > ba.spendLimit) revert SessionLimitExceeded();`
(single throw site). Spend is accumulated in `BatchAuth.groupSpent` across a
signature group and flushed to `sessionSpent[owner][signer]` at group end
(`:584`, `:766`, `:922`, `:1199`), then re-loaded on the next call (`:1382`).

| Property | Test | Assertion |
|---|---|---|
| Exceeding the limit reverts with the named custom error | `test-foundry/SessionProfileScoping.t.sol` — `test_sessionSpendLimit_cumulative` | `vm.expectRevert(CawActions.SessionLimitExceeded.selector)` |
| Accounting is exact, and the limit is **cumulative** across transactions | same test | `assertEq(actions.sessionSpent(owner, sessionKey), 5000)` before and after the reverted attempt |
| `spendLimit == 0` means **unlimited** | `test-foundry/SessionProfileScoping.t.sol` — `test_sessionSpendLimit_zeroMeansUnlimited` | 15000 spent successfully; `assertEq(sessionSpent, 0)` |

`test_sessionSpendLimit_cumulative` sets `spendLimit = 7000` against a CAW action
costing 5000 whole CAW (`CawActions.sol:1313`, cap oracle dormant), then submits
**two separate `processActions` calls**. The first succeeds and records exactly
5000; the second crosses the bound (10000 > 7000) and reverts; `sessionSpent`
remains 5000. This proves the accumulator and its storage round trip, not a
per-call bound.

> **Integrator note.** `spendLimit == 0` is **unlimited**, not zero-spend —
> documented at `CawProfileLedger.sol:726` and gated at `CawActions.sol:1380`
> (`if (ba.spendLimit > 0)`). It reads like the opposite of what it does.

---

### ③ A session key cannot survive expiry

Checked on two sides:

| Side | Contract | Test | Assertion |
|---|---|---|---|
| **Register-time** | `CawProfileLedger.sol` `Expired()` (also `:800`, `:894` on trusted-caller paths) | `test-foundry/SessionRegisterFuzz.t.sol` — `testFuzz_RejectsExpired` (L84) | **L96** `vm.expectRevert(abi.encodeWithSelector(CawProfileLedger.Expired.selector));` |
| **Use-time** | `CawActions.sol:569` — `if (s.expiry <= block.timestamp) revert SessionExpired();` | `test-foundry/SessionProfileScoping.t.sol` (L438) | **L483** `vm.expectRevert(CawActions.SessionExpired.selector);` |

Expiry is the gate at every signature-recovery entry point — a session only
authorizes an action if it is live at recovery time:

| Entry point | Gate |
|---|---|
| `CawActions._verifySignatureMem:1555` | **:1568** `if (sess.expiry > block.timestamp)` — only a live session returns `isSessionKey = true` |
| `CawActions._verifyBatchSignature:1610` | **:1630-1631** same shape |
| `CawActions._zkProcessOneGroup:519` | **:569** — the ZK path skips ECDSA recovery, so it re-derives the gate |

`:1578` / `:1636` additionally distinguish *"expired session record exists"*
(revert) from *"no record"* (fall through to ERC-1271). Without that, a
contract-owned profile whose signer is both Safe-validated **and** holds an
expired session record would have the 1271 fallback silently elevate the expired
session to full owner authority. Audit fix M-1, 2026-05-08.

---

### ④ A session key cannot survive transfer

Sessions are keyed on the **owner address** and carry the epoch they were
registered at (`StoredSession.epoch`, `CawProfileLedger.sol:127`). On owner
change, `_setOwnerOf` (`:676`) bumps **both** epochs (`:691-692`):

- `ownerSessionEpoch[prev]++` — invalidates **every** wallet-scoped session of
  the previous wallet, including for tokens it still owns
- `tokenSessionEpoch[tokenId]++` — invalidates token-scoped sessions bound to
  that profileId

`validSession` (`:175-183`) then returns a zeroed struct on epoch mismatch. This
is the **CL-4** invariant; the rationale (`:682-687`) is the intermediate-holder
drain from `project_l1l2_ownership_desync` — an unordered LayerZero redelivery
could re-stamp `ownerOf` back to a previous holder and reanimate sessions they
registered during brief ownership.

| Property | Test | Assertion |
|---|---|---|
| Transfer invalidates the token's token-scoped session | `test-foundry/SessionProfileScoping.t.sol` — `test_transfer_invalidatesTokenScopedSession` | `assertEq(ledger.validSession(owner, sessionKey2).expiry, 0)`; positive control asserts live **and** bound to TOKEN_A first |
| **CL-4**: transfer invalidates the transferring wallet's wallet-scoped sessions, including for tokens still owned | `test-foundry/SessionProfileScoping.t.sol` — `test_transfer_invalidatesWalletScopedSession_CL4` | `assertEq(ledger.validSession(owner, sessionKey).expiry, 0)`, then end-to-end `vm.expectRevert(CawActions.SessionExpired.selector)` on an action for a **still-owned** token |

The CL-4 test submits a **successful** action for TOKEN_B before transferring
TOKEN_A, so the "dead after" assertion is anchored against a demonstrated "live
before".

> A strictly newer stamp is required to trigger the bump — `_setOwnerOf:677`
> silently skips stale or same-stamp deliveries (`if (stamp <= lastOwnerUpdateBlock[tokenId]) return;`).

---

### ⑤ A session key cannot replay

Three surfaces, three defences:

| Surface | Contract | Test | Assertion |
|---|---|---|---|
| **EIP-712 register-by-sig** — nonce | `CawProfileLedger` `BadNonce()` | `test-foundry/SessionRegisterFuzz.t.sol` — `testFuzz_NonceReplayBlocked` (L133) | **L152** `vm.expectRevert(abi.encodeWithSelector(CawProfileLedger.BadNonce.selector));` (1000 runs) |
| **Revoke → held pre-signed register** | revoke bumps `sessionNonce` | `test-foundry/SessionRegisterFuzz.t.sol` — `test_SES1_revoke_invalidates_presigned_register` (L106) | **L125** `vm.expectRevert(abi.encodeWithSelector(CawProfileLedger.BadNonce.selector));` |
| **personal_sign register** — no nonce in the message, so the **digest** is consumed | `CawProfileLedger.sol:794-795` — `if (consumedSessionMessage[digest]) revert Replayed(); consumedSessionMessage[digest] = true;` (audit fix 2026-05-08) | `test/session-personal-replay-test.js` (L75) — *blocked by #195* | **L105** `expect(reason).to.match(/replay|replayed|0xf6c62c02/);` + state assertion **L109** |

`0xf6c62c02` = `bytes4(keccak256("Replayed()"))`.

---

## 2. Adjacent: scope is not escalatable

Not required by item 8, but it is why ① holds across **six** registration paths.
Two accept a caller-supplied `scopeBitmap`; four do not offer one and hard-code
`0xBF` (all bits except withdraw).

| Path | file:line | Accepts `scopeBitmap`? | Withdraw handling |
|---|---|---|---|
| `registerSession` (EIP-712) | `CawProfileLedger.sol:725` | **yes** | `:741` revert `NoWithdraw()` |
| `registerTokenScopedSession` | `CawProfileLedger.sol:807` | **yes** | `:824` mask `& 0xBF` |
| `lzDepositMintSession` | `CawProfileLedger.sol:424` | no | `:457` hard-coded `0xBF` |
| `registerSessionFromL1` | `CawProfileLedger.sol:619` | no | `:626` hard-coded `0xBF` |
| `registerSessionPersonal` | `CawProfileLedger.sol:777` | no — the parser returns `spendLimit, perActionTipRate, expiry, sessionKey` only (`:797`) | `:803` hard-coded `0xBF` |
| `registerSessionFromActions` | `CawProfileLedger.sol:882` | no | `:895` hard-coded `0xBF` |

**No path drops a caller-supplied bitmap on the floor.** The four hard-coded
paths do not expose a scope parameter, so `0xBF` is the documented contract, not
a silently ignored argument.

Per-action scope enforcement: `CawActions.sol:642` and `:912` —
`if ((ba.scopeBitmap & (1 << uint8(action.actionType))) == 0) revert OutOfScope();`

Profile scoping (a token-scoped key cannot sign for another profile):
`CawActions.sol:570` — `if (s.profileId != 0 && s.profileId != senderId0) revert WrongProfileForSession();`
Tested at `test-foundry/SessionProfileScoping.t.sol:412`
`vm.expectRevert(CawActions.WrongProfileForSession.selector);`

Cross-owner impersonation is covered at `test-foundry/SessionProfileScoping.t.sol:438`,
with a positive control (L461-468). Note the attack reverts at the **expiry**
guard (`:569`), not the profile guard: an unregistered foreign key resolves to an
empty `StoredSession` with `expiry == 0`, and `:569` fires before `:570`. The
guarantee holds; the asserted selector is coupled to guard ordering inside
`CawActions`. The test documents this in-line.

---

## 3. Known assertion weaknesses

Four session-scope assertions in the Truffle suite are catch-alls of the form
`A || B || revertReason.includes('revert')`. The trailing term matches any
revert message, so they would pass on the wrong revert as readily as the right
one. Each one's first term is also dead — `'Out of scope'` and `'Session limit'`
do not appear anywhere in `contracts/` (they predate custom errors).

| file:line | Correct error | Dead condition |
|---|---|---|
| `test/batched-actions-test.js:608` | `OutOfScope()` | `includes('Out of scope')` |
| `test/batched-actions-test.js:674` | `SessionLimitExceeded()` | `includes('Session limit')` |
| `test/session-tip-batched-test.js:740` | `SessionLimitExceeded()` | `includes('session limit')` |
| `test/zk-actions-test.js:710` | `SessionExpired()` | `includes('session invalid')` |

**These do not weaken the guarantees** — every bound in §1 is independently
covered by a strict, selector-or-exact-value assertion on `test-foundry/`. They
are recorded here so the bundle's citations are not overstated. All four are in
files blocked by #195 and cannot currently run at all.

Note that `CawActions.sol:1635` reverts with the legacy string `"Session expired"`
while its counterpart at `:1578` reverts with `SessionExpired()`. Tightening
`zk-actions-test.js:710` requires reconciling that first.

---

## 4. Coverage summary

| Bound | Executable assertions | Runner |
|---|---|---|
| ① withdraw non-delegable | 1 | foundry (1000 fuzz runs) |
| ② spendLimit | 2 | foundry |
| ③ expiry | 2 | foundry (1000 fuzz runs) |
| ④ transfer | 2 | foundry |
| ⑤ replay | 2 | foundry (1000 fuzz runs) |

**5/5 bounds hold, each on at least one executing strict assertion.**
`forge test --match-path 'test-foundry/Session*.t.sol'` → 25 passed, 0 failed.

---

*Verified against `5ac4f02` plus the tests introduced alongside this document.
Re-pin line numbers when the referenced files change.*
