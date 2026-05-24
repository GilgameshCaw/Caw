# Card-Funded Profiles + Network-Level KYC Policy

## Overview

Users who onboard via card payment (Stripe) receive a profile with
withdrawals disabled. Unlocking withdrawals requires identity
verification. **The Network operator — not the protocol — decides
whether KYC is required and what level**, at Network registration
time. This keeps the protocol neutral while letting operators
comply with their own jurisdiction's rules.

---

## Architecture

```
                      ┌──────────────────┐
                      │  CawNetworkManager │
  Network operator    │                    │
  at registration     │  kycVerifier: addr │ ← per-Network
  time sets:          │  kycRequired: bool │ ← per-Network
                      └────────┬───────────┘
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
        ┌────▼────┐      ┌────▼────┐      ┌─────▼─────┐
        │ Uruk    │      │ Babylon │      │ Community │
        │ KYC: ID │      │ KYC: no │      │ KYC: uniq │
        │ doc     │      │         │      │ (liveness)│
        └─────────┘      └─────────┘      └───────────┘
```

Each Network has:
- `kycVerifier`: address of the `IKycVerifier` adapter contract
  (Civic Pass, zkMe, or address(0) = no KYC)
- `kycRequired`: whether card-funded profiles on THIS Network
  must KYC before withdrawing

When both are set, `CawProfileMinter.unlockWithdraw(networkId,
tokenId)` checks `IKycVerifier(kycVerifier).isVerified(msg.sender)`.
When `kycRequired == false` or `kycVerifier == address(0)`,
withdrawals are not gated (even for card-funded profiles on that
Network).

---

## Who decides what

| Decision | Who | When | Mutable? |
|---|---|---|---|
| Whether KYC is needed on this Network | Network operator | At `createNetwork()` or via `setKycPolicy()` | Yes, by operator only (before fee-lock) |
| Which KYC provider to use | Network operator | `setKycVerifier(networkId, verifierAddr)` | Yes, by operator only |
| KYC level (CAPTCHA / uniqueness / ID doc) | Network operator | Determined by which `IKycVerifier` adapter they deploy | Deploy-time choice |
| Whether a SPECIFIC profile is withdraw-locked | Minter contract | At `mintAndDepositLocked()` time (card path) | No — lock is set once; cleared only by owner + KYC |
| Whether to unlock | Profile owner | `unlockWithdraw(networkId, tokenId)` | One-way: locked → unlocked. Cannot re-lock. |

---

## Contract changes needed

### CawNetworkManager

Add to `CawNetwork` struct:

```solidity
/// KYC policy for card-funded profiles on this Network.
/// address(0) = no KYC required (withdraw is permissionless).
/// Non-zero = IKycVerifier adapter that checks isVerified(owner).
address kycVerifier;
```

Add setter (operator-only, pre-fee-lock):

```solidity
function setKycVerifier(uint32 networkId, address verifier)
    external onlyNetworkOwnerNotFeeLocked(networkId)
{
    networks[networkId].kycVerifier = verifier;
    emit KycVerifierSet(networkId, verifier);
}
```

New event:
```solidity
event KycVerifierSet(uint32 indexed networkId, address indexed verifier);
```

### CawProfileMinter

Change `unlockWithdraw` to accept `networkId` and read the verifier
from the Network:

```solidity
function unlockWithdraw(uint32 networkId, uint32 tokenId) external {
    if (cawProfile.ownerOf(tokenId) != msg.sender) revert NotOwner();
    if (!mintedLocked[tokenId]) revert AlreadyUnlocked();

    // Read the KYC policy from the Network the user is withdrawing on
    address verifier = cawProfile.networkManager().getKycVerifier(networkId);

    // If the Network doesn't require KYC, unlock immediately
    if (verifier == address(0)) {
        // Network has no KYC requirement — operator's choice
        mintedLocked[tokenId] = false;
        cawProfile.setWithdrawLocked(tokenId, false);
        emit WithdrawUnlocked(tokenId);
        return;
    }

    // Network requires KYC — check the verifier
    if (!IKycVerifier(verifier).isVerified(msg.sender)) revert KycRequired();
    mintedLocked[tokenId] = false;
    cawProfile.setWithdrawLocked(tokenId, false);
    emit WithdrawUnlocked(tokenId);
}
```

This means:
- Uruk sets `kycVerifier = CivicKycVerifier(ID_DOC)` → users must
  scan their ID to unlock withdrawals
- Babylon sets `kycVerifier = address(0)` → card-funded profiles
  can unlock immediately (operator chose no KYC)
- A community Network sets `kycVerifier = CivicKycVerifier(UNIQUENESS)`
  → users do a liveness check (no document) to unlock

### CawProfile (L1)

No changes needed. `withdrawLocked` per-tokenId + `setWithdrawLocked`
(minter-only) are already in place from commit `10fbed91`.

The withdraw gate in `withdrawTo` already checks:
```solidity
if (_withdrawLocked[tokenId]) revert WithdrawLocked();
```

