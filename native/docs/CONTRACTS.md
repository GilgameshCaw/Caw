# Contract surface for the native app

The contracts already expose the gasless / sponsored entry points the native app needs. This doc captures what they are, how they work, and which native-app flows use them.

These were added to support the Apple Pay / Google Pay onboarding flow described in [`ONRAMP.md`](ONRAMP.md), where the user pays in fiat and a relayer ends up holding CAW that needs to land in the user's profile without the user ever holding ETH for gas.

## The `*For` pattern, as implemented

The contracts use a **"caller pays, recipient receives"** pattern, not an EIP-712 "signed authorization" pattern. That is:

- The `*For` function takes a `recipient` address.
- CAW (for burn / deposit) is pulled from `msg.sender`.
- Gas is paid by `msg.sender`.
- The NFT, deposit credit, or other state goes to `recipient`.
- **No signature from `recipient` is required.** Anyone can mint or deposit *for* anyone else, as long as they're willing to fund it.

This is intentional. The flow we care about is:

1. User pays USD via Apple Pay → on-ramp delivers CAW (or USDC swapped to CAW) to **the relayer's** address.
2. Relayer calls `mintAndDepositFor(clientId, userAddress, username, depositAmount, ...)`.
3. NFT and deposited balance land at the user's address. User never paid gas, never held ETH.

Because the CAW being spent already belongs to the relayer at this point (it was delivered there by the on-ramp), there's nothing the user could authorize that adds safety. The relayer can only do something *to* the user that the user benefits from — give them an NFT, fund their balance. There's no version of "relayer abuses this" that costs the user anything.

## Functions

### `CawProfileMinter`

Located at `solidity/contracts/CawProfileMinter.sol`.

```solidity
function mintFor(uint32 clientId, address recipient, string memory username, uint256 lzTokenAmount)
function mintAndAuthFor(uint32 clientId, address recipient, string memory username, uint32 lzDestId, uint256 lzTokenAmount)
function mintAndDepositFor(uint32 clientId, address recipient, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount)
```

The plain `mint` / `mintAndAuth` / `mintAndDeposit` functions are now thin wrappers that call the corresponding `*For` with `recipient = msg.sender`. So existing self-mint flows continue to work; the `*For` variants are additive.

CAW for both the **burn cost** and (for `mintAndDepositFor`) the **deposit amount** is pulled from `msg.sender`'s allowance to the Minter contract. Username validation, ID assignment, and the burn happen in shared `_burnAndAssignId`.

### `CawProfile`

Located at `solidity/contracts/CawProfile.sol`.

```solidity
function depositFor(uint32 cawClientId, uint32 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount)
```

CAW is pulled from `msg.sender`. Deposit credit lands at the `tokenId`'s owner. The plain `deposit` is now a wrapper that calls `depositFor` after asserting `msg.sender == ownerOf(tokenId)`, so existing self-deposit flows are unaffected.

`depositFor` also handles the auth fee on first deposit per (client, token), same as `deposit` did before.

## Native-app flows that use these

### First-time mint (Apple Pay → username)

```
1. User taps "Buy username 'foo' for $X" on the mint screen.
2. Native shell opens on-ramp sheet.
3. User completes Apple Pay → provider delivers USDC (or CAW) to the relayer address.
4. (If USDC) Relayer auto-swaps USDC → CAW on a DEX.
5. Relayer calls CawProfileMinter.mintAndDepositFor(
       clientId,
       userWalletAddress,
       'foo',
       depositAmount,
       lzDestId,
       lzTokenAmount
   ) — paying ETH for gas, spending its own CAW for burn + deposit.
6. NFT 'foo' lands at user's address with depositAmount credited on the L2.
```

The user signed exactly one thing during this entire flow: the Apple Pay confirmation. No biometric for the wallet, no gas, no ETH.

### Top-up an existing username

```
1. User taps "Buy more CAW" inside their profile.
2. Apple Pay → on-ramp → CAW at relayer address.
3. Relayer calls CawProfile.depositFor(clientId, tokenId, amount, lzDestId, lzTokenAmount).
4. amount lands as profile balance on L2. User does nothing else.
```

### User-funded mint (existing power-user flow)

User already holds CAW in their in-app wallet, calls the plain `mint` / `mintAndDeposit`. Native wallet biometric prompts for the L1 tx signature. This path is unchanged from the pre-`*For` design — the wrappers preserve it.

### Cross-username funding (deposit from one profile to another)

User has CAW staked in `gilgamesh.caw` and wants to fund a fresh `caw_dev` username for a side project:

```
1. User signs withdraw from gilgamesh.caw → CAW lands at user's L1 address.
2. User signs depositFor(clientId, cawDevTokenId, amount, ...) targeting the new tokenId.
```

