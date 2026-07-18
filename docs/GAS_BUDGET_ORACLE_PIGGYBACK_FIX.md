# Fix: LZ receive-gas budget for the oracle piggyback

**Status:** SHIPPED (commit `684566f6`, master). Rides the next V2 redeploy — the
currently-deployed testnet contracts still have the bug and there is NO on-chain
workaround (see "Why no recovery override" below).

**Origin:** validator zinsanjp's transferAndSync L1→L2 sync failure. Root-caused
with on-chain confirmation against his failing tx.

## The bug

`CawProfileLedger._lzReceive` runs on every L1→L2 message (one shared handler).
Before dispatching the primary payload it feeds a price sample to
`capOracle.recordSample`. On a live-oracle L2 that call can, when the TWAP crosses
the 100bps hysteresis, synchronously push a new ratio into CawActions
(`setCapRatio` + `setTipRatio`).

Measured oracle piggyback cost (real `CawCapOracle` + mock target,
`test-foundry/LzReceiveOracleOverhead.t.sol`):
- stale / non-monotonic sample (skipped): ~1,851 gas
- warm, within hysteresis (no push): ~36,254 gas
- fresh sample crossing threshold (cap + tip push): **~165,441 gas**

Inner handler `_setOwnerOf` (existing-owner transfer, n=1): ~68,627 gas.

The push runs BEFORE the primary dispatch, so if the enforced LZ receive budget
doesn't cover `handler + push`, the whole message OOGs at the executor
(`CouldNotParseError 0x`). `updateOwners`' budget was `40k base + 65k*n` = 105k
for n=1 — couldn't fit ~68k handler + ~165k push. The `allowFreeAuth` /
`setNetworkTipTarget` 80k bases had the SAME latent gap (sized for the cheap
~35k sample-write, not the push). No gas-budget test modeled the push, which is
why it went unnoticed.

## The fix (what shipped)

**Bump every oracle-piggyback selector's `gasBaseFor` to a flat 250k** — the
value the `lzDepositMintSession` bundle has always used and which has covered the
oracle push in production. `updateOwners` 40k→250k; `allowFreeAuth` /
`setNetworkTipTarget` 80k→250k; bundle already 250k. `gasLimitFor` is unchanged:
`gasBaseFor[selector] + 65_000*n + networkGasOverride(...)`.

Over-budgeting the lighter selectors is a non-issue: a gas budget is a ceiling,
not a bill, and on L2 at sub-gwei even ~500k gas is a fraction of a cent (3.5M
gas ≈ $0.01). A generous flat base is deliberately future-proofed against EVM/LZ
repricing on an immutable deploy.

**Defense-in-depth (CawProfileLedger):** `_lzReceive` now gas-caps the
`recordSample` call (`ORACLE_RECORD_GAS_CAP = 180k`, `try recordSample{gas: ...}`)
so the oracle can NEVER starve the primary dispatch even if its cost grows later.
The sample write happens before the internal push self-call, so a cap that's too
tight for a push still lands the sample and just sheds the push, which
`pushRatioIfStale` (the existing permissionless keeper path) applies out-of-band.

Tests: 14 gas-budget tests pass (`LzGasBudgetAudit` + `LzReceiveOracleOverhead`).
CawProfile stays under EIP-170 (24,530; 46-byte headroom, unchanged — bumping
constants of like magnitude is +0 bytecode).

## Why no recovery override (per-network hatch)

The tempting design was a per-network `setGasOverride` recovery hatch for
updateOwners. It does NOT work and is NOT needed:
- `_updateNewOwners` sends with the **networkId=0 sentinel** (the flush spans
  tokens across networks, so it belongs to none). `gasLimitFor` reads
  `networkGasOverride[0][updateOwners]`.
- **networkId 0 has no owner**, so `setGasOverride(0, ...)` reverts
  `onlyNetworkOwner`. The slot is permanently unsettable. (An on-chain
  `setGasOverride(1, updateOwners, 100000)` was sent early in the investigation —
  tx `0x7ac36ca` — and is a NO-OP: this path reads slot 0, not 1.)
- The override was only ever `MAX_GAS_OVERRIDE = 100k` of margin anyway. A
  generous flat base bakes in ≥ that protection permanently and automatically,
  with no operator action required — strictly better than a hatch that needs a
  live owner to notice an OOG and act.

## Rejected approaches (measured — do NOT re-attempt)

Reclaiming EIP-170 headroom for a fancier fix all backfired at `optimizer_runs=1`:
- **networkId-threading** (thread caller's networkId through transferAndSync/
  syncTransfer so the override slot is settable): +316 bytes over EIP-170.
- **Conditional oracle budget** (readSample() in gasLimitFor to add the push
  allowance only when a live sample rides): the per-call staticcall cost more
  bytecode than a flat base; net negative.
- **Library extraction** of a small pure helper: +459 bytes (external-call
  overhead at each callsite > the inlined encoder it replaced).
- **DRY-collapsing** the mint/deposit/auth trio: +1.6KB (documented in memory).
- **Delegatecall logic-split**: the executor must replicate CawProfile's deep
  inherited storage layout (ERC721Enumerable + OApp), so no net reclaim.

Bisect proof: HEAD + a ONE-LINE `40k → 250k` base bump = still UNDER EIP-170
(24,530, 46 headroom). The simple fix was the correct fix all along.

## Follow-ups

- `registerSponsorRepayFromL1` intentionally has NO `gasBaseFor` entry / selector
  constant — it's only ever called same-chain (bypassLZ), never `lzSend`'d
  (cross-chain reverts `RepayCrossChainUnsupported`). When cross-chain repay
  ships, whoever adds its `lzSend` must add a matching 250k base. (zinsanjp
  flagged the gap; confirmed harmless.)
- UI: `TransferNFTModal` shows "L2 ownership synced" even for the cross-chain
  case where `SyncTransferModal` is still a required step — misleading, noted to
  fix in the transfer flow. (zinsanjp.)