### CawActions (L2)

No changes needed. The free-auth path (`allowFreeAuth[networkId]`)
is already wired end-to-end.

---

## KYC verifier adapters

Each KYC level is a separate contract implementing `IKycVerifier`:

```solidity
interface IKycVerifier {
    function isVerified(address account) external view returns (bool);
}
```

### Available adapters

| Adapter | KYC level | What it checks | Registration needed |
|---|---|---|---|
| `CivicKycVerifier` (CAPTCHA network) | Bot resistance | User solved a CAPTCHA on civic.me | None — free, email signup |
| `CivicKycVerifier` (Uniqueness network) | Liveness | User's face is unique (no doc scan) | Civic dev account (email) |
| `CivicKycVerifier` (ID Doc network) | Full KYC | Passport/ID scan + selfie + liveness | Civic dev account + data-processing agreement |
| `ZkMeKycVerifier` (future) | ZK-KYC | Zero-knowledge proof of identity | zkMe integration (similar to Civic) |
| `address(0)` | None | No check — unlock is immediate | Nothing |

The `CivicKycVerifier` contract is already built (`solidity/contracts/
CivicKycVerifier.sol`). It's parameterized by `gatekeeperNetwork` —
different Civic network IDs correspond to different verification
levels. One deploy per level:

```
CivicKycVerifier(civicGateway, 1)   → CAPTCHA
CivicKycVerifier(civicGateway, 10)  → Uniqueness
CivicKycVerifier(civicGateway, 17)  → ID Document
```

A Network operator deploys the adapter for their chosen level, then
calls `setKycVerifier(networkId, adapterAddress)`.

---

## Flow: card-funded user lifecycle

### Onboarding (no KYC)

```
User clicks "Buy a profile — $25"
    → Stripe Checkout (card / Apple Pay / Google Pay)
    → Stripe webhook fires
    → Server calls mintAndDepositLocked(networkId, wallet, username, caw, ...)
    → Profile minted with withdrawLocked = true
    → User can post, like, follow, earn yield immediately
```

### Using the platform (no KYC)

```
User posts, likes, follows, earns yield
    → All actions work normally via CawActions
    → Deposit earns staking rewards
    → Rewards accumulate but are withdraw-locked (same as deposit)
    → User can transfer/sell their profile NFT on the marketplace
```

### Unlocking withdrawals (KYC only if Network requires it)

```
User clicks "Unlock withdrawals" in Settings
    → FE reads networkManager.getKycVerifier(networkId)

    If address(0):
        → unlockWithdraw(networkId, tokenId) succeeds immediately
        → No KYC needed — this Network chose not to require it

    If non-zero:
        → FE shows the Civic Pass widget (or zkMe widget)
        → User completes verification (30s for liveness, 2min for doc)
        → Civic/zkMe issues a Gateway Token (SBT) to user's wallet
        → User calls unlockWithdraw(networkId, tokenId)
        → Contract checks IKycVerifier.isVerified(msg.sender) → true
        → withdrawLocked[tokenId] = false
        → Withdrawals permanently unlocked for this profile
```

### Withdrawing (post-KYC)

```
User calls withdraw(networkId, tokenId, ...)
    → Normal withdraw flow — no additional check beyond the existing
      lockedWithdrawFee + fee logic
    → CAW transferred to user's wallet
    → User sells CAW on Uniswap if they want fiat
```

---

## Transfer semantics

- **Withdraw lock travels with the tokenId**, not the wallet.
- If a locked profile is transferred (sold on marketplace), the
  new owner inherits the lock. They must KYC to unlock.
- This is intentional: the lock represents "this profile's deposit
  was funded with fiat and has never been KYC'd."
- A buyer who wants the staked CAW must verify — same as buying
  CAW from a regulated exchange.

---

## Regulatory analysis

### What we are NOT

