# Card-Funded Profiles — Fiat Onramp Architecture

## Overview

CAW supports two ways to get a profile:

1. **Self-funded (Population A)**: user has a wallet, has ETH/CAW,
   calls `mintAndDeposit` directly. **No lock, no KYC, no gate. Ever.**
   The protocol has zero regulatory exposure from these users.

2. **Sponsor-funded via fiat (card profiles)**: user pays with a card
   (Stripe), a sponsor server mints the profile on their behalf. The
   sponsor server — the entity that accepted fiat — decides at mint
   time whether the profile needs KYC before withdrawing.

**The protocol doesn't mandate KYC.** It provides optional
infrastructure that the fiat-accepting entity can activate if they
face regulatory pressure. Crypto-native users never see it.

---

## Who decides what

```
Population A (self-funded):
  User → mintAndDeposit(...)
  No lock. No KYC. No time-lock. Permissionless forever.

Population B / Card (sponsor-funded via fiat):
  Stripe → Sponsor Server → mintAndDepositLocked(..., kycLevel)
  kycLevel decided by the SPONSOR SERVER at call time.
  Default: 0 (time-lock only, no KYC).
  Can be flipped to 2 or 3 if the server operator faces regulatory pressure.
```

| Decision | Who decides | When |
|---|---|---|
| Whether to accept fiat | Sponsor server operator | Server config |
| Whether card profiles need KYC at withdraw | Sponsor server operator | At mint time (kycLevel parameter) |
| KYC level (0/1/2/3) | Sponsor server operator | At mint time |
| What KYC provider to use | Protocol deployer | CawProfile.kycVerifiers mapping (set once, pre-renouncement) |
| Whether a self-funded profile is locked | Nobody — it's not | N/A |

**The Minter contract is a stateless relay.** It doesn't store policy,
doesn't have an admin, doesn't make decisions. It forwards the
caller's parameters to CawProfile.

---

## The kycLevel parameter

Passed at mint time by the caller of `mintAndDepositLocked`:

| Level | Name | What it checks | When to use |
|---|---|---|---|
| 0 | None | Time-lock only (180 days) then auto-unlock | Default for card profiles. No KYC ever. |
| 1 | CAPTCHA | Bot resistance (Civic network 1) | Sybil defense only |
| 2 | Uniqueness | Liveness check, no document (Civic network 10) | Moderate defense, no PII collected |
| 3 | ID Document | Passport/ID scan + selfie (Civic network 17) | Full KYC for jurisdictions that require it |

