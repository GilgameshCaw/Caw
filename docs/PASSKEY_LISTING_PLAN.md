# Plan: Passkey (Pop-B) profile LISTING + TRANSFER via relayed SmartEOA batch

## Problem
`CreateListingModal`, `TransferNFTModal`, and `SyncTransferModal` are all wagmi-only:
they gate on `isOwner = address === tokenOwner` and sign via `useWriteContract`. A
Population-B passkey user has no wagmi wallet (`address` undefined) → `isOwner` false →
button shows "wrong wallet" and is disabled. Listing and transferring are impossible for
passkey users.

## Fee model — DECIDED: L1 CAW or L1 ETH, NEVER L2 CAW
The relayed op runs on **L1** (approve/createListing/transferAndSync on CawNames +
marketplace). The relayer fronts **L1 gas** (+ LZ ETH for transfer). Repayment must be
an **in-batch fee leg atomic with the op**, so the relayer can't be stiffed:
- **Pay in L1 CAW** (primary): batch appends `CAW.transfer(relayer, feeCaw)` — the
  audited withdraw/deposit pattern (`SEL_CAW_TRANSFER`, digest on L1 chainId).
- **Pay in L1 ETH** (fallback): batch appends a raw ETH transfer to the relayer
  (existing ETH-repay mode).

**L2 staked CAW is explicitly rejected — NOT trustless.** The op + gas are on L1; staked
CAW is on L2 (CawProfileLedger). No signed transaction can make an L1 gas payment atomic
with an L2 balance debit — someone (the relayer) would have to extend cross-chain credit
and eat the loss if the L2 debit failed or the balance moved. That trust assumption is
exactly what the SmartEOA-relay model exists to avoid. So the fee always comes from the
L1 EOA's own CAW or ETH, atomic in the same signed batch.

**UX consequence (REQUIRED in both modals):** a passkey user needs a little L1 CAW or ETH
in their EOA. When the EOA lacks enough for the fee, the modal must tell them to top up
(link to the /wallet top-up flow which already funds the L1 EOA) rather than showing a
dead/greyed button. Show the required fee amount.

## Contract facts verified
### Listing (CawProfileMarketplace.sol)
- `createListing` (L138): `require(ownerOf(tokenId) == msg.sender)` +
  `require(isApprovedForAll(msg.sender, this))`; `seller = msg.sender`. SmartEOA = owner → passes.
- Proceeds pull-pattern (H-15): `pendingPayouts[seller]` / `pendingTokenPayouts`; seller
  later calls `withdrawPayouts`. SmartEOA-safe (no push during sale).
- Batch: `[setApprovalForAll(marketplace,true)?, createListing(...), feeLeg]`. No LZ fee
  (pure L1) → `forwardedValue = 0`, fee = gas-in-CAW/ETH only.

### Transfer (CawNames.transferAndSync)
- FE calls `transferAndSync(recipient, tokenId, lzDestId=l1.layerZero, 0)` with
  `value: lzFee`. Transfers the NFT + flushes L2 owner-sync. msg.sender = SmartEOA (owner).
- Batch: `[transferAndSync(recipient, tokenId, lzDestId, 0){value: lzFee}, feeLeg]`.
  **Forwards a real LZ fee** → `forwardedValue = lzFee`; relayer fronts gas + lzFee,
  repaid via `quoteExecuteGasFeeCaw(lzFee)` (CAW) or ETH-repay. Same shape as withdraw.
- SmartEOA.executeBatch must forward `value: lzFee` on the transferAndSync call.
  VERIFIED: deployed SmartEOA (SMART_EOA_ADDRESS 0x2e1B…) generated ABI shows
  `executeBatch: payable`; the payable v2 (commit 9e6a5c44) is the live impl on test2.
  Security phase to re-confirm on-chain payability before transfer ships.

## Server (`client/src/api/routes/sponsor.ts`) — EXECUTE_ALLOWED additions
Strict allow-list (SEAM-EXEC-4), default-deny. Add:
- `CAW_NAMES_ADDRESS` (existing key): `setApprovalForAll` `0xa22cb465`
  — **shape: operator == marketplace, approved == true**.
- `CAW_NAME_MARKETPLACE_ADDRESS` (NEW target): `createListing`
  — **shape: tokenId (arg 0) owned by signer** (same owner→tokenId lookup as depositFor).
- `CAW_NAMES_ADDRESS`: `transferAndSync`
  — **shape: tokenId owned by signer**; recipient (arg 0) is user-chosen, allowed.
    forwarded value (lzFee) already fee-covered by the quote.
- `CAW.transfer` already allow-listed (fee leg). ETH-repay leg already handled.

## FE
### `CreateListingModal.tsx` (Pop-B branch)
- `population === 'B'`: skip wagmi `isOwner`/wrong-wallet gate; `isOwner` = activeToken.owner
  == tokenOwner. Read `isApprovedForAll(eoa, marketplace)`; build ExecCalls
  `[approve?, createListing, feeLeg]`; `useSmartEoaExecute().execute(calls)` (passkey signs;
  IdentitySigningProvider overlay). Quote CAW fee (`GET /execute-quote?forwardedValueWei=0`),
  prepend transfer leg. If EOA CAW+ETH < fee → top-up prompt.
### `TransferNFTModal.tsx` (Pop-B branch)
- Same shape: build `[transferAndSync(recipient,tokenId,lzDest,0){value:lzFee}, feeLeg]`;
  quote fee with `forwardedValueWei = lzFee`; passkey execute; top-up prompt on insufficient.
- `SyncTransferModal.tsx`: audit whether Pop-B reaches it (may be L2-only follow-up sync).
### Shared
- Small helper to check L1 EOA CAW + ETH balances vs required fee; the top-up CTA links to
  the existing /wallet top-up (funds the L1 EOA). i18n keys for "top up to list/transfer".

## Phases
1. Server: EXECUTE_ALLOWED += setApprovalForAll (marketplace-operator shape) + createListing
   (owned-tokenId) + transferAndSync (owned-tokenId). execute-quote already takes forwardedValue.
2. Security review (security agent): new allow-list entries + shape checks; relayer-whole for
   both ops (fee ≥ gas + forwarded lzFee); operator bound to marketplace; tokenId bound to
   signer; no selector moves value unrepaid; NFT can't be transferred OUT except by the
   user's own signed transferAndSync.
3. FE listing Pop-B branch + top-up gating.
4. FE transfer Pop-B branch + top-up gating.
5. Verify on test2 (passkey user): list a profile → biometric → relay → Listed; transfer →
   Transfer event; relayer whole (CAW += fee OR ETH net ≈ 0); tamper cases rejected.

## Follow-ups (not blocking list/transfer)
- Passkey seller collecting sale proceeds: relayed `withdrawPayouts` / token variant.
- Confirm payable executeBatch is DEPLOYED before transfer ships (inner-call lzFee value).
