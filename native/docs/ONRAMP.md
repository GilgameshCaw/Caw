# On-ramp: Apple Pay / Google Pay → CAW

Goal: a user with no crypto can tap a button, pay with Apple Pay or Google Pay, and have CAW arrive at their in-app wallet address — ready to mint a username.

## What we don't build

A regulated fiat on-ramp is a multi-million-dollar compliance project (KYC, money transmitter licenses per US state, banking partners, fraud, chargebacks). We will not build this ourselves.

## What we do

Integrate one or more existing on-ramp providers that already handle KYC, payments, and settlement. Candidates:

- **MoonPay** — supports Apple Pay, broad coverage, has an SDK with embedded checkout.
- **Ramp** — similar, often cheaper for the user, has hosted flow + SDK.
- **Coinbase Onramp** — best UX for users who already have a Coinbase account, weaker for those who don't.
- **Transak** — broad token support, decent SDK.

Pick one for v1 (likely MoonPay or Ramp based on CAW token availability and Apple Pay support per region), add a second later for redundancy and price competition.

### CAW token availability

The on-ramp providers settle in popular tokens (ETH, USDC, etc.). Two paths to deliver CAW:

**Direct** (if a provider supports CAW)
→ User pays USD, provider delivers CAW directly to the user's wallet address. One step, best UX.

**Bridged via a swap** (more likely initially)
→ User pays USD, provider delivers ETH or USDC to the user's wallet address. App immediately offers a one-click swap to CAW via Uniswap (or whichever DEX has the deepest CAW liquidity). Two steps, but mostly invisible if we auto-trigger and pre-approve the swap.

For onboarding, we hide the two-step nature in a single "Buy username with Apple Pay" flow that lands directly in the user's profile via the relayer + `mintAndDepositFor` (see [`CONTRACTS.md`](CONTRACTS.md)):

```
[Buy username 'foo' with Apple Pay]
   ↓
Apple Pay sheet (provider) — user pays $X
   ↓
USDC delivered to relayer address
   ↓
Relayer swaps USDC → CAW on DEX
   ↓
Relayer calls CawProfileMinter.mintAndDepositFor(
    clientId, userAddress, 'foo', depositAmount, ...
)
   ↓
NFT + balance land at user's address.
```

The user signs nothing on-chain during this step. The only signature was Apple Pay confirming the fiat charge.

### Full onboarding flow

The complete first-time experience, end-to-end:

```
1. Biometric  → wallet created on-device, vault password set
2. Apple Pay  → relayer mints + deposits (no on-chain user sig)
3. Biometric  → user registers a QuickSign session key with a small spend cap
```

Three taps, two biometrics, one Apple Pay confirmation. After step 3 the user can post freely without further prompts until the session expires.

We deliberately keep step 3 separate from step 2 even though `mintAndDepositFor` could in principle bundle session registration. The reason is trustlessness: granting spending authority to a session key is a different kind of decision from buying a username, and the user should make it explicitly, after they hold the funds, with their own biometric. See [`CONTRACTS.md`](CONTRACTS.md) for the full reasoning.

### Top-ups

For a top-up against an existing username, the same shape but `CawProfile.depositFor` instead of `mintAndDepositFor`. No biometric needed if QuickSign is already enabled and the deposit lands within scope; otherwise one biometric to authorize the deposit-side action.

### OTC fallback

For high-value users or regions where on-ramps are spotty, support an OTC path: user contacts us, we settle out-of-band, and deposit CAW to their address manually. Not in the app — just a documented support flow. Don't build UI for this until volume justifies it.

## Integration shape

The on-ramp lives in a native module (not the WebView), because:
- Apple Pay integration requires native PassKit APIs.
- Provider SDKs are native-first, with web SDKs as a less-polished fallback.
- Keeping the provider out of the WebView reduces the trusted origin surface.

```
Web app: tap "Buy CAW"
   ↓
bridge.openOnramp({ token: 'CAW' | 'USDC', amountUsd, walletAddress })
   ↓
Native opens provider SDK in a sheet
   ↓
Provider runs Apple Pay / KYC / payment
   ↓
Provider returns: { txHash, deliveredToken, deliveredAmount }
   ↓
Native returns to web app
   ↓
Web app polls for on-chain delivery, triggers swap if needed
```

## Open questions to resolve before shipping

- Which providers support CAW directly vs. requiring a swap? (Need to ask each.)
- Apple's policy on crypto purchases via in-app — provider SDKs handle this, but we should confirm none of our flows trip the in-app-purchase rules. (Generally: buying crypto routes through the provider's own payment rails, not Apple's IAP, which is allowed for "approved cryptocurrency exchanges.")
- Per-region availability: MoonPay and Ramp have different country coverage; we may need to detect region and route accordingly.
- Fees: provider takes 1–4%. Decide whether to absorb, pass through, or split. Default: pass through with clear "$X fee" line item before user confirms.
- Refunds / failed transactions: provider handles, but app needs UI to show in-flight purchases that are pending or failed.

## What ships in v1

- One provider (MoonPay or Ramp, picked after CAW liquidity check).
- Apple Pay on iOS, Google Pay on Android, card fallback both.
- USDC settlement → auto-swap to CAW.
- Single "Buy CAW" entry point on the username-mint screen and in wallet settings.
- Receipts visible in wallet history.

## What's deferred

- Multi-provider price comparison.
- Direct CAW settlement without swap.
- Fiat off-ramp (sell CAW for USD). Add when users ask.
- Saved payment methods, recurring buys, DCA.