Level 0 means: withdraw is locked for 180 days, then unlocks
automatically. No verification, no identity, no friction. The
time-lock is enough to make the stored-value argument ("this isn't
a fiat-to-crypto bridge — value lives on-platform for months").

Levels 1-3 are **dormant by default.** They exist in the contract
so a sponsor server operator can flip them on without a protocol
redeploy if a regulator demands it. The community never sees them
unless regulatory force-majeure requires it.

---

## Contract design

### CawProfile (L1)

```solidity
// Per-tokenId withdraw gate. 0 = no lock (self-funded profiles).
// Non-zero = the kycLevel set at mint time by the Minter.
mapping(uint32 => uint8) public withdrawKycLevel;

// Per-level verifier addresses. Set by contract owner pre-renouncement.
// Level 0 has no verifier (time-lock only).
mapping(uint8 => address) public kycVerifiers;

// Time-lock: card profiles with kycLevel=0 auto-unlock after this
// many seconds from mint time.
uint256 public constant WITHDRAW_TIMELOCK = 180 days;

// Mint timestamp per tokenId (for time-lock calculation).
mapping(uint32 => uint256) public mintedAt;

// Withdraw gate (in withdrawTo, before fee logic):
function _checkWithdrawLock(uint32 tokenId) internal view {
    uint8 level = withdrawKycLevel[tokenId];
    if (level == 0) {
        // Self-funded profiles have level=0 AND mintedAt=0 (never set).
        // Card profiles have level=0 AND mintedAt>0 (set by Minter).
        if (mintedAt[tokenId] == 0) return; // self-funded, no gate
        if (block.timestamp >= mintedAt[tokenId] + WITHDRAW_TIMELOCK) return; // time-lock expired
        revert WithdrawTimelocked();
    }
    // Level 1-3: check the KYC verifier
    address verifier = kycVerifiers[level];
    if (verifier == address(0)) revert KycNotConfigured();
    if (!IKycVerifier(verifier).isVerified(msg.sender)) revert KycRequired();
}

// Called by Minter at mint time:
function setWithdrawKycLevel(uint32 tokenId, uint8 level) external {
    if (msg.sender != minter) revert NotMinter();
    withdrawKycLevel[tokenId] = level;
    mintedAt[tokenId] = block.timestamp;
}

// Owner can skip the time-lock by verifying early (if KYC is configured
// for level 0, which it isn't by default — this is a no-op today):
function unlockWithdraw(uint32 tokenId) external {
    if (ownerOf(tokenId) != msg.sender) revert NotOwner();
    uint8 level = withdrawKycLevel[tokenId];
    if (level == 0 && mintedAt[tokenId] == 0) revert AlreadyUnlocked();
    if (level == 0) {
        // Time-locked profile — check if time expired
        if (block.timestamp >= mintedAt[tokenId] + WITHDRAW_TIMELOCK) {
            withdrawKycLevel[tokenId] = 0;
            mintedAt[tokenId] = 0;
            return;
        }
        revert WithdrawTimelocked();
    }
    // Level 1-3: check KYC verifier
    address verifier = kycVerifiers[level];
    if (verifier == address(0)) revert KycNotConfigured();
    if (!IKycVerifier(verifier).isVerified(msg.sender)) revert KycRequired();
    withdrawKycLevel[tokenId] = 0;
    mintedAt[tokenId] = 0;
    emit WithdrawUnlocked(tokenId);
}

// Set by contract owner before renouncement:
function setKycVerifier(uint8 level, address verifier) external onlyOwner {
    kycVerifiers[level] = verifier;
}
```

### CawProfileMinter

No admin. No policy state. Just relays:

```solidity
function mintAndDepositLocked(
    uint32 networkId,
    address recipient,
    string memory username,
    uint256 depositAmount,
    uint32 lzDestId,
    uint256 lzTokenAmount,
    uint8 kycLevel  // caller decides: 0=time-lock, 1=captcha, 2=uniqueness, 3=id-doc
) external payable {
    // ... normal mint + deposit logic ...
    cawProfile.setWithdrawKycLevel(newId, kycLevel);
}
```

The regular `mintAndDeposit` (called by self-funding users) does
NOT call `setWithdrawKycLevel`. Those profiles have `withdrawKycLevel
= 0` and `mintedAt = 0` — which means no lock at all.

---

## Flow: self-funded user (Population A)

```
User has wallet + ETH/CAW
  → calls mintAndDeposit(...) on CawProfileMinter
  → profile created with withdrawKycLevel = 0, mintedAt = 0
  → withdraw is fully permissionless from second zero
  → no KYC. ever. the protocol doesn't know or care who they are.
```

## Flow: card-funded user (default — kycLevel = 0, time-lock only)

```
User clicks "Buy a profile — $25"
  → Stripe Checkout
  → webhook fires on sponsor server
  → server calls mintAndDepositLocked(..., kycLevel = 0)
  → profile created with withdrawKycLevel = 0, mintedAt = block.timestamp
  → user can post, like, follow, earn yield immediately
  → withdraw is locked for 180 days (time-lock)
  → after 180 days: withdraw auto-unlocks. no KYC needed.
  → user never scanned an ID, never proved who they are
```

## Flow: card-funded user (if regulator demands KYC — kycLevel = 3)

```
Sponsor server operator flips CARD_KYC_LEVEL=3 in server config
  → webhook calls mintAndDepositLocked(..., kycLevel = 3)
  → profile created with withdrawKycLevel = 3, mintedAt = block.timestamp
  → user can post, like, follow, earn yield immediately
  → withdraw requires Civic Pass ID-document verification
  → user clicks "Unlock withdrawals" → scans passport → unlocks
  → existing profiles minted at kycLevel=0 are NOT affected
```

---

## Transfer semantics

- Lock travels with the tokenId, not the wallet.
- Self-funded profiles: no lock, transfers are clean.
- Card profiles: lock transfers with the NFT. New owner inherits
  the time-lock (or KYC requirement). Same rules apply.
- A buyer on the marketplace who buys a locked profile knows
  what they're getting (the lock state is readable on-chain).

---

## Do we need Moonpay?

**No.** With the Stripe path, Moonpay is redundant for the primary
use case (fiat onboarding). Here's why:

| | Stripe (card profiles) | Moonpay |
|---|---|---|
| What user gets | A withdraw-locked CAW profile | ETH in their wallet |
| KYC at purchase | None | Always (birthday, address, phone) |
| Friction | 2 seconds (standard card checkout) | 2-5 minutes + phone verification |
| Who holds fiat | Partner entity (Stripe merchant) | Moonpay |
| User needs a wallet? | No (server mints for them) | Yes (ETH has to go somewhere) |
| Regulatory burden | Stored-value exemption (digital good) | Moonpay is the MSB |
| Withdrawal | Time-locked 180 days (default) | Permissionless (they have ETH) |

**Moonpay makes sense only for users who specifically want ETH in
their own wallet** — i.e., users who already understand crypto and
want to self-custody from the start. Those users probably already
have a wallet and can use the normal Population A path.

### Recommendation

- **Keep Moonpay code** (it's built, gated behind env vars, costs
  nothing to maintain).
- **Don't promote it.** The "Buy with card" button routes to Stripe,
  not Moonpay.
- **Remove Moonpay from the sign-in modal** (or keep it as a hidden
  option for operators who have Moonpay biz registration).
- **Moonpay becomes a "power user" feature** for operators who want
  to offer direct ETH onramp alongside Stripe. Most operators won't.

---

## What's already built

| Component | Status | Notes |
|---|---|---|
| `withdrawLocked` per-tokenId (CawProfile) | ✅ Built | Needs refactor: replace bool with uint8 kycLevel + add mintedAt |
| `mintAndDepositLocked` (Minter) | ✅ Built | Needs refactor: add kycLevel param, remove admin role |
| `IKycVerifier` interface | ✅ Built | No changes needed |
| `CivicKycVerifier` adapter | ✅ Built | No changes needed |
| Stripe checkout + webhook routes | ✅ Built | Needs: pass kycLevel from server config |
| StripePurchase Prisma model | ✅ Built | No changes needed |
| Moonpay URL-signing route | ✅ Built | Keep as-is, deprioritize |
| FE: CardCheckout page | ✅ Built | No changes needed |
| FE: WithdrawLockStatus component | ✅ Built | Update to show time-lock countdown vs KYC prompt |
| FE: useWithdrawLocked hook | ✅ Built | Update to read kycLevel + mintedAt |
| Free-auth path (CawActions) | ✅ Built | No changes needed |
| broadcastAllowFreeAuth relay | ✅ Built | No changes needed |

## What needs refactoring (next deploy)

| Component | Change |
|---|---|
| CawProfile | Replace `_withdrawLocked` bool with `withdrawKycLevel` uint8 + `mintedAt` uint256. Add time-lock check in `_checkWithdrawLock`. Add `setKycVerifier(level, addr)` owner-only. |
| CawProfileMinter | Remove `admin` role + `kycVerifier` state + `transferAdmin`. Add `kycLevel` param to `mintAndDepositLocked`. Remove `unlockWithdraw` (move to CawProfile). |
| Stripe webhook handler | Read `CARD_KYC_LEVEL` from env (default 0). Pass to `mintAndDepositLocked`. |
| FE WithdrawLockStatus | Read `withdrawKycLevel(tokenId)` + `mintedAt(tokenId)`. Show countdown for level 0, KYC prompt for level 1-3. |
| deploy.js | Update CawProfileMinter constructor (remove admin param). |
| Tests | Update constructor calls (remove admin). Add time-lock tests. |

---

## Env vars (sponsor server config)

| Var | Default | Effect |
|---|---|---|
| `CARD_KYC_LEVEL` | `0` | KYC level passed to `mintAndDepositLocked` for card-funded profiles. 0 = time-lock only. 1-3 = KYC required. |
| `CARD_TIMELOCK_DAYS` | `180` | (FE display only — the contract constant is immutable at 180 days) |
| `STRIPE_SECRET_KEY` | unset | Gates the Stripe checkout routes |
| `STRIPE_WEBHOOK_SECRET` | unset | Stripe signature verification |
| `VITE_STRIPE_PUBLISHABLE_KEY` | unset | FE Stripe checkout |

---

## Summary

The protocol is KYC-neutral. Self-funded users are never locked.
Card-funded users get a time-lock (180 days) by default — no KYC,
no identity, no friction. If a specific sponsor server operator
faces regulatory pressure, they flip `CARD_KYC_LEVEL` in their
server config and future card mints require verification. Existing
profiles are unaffected. The community never sees KYC unless a
fiat-accepting operator is forced to turn it on.