`depositFor` works regardless of who owns the destination token, so the user can deposit into a username they don't own (gift / tip / pre-fund a friend's account).

## What the relayer needs

To support the gasless on-ramp flows, the relayer infrastructure needs:

- **An EOA or smart contract address that holds ETH for gas** on whichever L1 the contracts live on. Hot wallet, low balance, topped up from a treasury. Standard relayer hygiene.
- **Approval to spend its own CAW** by the `CawProfileMinter` and `CawProfile` contracts. One-time `approve(maxUint256)` per contract.
- **Idempotency keys** keyed off the on-ramp provider's transaction ID so a retry of `mintAndDepositFor` on a flaky network doesn't double-mint or double-deposit. The contract itself doesn't have replay protection on these calls because it doesn't need it (no user sig involved); idempotency lives in the relayer.
- **Monitoring** for failed mints (e.g., username already taken between the Apple Pay sheet appearing and the on-chain submit) — refund flow back to the user via the on-ramp provider.

## What stays the same

- `CawActions` and the on-chain session-key system are unchanged. The `*For` pattern is purely about how state *enters* a profile (mint, deposit). Once a profile exists with a balance, all action signing follows the existing QuickSign / session key flow described in [`SESSION_KEYS.md`](SESSION_KEYS.md).
- `CawProfile` ownership semantics are unchanged. Transfers, owner-of checks, and the ERC-721 surface all behave as before.
- The plain `mint`, `mintAndAuth`, `mintAndDeposit`, and `deposit` functions still work for users who hold CAW themselves and want to pay their own gas — the `*For` variants are additive, not replacements.

## Why we don't bundle QuickSign into `mintAndDepositFor`

It would be technically possible to add a `registerSessionFor` companion (or fold session registration directly into `mintAndDepositFor`) so that the relayer mints the profile, deposits the CAW, *and* enables QuickSign in a single tx. The Apple Pay flow would end with the user able to post immediately, no follow-up biometric.

We deliberately don't do this. The reason is **trustlessness**, not technical difficulty.

In a bundled flow, the user is simultaneously:
1. Receiving a profile NFT to a wallet they just created.
2. Receiving CAW funds into that profile.
3. Authorizing some *other* key (the device's session key) to spend a portion of those funds.

Steps 1 and 2 are gifts the user can only benefit from. Step 3 is delegation — the user is granting spending authority to a key. Bundling 3 with 1+2 means the user is approving a delegation in the same gesture as approving a fiat purchase, before they've ever held the funds independently. That's the wrong shape for a self-custody system. The user should hold the funds outright first, *then* make a separate, deliberate decision about what spending authority to delegate to their device.

The cost is small: one extra biometric prompt during onboarding. The flow becomes:

```
1. Biometric to create the wallet (key generation, set vault password).
2. Apple Pay → relayer mints + deposits via mintAndDepositFor (no on-chain user sig).
3. Biometric to register a QuickSign session key with a small spend cap.
```

Three steps, two biometrics, one Apple Pay confirmation. That's acceptable. The user clearly experiences "I made a wallet → I bought my username → I let my phone post for me," which is the right mental model. Bundling would compress these into "I tapped Apple Pay" and obscure what's actually being granted.

This also sidesteps a subtler problem: the current `sessions[wallet][sessionKey]` mapping is keyed by wallet address, not `(wallet, tokenId)`. A session key registered for a wallet has authority over **every profile that wallet ever owns**. Bundling session registration into mint would mean a freshly-Apple-Pay'd user is implicitly delegating over any future profiles they ever acquire in that wallet — without ever having seen "QuickSign" as a concept. Keeping it separate keeps the delegation scope visible to the user.

(Per-profile session scoping is a worthwhile contract refactor in its own right — see [`SESSION_KEYS.md`](SESSION_KEYS.md) for the broader discussion — but even with it, we still want session enable to be a deliberate, separate user action.)

## Open items

- **Username collision UX during async on-ramp.** Between the user tapping "Buy" and the relayer's `mintAndDepositFor` landing on-chain, someone else could mint the same name. The on-ramp can take 30s–5min to settle. Mitigations to consider: (a) reserve the username off-chain at purchase time and only release if the on-chain mint fails, (b) commit-reveal at the contract level, (c) just refund and re-prompt the user. Option (c) is simplest and probably fine at our volume.
- **Gas cost predictability.** L1 gas spikes turn a 5-cent operation into a 50-cent one. The relayer absorbs this today. We may eventually need to charge a small "service fee" line item that floats with gas, or batch multiple users' mints into a single tx. Defer until volume makes it worth solving.
- **Multi-relayer / decentralized relaying.** Long-term, anyone could run a relayer (the contract doesn't privilege a specific address). Worth thinking about whether to publish a relayer reference implementation later, post-launch.
