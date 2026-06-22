# Scope: delegate SmartEOA on L2 so passkey users act without a Quick Sign session

## Goal
A Population-B passkey user's **root signer** (passkey) should be able to do any
on-chain action on L2 — post, like, follow, **withdraw** — WITHOUT being forced
to first create a Quick Sign session. Today only session-key (ECDSA) actions
pass on L2; any passkey-root (ERC-1271) action reverts.

## Confirmed on-chain ground truth (test2, account 0xc8d0…a067)
| | L1 (Sepolia 11155111) | L2 (Base Sepolia 84532) |
|---|---|---|
| owner EOA code | `0xef0100…099d43F3` (7702 → SmartEOA) ✓ | **EMPTY** (no delegation) ✗ |
| SmartEOA at 0x099d43F3… | deployed (7707 b) ✓ | **NOT DEPLOYED** ✗ |

Verifier path: `CawActions._checkERC1271` (CawActions.sol:1547) →
`owner.staticcall(isValidSignature(...))` on **L2**. With no delegation +
no SmartEOA on L2 → revert → "could not decode result data" → InvalidSig.

## The two missing L2 prerequisites (BOTH required)
1. **Deploy SmartEOA bytecode on Base Sepolia** (the 7702 delegate target must
   exist on the chain you delegate on). One-time deploy; add L2 address to
   abi/addresses.ts. NOTE: it can be the SAME address as L1 only if deployed via
   the same deployer+nonce or CREATE2 — otherwise it's a different L2 address and
   the 7702 auth tuple must point at the L2 address. Decide: CREATE2 for
   address-parity (cleaner) vs. per-chain address (auth tuple + FE must use the
   right one per chain).
2. **Delegate each passkey EOA to SmartEOA on L2 + enroll the passkey.**
   `SmartEOA.initialize(pkX, pkY, ecdsaFallback, address(0), "")` — the
   `minterContract == address(0)` STANDALONE path already exists (SmartEOA.sol:207,
   237-242): it enrolls the passkey and does NOT mint. So **no SmartEOA contract
   change is needed** for an L2 "delegate + enroll only" leg. ✓

## Good news / bad news
- ✅ No SmartEOA.sol change — the address(0) initialize path is exactly the
  delegate-only entrypoint.
- ✅ WebAuthn sigs are chain-agnostic; the same enrolled passkey verifies on L2.
- ⚠️ Per-chain 7702: the user must sign a SECOND EIP-7702 auth tuple for L2
  (chainId 84532, their L2 nonce). Sponsor submits a type-4 tx on L2.
- ⚠️ Sponsor needs an **L2 signer with ETH** to pay for the L2 delegation tx.
  Today SponsorService.provider/wallet are L1-only (index.ts:248). Need an L2
  wallet + balance + treasury-low guard, mirroring the L1 path.
- ⚠️ Existing passkey accounts (already bootstrapped L1-only) need a **one-time
  backfill** L2-delegation, or they stay broken. New accounts get it at onboarding.

## Implementation phases
1. **Deploy SmartEOA on Base Sepolia.** Decide CREATE2 vs plain. Regen
   abi/addresses.ts with the L2 SmartEOA address (or confirm parity). Foundry/script.
2. **Sponsor L2 leg.** Add an L2 provider + wallet to SponsorService (env:
   L2_PROVIDER_URL already exists for reads; need L2 sponsor key + balance). New
   method `sponsorDelegateL2({ authTupleSig, pkX, pkY, ecdsaFallback })` that
   submits the type-4 tx on L2 calling initialize(...,address(0),"").
   Treasury-low + rate-limit guards like sponsorBootstrap.
3. **FE: sign the L2 auth tuple.** At onboarding (after the L1 bootstrap), sign a
   second 7702 auth tuple for chainId=84532 with the secp256k1 key (it's in
   memory then) and POST to the new sponsor endpoint. bootstrap.ts already has
   signAuthorizationTuple — call it twice (L1 + L2) or add an L2 pass.
4. **Onboarding orchestration.** Sequence: L1 bootstrap (mint+deposit, as now) →
   L2 delegate+enroll (new). The L2 leg is cheap (no mint) and can be
   fire-and-forget with retry, but the user CAN'T do passkey L2 actions until it
   lands — so surface status, and keep the (now-optional) Quick Sign as the
   fast-path while L2 delegation settles.
5. **Backfill existing accounts.** A `/recovery`-style or AccountSettings action
   (or a server sweep) that delegates L2 for already-bootstrapped passkey EOAs.
   Requires the user's secp256k1 key to sign the L2 auth tuple → must happen
   client-side when the key is available (recovery sign-in, or derive at next
   passkey op). Scope: smaller follow-up; the user hit this with an existing acct.
6. **Verify end-to-end.** Re-run unstake on a freshly-L2-delegated account:
   `_checkERC1271` on L2 returns magic → action passes the validator.

## Open questions to resolve in phase 1
- CREATE2 address parity for SmartEOA across L1/L2? (affects whether the FE/auth
  tuple uses one address or two.)
- Does the validator's processActionsERC1271 path need anything else on L2 besides
  isValidSignature returning magic? (Re-read the rs/sig packing for the ERC1271
  sibling — task #255 verified encoding; confirm it doesn't assume L1.)
- Is there an even simpler option: a SmartEOA "ERC-1271 sibling" registered on
  CawActions (CawActions.sol:173 mentions an ERC-1271 sibling path, sibling
  verifies then calls owner) that could verify against an L1 read? (Almost
  certainly not — staticcall can't cross chains — but worth a 5-min check before
  committing to per-chain delegation.)

## Decision needed from user before building
- CREATE2 vs per-chain SmartEOA address.
- Is the sponsor funding an L2 signer acceptable (more ETH ops surface)?
- Backfill existing accounts now, or accept that pre-this-change passkey accounts
  must re-onboard / use Quick Sign until backfilled?