- NOT a money transmitter (we don't move fiat; Stripe does)
- NOT a crypto exchange (we don't sell crypto; the user buys platform
  access)
- NOT a KYC provider (Civic/zkMe are; we just check their SBT)

### What we ARE

- A software provider selling digital goods (platform access +
  staking deposit)
- The staking deposit is closed-loop: can't be withdrawn without KYC
- This falls under the **stored-value exemption** (FinCEN):
  - Closed-loop: value usable only within the CAW protocol
  - Single merchant: the CAW protocol
  - Daily load under $2,000 for typical users
- **Risk factor**: CAW is tradeable on Uniswap. A creative regulator
  could argue the NFT's transferability breaks the closed-loop.
  Whether that argument holds is untested. The withdraw-lock
  + KYC-at-withdraw is our defense: even if the NFT transfers, the
  CAW deposit stays locked until someone KYCs.

### Per-Network flexibility

Different Networks in different jurisdictions can set their own
KYC levels:

- **US-focused Network**: ID Document tier (strongest defense against
  regulatory challenge)
- **EU-focused Network**: ID Document tier (MiCA compliance)
- **Crypto-native Network**: No KYC (operator accepts the regulatory
  risk; users who onboarded via crypto never had withdraw-lock anyway)
- **Community Network**: Uniqueness tier (sybil resistance without
  collecting PII)

The protocol doesn't mandate KYC — it provides the plumbing. Each
Network operator makes their own compliance decision.

---

## What's already built

| Component | Status | Commit |
|---|---|---|
| `withdrawLocked` per-tokenId (CawProfile) | ✅ Built | `10fbed91` |
| `mintAndDepositLocked` (CawProfileMinter) | ✅ Built | `10fbed91` |
| `unlockWithdraw` (CawProfileMinter) | ✅ Built | `10fbed91` |
| `IKycVerifier` interface | ✅ Built | `10fbed91` |
| `CivicKycVerifier` adapter | ✅ Built | `755a12d4` |
| `setKycVerifier` on Minter (admin-only) | ✅ Built | `10fbed91` |
| Stripe checkout + webhook routes | ✅ Built | `755a12d4` |
| `StripePurchase` Prisma model | ✅ Built | `755a12d4` |
| Moonpay URL-signing route | ✅ Built | `755a12d4` |
| FE: CardCheckout page | ✅ Built | `a221ce12` |
| FE: WithdrawLockStatus component | ✅ Built | `a221ce12` |
| FE: useWithdrawLocked hook | ✅ Built | `a221ce12` |
| Free-auth path (CawActions + CawProfileL2) | ✅ Built | Pre-existing |
| `broadcastAllowFreeAuth` relay (L1→L2) | ✅ Built | Pre-existing |

## What needs building (next deploy)

| Component | Status | Notes |
|---|---|---|
| `kycVerifier` field on CawNetwork struct | ❌ Not built | Add to CawNetworkManager |
| `setKycVerifier` on NetworkManager | ❌ Not built | Operator-only setter, gated like fee setters |
| `getKycVerifier(networkId)` view | ❌ Not built | Used by Minter's unlockWithdraw |
| `unlockWithdraw` reads Network's verifier | ❌ Not built | Currently reads from Minter's admin-set verifier; needs to read from Network |
| `sponsorCardMint` price-oracle wiring | ❌ Not built | USD → CAW conversion at webhook time |
| FE: Civic Pass widget integration | ❌ Placeholder | Currently shows a toast; real widget when gateway is deployed |
| Deploy CivicKycVerifier to Sepolia | ❌ Not deployed | Need CIVIC_GATEWAY_ADDRESS for the testnet |
| CLI installer: Stripe + KYC prompts | ❌ Not built | Add to onboardingFeatures.js |

---

## Civic Pass integration details

### Registration

- **Sign up**: civic.me — free, email only
- **Create a gatekeeper network**: pick verification level
  - Network 1 = CAPTCHA (bot resistance)
  - Network 10 = Uniqueness (liveness, no doc)
  - Network 17 = ID Document (full KYC)
- **No business entity required** for CAPTCHA or Uniqueness tiers
- **ID Document tier**: agree to Civic's data-processing terms
  (click-through; the Singapore partner entity could be the data
  controller if needed)

### On-chain addresses

Civic's `GatewayTokenVerifier` is deployed on:
- Ethereum mainnet: `0xF65b6396dF6B7e2D8a6270E3AB6c7BB08BAEF22E`
- Sepolia: check civic docs for testnet address
- Base: check civic docs
- Arbitrum: check civic docs

Our `CivicKycVerifier` contract wraps their verifier for the
`IKycVerifier` interface our Minter expects.

### FE SDK

Civic provides `@civic/gateway-react` — a React component that
renders the verification widget. When the user passes, a Gateway
Token (SBT) is issued to their wallet. The component can be dropped
into AccountSettings where the `WithdrawLockStatus` card is.

### Cost

- CAPTCHA: free
- Uniqueness: free up to 1k/month
- ID Document: ~$1-2/verification, first 100 free

At scale (10k+ users/month), negotiate volume pricing with Civic.

---

## Moonpay vs Stripe: the final picture

| | Moonpay | Stripe |
|---|---|---|
| What it is | Crypto onramp (MSB) | Payment processor |
| KYC at purchase | Always (birthday, address, phone) | None (standard card checkout) |
| Who receives fiat | Moonpay | You (or partner entity) |
| Who receives crypto | User's wallet (ETH) | Nobody — your server mints with its own reserves |
| User gets | ETH in their wallet | A withdraw-locked CAW profile |
| Withdrawal | Permissionless (they have their own ETH) | Requires KYC unlock (per Network policy) |
| Business entity needed | Yes (for production) | Yes (for Stripe merchant account) |
| Friction | High (KYC at purchase) | Low (standard card checkout) |
| Best for | Users who want to hold their own crypto | Users who just want to use the platform |

**Both paths coexist.** Stripe is the default card path (lower
friction). Moonpay remains available for operators who have registered
and for users who specifically want ETH in their own wallet.
