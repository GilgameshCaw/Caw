# Withdraw Lock Spec — Card-Funded Profiles

## Summary

Profiles minted via the fiat card path ("buy a CAW profile") have their
withdrawals disabled at the contract level until the owner completes a
one-time identity verification (Civic Pass or zkMe SBT). This is the
mechanism that keeps the fiat onramp within the stored-value / digital-good
exemption: the user buys platform access, not crypto.

## Contract changes (CawProfile L1)

### New state

```solidity
/// Per-tokenId withdraw lock. True = withdrawals disabled.
/// Set at mint time for card-funded profiles. Cleared by the owner
/// after presenting a KYC attestation (Civic Pass or zkMe SBT).
/// Default: false (wallet-funded profiles are never locked).
mapping(uint32 => bool) public withdrawLocked;
```

### Withdraw gate

In `withdrawTo` (or wherever `withdraw` resolves to), add before the
existing fee logic:

```solidity
if (withdrawLocked[tokenId]) revert WithdrawLocked();
```

New custom error:
```solidity
error WithdrawLocked();
```

### Setting the lock at mint time

The Minter (CawProfileMinter) needs a way to signal "this profile should
be withdraw-locked." Two options:

**Option A — new Minter function:**
```solidity
function mintAndDepositLocked(
    uint32 networkId, address recipient, string memory username,
    uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount
) external payable {
    // Same as mintAndDeposit but sets withdrawLocked[newId] = true
    // after the mint completes.
}
```
Pro: explicit, auditable. Con: another function on the already-large Minter.

**Option B — boolean param on existing sponsor entry points:**
```solidity
function mintAndDepositSponsored(
    ...,
    bool lockWithdraw,  // NEW — set true for card-funded profiles
    ...
) external payable {
    ...
    if (lockWithdraw) cawProfile.setWithdrawLocked(newId, true);
}
```
Pro: no new function. Con: touches the EIP-712 permit struct (changes
the digest, breaks existing sponsor-flow signatures until FE is updated).

**Recommendation:** Option A. Separate function, clean audit surface.
The sponsored path already has 3 entry points; one more is fine.

### Unlocking withdrawals (KYC gate)

```solidity
/// @notice Unlock withdrawals for a card-funded profile after the owner
///         presents a valid KYC attestation. Callable only by the token
///         owner. The attestation check is delegated to an external
///         verifier contract (Civic Gateway or zkMe).
/// @param tokenId The profile to unlock.
function unlockWithdraw(uint32 tokenId) external {
    if (ownerOf(tokenId) != msg.sender) revert NotOwner();
    if (!withdrawLocked[tokenId]) revert(); // already unlocked
    if (!kycVerifier.isVerified(msg.sender)) revert KycRequired();
    withdrawLocked[tokenId] = false;
    emit WithdrawUnlocked(tokenId);
}
```

`kycVerifier` is an immutable address set in the constructor (or a
mutable address settable by the contract owner before renouncement):

```solidity
interface IKycVerifier {
    function isVerified(address account) external view returns (bool);
}

IKycVerifier public kycVerifier;
```

Civic Pass adapter:
```solidity
contract CivicKycVerifier is IKycVerifier {
    IGatewayTokenVerifier public immutable civic;
    uint256 public immutable gatekeeperNetwork;

    constructor(address _civic, uint256 _network) {
        civic = IGatewayTokenVerifier(_civic);
        gatekeeperNetwork = _network;
    }

    function isVerified(address account) external view override returns (bool) {
        return civic.verifyToken(account, gatekeeperNetwork);
    }
}
```

### Transfer behavior

Withdraw lock travels with the tokenId, not the wallet. If a locked
profile is transferred (sold on marketplace), the new owner inherits
the lock. They must do KYC to unlock, same as the original owner.

