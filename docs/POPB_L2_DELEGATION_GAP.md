# Pop-B passkey actions blocked on L2 — SmartEOA delegated only on L1

## Symptom
A passkey (Population-B) user's **unstake** fails: API returns `400 Invalid
signature`; server log: `[Actions] ERC-1271 isValidSignature failed: could not
decode result data`. The UI showed nothing (separate fix landed). More broadly:
**no passkey *root-signed* on-chain action can succeed** — which is why everything
is funneled through a Quick Sign session.

## Root cause (confirmed on-chain + in code)
The passkey is verified via ERC-1271 by calling `isValidSignature` **directly on
the owner EOA**, on the chain where the action runs:

- `CawActions._checkERC1271` (CawActions.sol:1547-1552) does
  `owner.staticcall{gas:150k}(isValidSignature(digest, sig))`. CawActions /
  CawActionsERC1271 are deployed on **L2** (Base Sepolia). So the owner EOA must
  have a working `isValidSignature` **on L2**.
- That requires the EOA to be **EIP-7702 delegated to SmartEOA on L2**.
- But the delegation is set ONLY on **L1**: `SponsorService.sponsorBootstrap`
  submits the single type-4 tx (7702 auth + SmartEOA.initialize +
  mintAndDepositSponsored) via `this.provider = makeJsonRpcProvider(l1ProviderUrl,
  l1ChainId)` (index.ts:248). There is NO L2 delegation leg anywhere.
- All action EIP-712 domains use `baseSepolia.id` (L2) — `actions.ts:576`
  `DOMAIN.chainId = baseSepolia.id`, used by `buildTypedData` for every action
  incl. withdraw. So the digest commits to L2 and is verified on L2.

Net: SmartEOA `isValidSignature` exists on **L1**; actions are verified on **L2**
where the EOA has no code → `isValidSignature` reverts → "could not decode result
data" → false → rejected. Session-key (Quick Sign) actions work because they're
plain ECDSA recovered by the validator, not ERC-1271 — so the app "works" only as
long as the user has a session, which is the thing we don't want to force.

## Why the earlier API "fix" was wrong
A first patch routed the API's `verifyERC1271Sig` to L1 by `domain.chainId`. But
the domain is L2, so it was a no-op; worse, even if it weren't, the API passing
wouldn't help — the **validator's on-chain `processActionsERC1271` on L2** does the
same staticcall and would still revert. Reverted. (Only the Staking UI
error-toast was kept.)

## Options to actually fix (decision pending)
1. **Delegate SmartEOA on L2 too (recommended).** At bootstrap, also submit a
   7702 delegation (+ initialize if SmartEOA needs per-chain state) on L2 so
   `isValidSignature` resolves where actions run. Cost: a second sponsored tx on
   L2 at onboarding; sponsor needs an L2 signer/balance; existing passkey accounts
   need a one-time backfill delegation. Unblocks ALL passkey root actions →
   removes the forced-Quick-Sign requirement. Open Qs: does SmartEOA.initialize
   assume L1 (it calls mintAndDepositSponsored)? Likely need an L2 "delegate +
   enroll passkey only" init path that does NOT mint. Verify SmartEOA is the same
   bytecode at SMART_EOA_ADDRESS on L2 (0x099d43F3…) — confirm deployed on Base
   Sepolia.
2. **L1-domain root actions.** Make root-signed actions (withdraw) use an
   L1-domain + L1 verification. Conflicts with the L2 action model; withdraw is an
   L2 action that triggers an L1 unlock via LZ — can't trivially move.
3. **Status quo = session-only.** Keep forcing a Quick Sign session for all
   actions and never use the passkey root signer on-chain. Rejected per product
   goal ("user shouldn't be forced to create a Quick Sign session").

## Verification TODO before building option 1
- `eth_getCode` the owner EOA on L2 (Base Sepolia) → confirm it's empty (no
  0xef0100 delegation) for a freshly-bootstrapped passkey account.
- `eth_getCode` SMART_EOA_ADDRESS (0x099d43F3…) on L2 → confirm SmartEOA bytecode
  is deployed there (the delegation target must exist on L2).
- Confirm SmartEOA has a delegate-only / enroll-passkey entrypoint that doesn't
  re-run mintAndDepositSponsored (which is L1-only).
