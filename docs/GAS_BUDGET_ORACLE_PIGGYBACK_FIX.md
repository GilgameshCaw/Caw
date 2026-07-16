# Design: Conditional LZ gas budget for the oracle piggyback

**Status:** proposed (not implemented). Immutable-contract change → needs security review → rides the next V2 deploy.

**Origin:** validator zinsanjp's transferAndSync L1→L2 sync failure. Root-caused: the enforced LZ receive gas (105k for `updateOwners` n=1) doesn't cover the full `_lzReceive` path when the `capOracle.recordSample` piggyback does a ratio push.

## Problem

`CawProfileLedger._lzReceive` runs on EVERY L1→L2 message (one shared handler, 5 selectors). Before dispatching the primary payload it calls `capOracle.recordSample(...)` — a price-sample piggyback. On a live-oracle L2 that call can, when the TWAP crosses the 100bps hysteresis threshold, synchronously push a new ratio into CawActions (`setCapRatio` + `setTipRatio`).

Measured cost of the oracle piggyback alone (real `CawCapOracle` + mock target, `LzReceiveOracleOverhead.t.sol`):
- stale / non-monotonic sample (skipped): **~1,851 gas**
- warm, within hysteresis (no push): **~36,254 gas**
- fresh sample crossing threshold (cap + tip push): **~165,441 gas**

Inner handler `_setOwnerOf` (existing-owner transfer, n=1): **~68,627 gas** (`LzGasBudgetAudit.t.sol`, re-transfer harness).

So full `_lzReceive` cost ranges ~70k (skip) → ~104k (common no-push) → ~233k+ (full push). The deployed budget is 105k. Zin's failure was the **common case** (~104k vs 105k, tightened by the LZ 63/64 executor rule), not even the worst case.

Two structural facts:
1. The oracle piggyback runs **before** the primary dispatch, with **no gas reservation** for the dispatch. So a full-push sample can consume the budget and starve `_setOwnerOf` — the try/catch swallows the oracle revert but the *delivery* still OOGs.
2. Inside `recordSample`, the sample **write** (ring buffer + `samplesWritten++` + emit) happens before the push **self-call** (`address(this).call(_maybePushRatioExternal)`, already swallow-on-revert). So the write and the push are already separable.

## The fix (two parts)

### Part 1 — Conditional quote (`gasLimitFor`)

`gasLimitFor` is computed at both send (`lzSend`) and quote (`lzQuote`) time, and is `view`. Make it return a **push-inclusive** budget when a live price sample rides along, and the small budget otherwise, so the app requests the right gas exactly when the push may fire.

**Signal: live-sample-present (stateless).** When `priceReader` is set and `readSample()` returns a non-zero/live timestamp, quote the push-inclusive base; when unset or ts==0, quote the small base. Chosen over a stateful "fresh vs last-sent" comparison because:
- it works inside the `view` quoter (no stored state to update),
- it **never under-quotes** (a live sample always gets push room),
- it adds no mutable state surface to an immutable contract.
- Trade-off accepted: over-quotes on a live sample that won't actually cross threshold — costs marginally higher LZ fee on those messages, never a failure.

This keeps the per-token `65_000 * n` term unchanged (that's the `_setOwnerOf` scaling); the oracle cost is per-MESSAGE and goes in the base. Effectively two base tiers for the shared handler: `BASE_NO_ORACLE` and `BASE_WITH_PUSH`, selected by the live-sample signal.

### Part 2 — Gas-cap the oracle call (backstop)

Even with Part 1, cap the gas forwarded to the oracle so a mis-prediction can NEVER starve the primary dispatch:

```solidity
try capOracle.recordSample{gas: ORACLE_GAS_CAP}(cumulative, priceTs) {} catch {}
```

`ORACLE_GAS_CAP` sized to comfortably fit the full push (~165k) plus margin — but bounded, so the dispatch that follows always has its reserved remainder. Because the sample write precedes the push self-call, a cap that's too tight for a push still lands the sample and sheds only the push (which `pushRatioIfStale()` — the existing permissionless keeper path — then catches out-of-band). "The big push still works": Part 1 ensures the budget is there when a live sample rides along, and the cap only sheds on genuine over-run, not routinely.

## Budget numbers (to finalize from measurement)

Target margin: "in between" — measured worst case + modest fixed headroom, not tight-to-the-wire, not bloated. Apply the LZ 63/64 rule (enforced budget ≥ actual × 64/63).

- `BASE_NO_ORACLE`  ≈ wrapper + common oracle (skip/no-push) → covers ~104k path
- `BASE_WITH_PUSH`  ≈ wrapper + full-push oracle (~165k) + margin → covers ~233k+ path
- per-token term: `65_000 * n` unchanged
- Re-validate ALL 5 authorized selectors against the full receive path (updateOwners, lzDepositMintSession, setAllowFreeAuth, setNetworkTipTarget, registerSponsorRepayFromL1 — the last has NO base entry today; add one). See [[project_lzreceive_gas_budget_omits_oracle]].

## Post-deploy safety valve (already exists)

`CawNetworkManager.setGasOverride(networkId, selector, newAmount)` — network-owner-only, strictly ratcheting, capped at `MAX_GAS_OVERRIDE = 100_000`, survives fee/ownership locks. Adds to `gasLimitFor`. Lets an owner top up a too-low deployed budget WITHOUT redeploy. NOTE the 100k cap means it can't reach the full-push worst case from the current 105k base on its own — it's a stopgap, not a substitute for the source fix.

## Deployed-V2 stopgap (immediate, separate from this fix)

The currently-deployed testnet V2 (CawProfile 0x4F85…) can't get this logic change without redeploy. Immediate unblock: `setGasOverride(1, 0xc14f8554, 100000)` from the network owner (= deployer key) → enforced updateOwners budget 105k → 205k, clearing Zin's common-case failure. Does not cover the full-push worst case (cap-limited).

## Open items before implementation

- Confirm `ORACLE_GAS_CAP` value from a real end-to-end `_lzReceive` measurement with a live-oracle-wired Ledger (current numbers measure the oracle and handler separately; validate the sum + wrapper end-to-end).
- EIP-170: the conditional adds bytecode to CawProfile (already tight). Measure against a fresh `rm -rf out cache && forge build`; if it pushes over, move logic out rather than inline (see [[feedback_collapsing_functions_grows_bytecode_at_runs1]]).
- Security review: the `{gas: N}` forwarding + 63/64 interaction, and the conditional-quote signal, on an immutable deploy.