This is intentional: the lock represents "this profile's deposit was
funded with fiat and has never been KYC'd," not "this wallet is
unverified." A buyer on the marketplace who wants to withdraw the
staked CAW must verify, which is the same behavior they'd face if
they'd bought the CAW on a regulated exchange.

### What's NOT locked

- **Posting, liking, following** — fully functional. No gate.
- **Earning yield** — the deposit earns rewards normally. Rewards
  accumulate in the staking contract and are withdrawable... wait, no.
  Rewards are part of the deposit balance. If withdrawals are locked,
  rewards are also locked. They stay productive but can't be pulled.
- **Transfers** — allowed. The profile NFT is freely transferable.
- **Marketplace sales** — allowed. The seller receives ETH (or
  whatever the listing currency is) from the buyer. The buyer gets
  the profile + its locked deposit.

## Stripe integration (server side)

### Flow

1. FE shows "Buy a CAW profile — $25" button
2. FE creates a Stripe Checkout session via `POST /api/stripe/create-checkout`
3. User completes Stripe Checkout (card, Apple Pay, Google Pay)
4. Stripe sends webhook to `POST /api/stripe/webhook`
5. Server validates webhook signature, extracts:
   - `metadata.username` — the username the user chose in the FE pre-checkout
   - `metadata.walletAddress` — the user's SmartEOA or fresh EOA
   - `amount_total` — USD cents paid
6. Server converts `amount_total` to CAW via the current price
7. Server calls `mintAndDepositLocked(...)` via the sponsor wallet
8. Server records the purchase in a `StripePurchase` DB table
9. FE polls for the new profile (same as existing mint takeover flow)

### Env vars

- `STRIPE_SECRET_KEY` — server-side API key (mode 0600 .env)
- `STRIPE_WEBHOOK_SECRET` — for validating webhook signatures
- `VITE_STRIPE_PUBLISHABLE_KEY` — client-side (in FE .env, publishable)
- `STRIPE_PRICE_ID` — the Stripe Price object for "CAW Profile" product

### Pricing model

Fixed-tier pricing or dynamic? Options:
- Fixed: "$25 profile" as a Stripe Product/Price
- Dynamic: user picks their deposit amount, server creates a Checkout
  Session with a custom amount. More flexible but slightly more code.

Recommendation: dynamic. The user picks their deposit on the FE (same
slider as the existing deposit step), server creates a custom-amount
Checkout Session. Username-cost is derived from the username length.

## KYC provider integration

### Civic Pass (recommended for MVP)

- Free tier: sufficient for launch volume
- SDK: `@civic/gateway-react` for FE widget, `@civic/solana-gateway-ts`
  for on-chain (Solana-native but they have EVM adapters)
- On-chain: `IGatewayTokenVerifier.verifyToken(address, network)`
- Networks: CAPTCHA (bot-only), uniqueness (one-per-person),
  ID document (full KYC). Use ID document for withdraw unlock.

### zkMe (recommended for privacy-first launch)

- Zero-knowledge: user proves "I passed KYC" without revealing identity
  to us. We never see their name, DOB, document.
- SBT on-chain: contract checks `zkMe.hasToken(msg.sender)`
- 30+ EVM chains including Base, Arbitrum
- FATF compliant

### Deployment

1. Deploy `CivicKycVerifier` (or `ZkMeKycVerifier`) with the provider's
   gateway address + the KYC network ID
2. Set `kycVerifier` on CawProfile to the adapter's address
3. FE: when user clicks "Unlock withdrawals," show the provider's widget
   (Civic Pass modal or zkMe verification flow)
4. After verification, user calls `unlockWithdraw(tokenId)` — the
   contract checks the SBT/pass, clears the lock

## Timeline

- **Next contract deploy**: add `withdrawLocked` + `unlockWithdraw` +
  `mintAndDepositLocked` + `IKycVerifier`
- **After Singapore entity confirms**: Stripe integration
- **Before mainnet**: choose Civic vs zkMe, deploy the adapter
