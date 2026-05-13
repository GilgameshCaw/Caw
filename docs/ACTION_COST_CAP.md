# Action Cost Cap

ETH-denominated upper bound on the per-action CAW cost. Future-proofs the
protocol against CAW appreciating to a scale where the current fixed-CAW
fees become unaffordable.

## Motivation

Action costs in `CawActions.sol` are currently fixed CAW amounts:

| Action  | Cost (whole CAW) | Source |
| ------- | ---------------- | ------ |
| CAW     | 5,000            | `CawActions.sol:1089` |
| LIKE    | 2,000            | `CawActions.sol:1099` |
| RECAW   | 4,000            | `CawActions.sol:1103` |
| FOLLOW  | 30,000           | `CawActions.sol:1107` |
| UNLIKE/UNFOLLOW | 1,000    | `CawActions.sol:1126` |

If CAW market cap reaches X/Twitter-scale (~$44B), one CAW is ~$0.664,
making a single post cost ~$3.32. That's a UX wall the protocol can't
push through later because the costs are baked into `processActions`.

Solution: cap each action's CAW cost at an ETH-denominated maximum,
derived from a TWAP of the burned L1 LP. The cap only binds once CAW is
expensive enough; until then the existing fixed cost applies unchanged.

## Design

### Cap rule

For each action type with a configured cap:

```
cost_in_CAW = min(
  baseline_caw_per_action,           // manifesto fixed cost
  max_eth_per_action / twap_eth_per_caw
)
scale_num = cost_in_CAW
scale_den = baseline_caw_per_action
```

Every internal distribution amount for that action is then scaled by
`scale_num / scale_den`. **The split percentages don't change** — only
the total notional. So a LIKE that today is `2000 = 1600 (receiver) +
400 (depositors)` becomes, when the cap binds at e.g. 500:

```
total      = 500
receiver   = 1600 * 500 / 2000 = 400  (still 80%)
depositors = 400 * 500 / 2000  = 100  (still 20%)
```

This is critical: scaling only the total without scaling the splits
would silently change who-gets-what. The manifesto's distribution model
is preserved at every price point.

Properties:

- **Self-deactivating.** While CAW is cheap (`max_eth / twap_eth_per_caw`
  > baseline), `scale_num == scale_den` and the baseline applies
  byte-for-byte. Cap is a no-op until needed.
- **Splits invariant.** Receiver share, depositor share, validator-tip
  share all remain at today's percentages, scaled proportionally with
  the total.
- **No floor.** When CAW falls, baseline applies unchanged. Cap-only,
  asymmetric. Avoids the "subsidy-during-volatility" attack surface a
  symmetric rule would introduce.
- **Per-action-type caps.** Different `max_eth_per_action` per type.
  Likes/recaws cheap; CAW/follow higher; tips/withdraw uncapped
  (amounts are user-chosen, not protocol-priced).

### Distribution splits (preserved at every price point)

From `CawActions.sol:1085-1126`:

| Action | Total | Receiver | Depositors | Notes |
| ------ | ----- | -------- | ---------- | ----- |
| CAW    | 5,000 | — | 5,000 (100%) | `spendAndDistributeTokens(senderId, 5000, 5000)` — no receiver, fully funds depositor pool |
| LIKE   | 2,000 | 1,600 (80%) | 400 (20%) | |
| RECAW  | 4,000 | 2,000 (50%) | 2,000 (50%) | |
| FOLLOW | 30,000 | 24,000 (80%) | 6,000 (20%) | receiver = followee |
| UNLIKE | 1,000 | 1,000 to validator (100%) | 0 | griefing floor |
| UNFOLLOW | 1,000 | 1,000 to validator (100%) | 0 | griefing floor |

When the cap binds, each of these breakdowns is scaled by
`scale_num/scale_den` and the percentages preserved.

### Proposed cap values (immutable constants)

Anchor LIKE = $0.01 at ETH = $5,000 (i.e. 2e11 wei). All other caps
derived by preserving today's baseline CAW ratios from
`CawActions.sol:1085-1126`:

| Action          | Baseline CAW | Ratio vs LIKE | `max_eth_per_action` (wei) | Notional at ETH=$5k |
| --------------- | ------------ | ------------- | -------------------------- | ------------------- |
| UNLIKE/UNFOLLOW | 1,000        | 0.5×          | 100,000,000,000 (1e11)     | $0.005              |
| LIKE            | 2,000        | 1×            | 200,000,000,000 (2e11)     | $0.01               |
| RECAW           | 4,000        | 2×            | 400,000,000,000 (4e11)     | $0.02               |
| CAW             | 5,000        | 2.5×          | 500,000,000,000 (5e11)     | $0.025              |
| FOLLOW          | 30,000       | 15×           | 3,000,000,000,000 (3e12)   | $0.15               |

These are notional ceilings — at today's CAW price the baseline is far
below the cap so it doesn't bind. By construction, when the cap *does*
bind, the relative cost of each action matches the relative cost today
(post is 2.5× a like; follow is 15× a like). FOLLOW at $0.15 reflects
that follows are a higher-value commitment than likes in the existing
economic design; if that ratio should change at scale, that's a
protocol-level conversation, not a cap-tuning one.

### Oracle

**Source.** A specific burned-LP Uniswap V2 CAW/WETH pair on Ethereum
mainnet. Pool address is an **immutable** constructor argument to the L1
oracle reader. If the pool ever dies (liquidity removed, contract
destroyed via the impossible — V2 has no selfdestruct), the cap goes
permanently dormant and baseline costs apply forever. Graceful failure.

Why V2 not V3:
- V2 pair is fully immutable, no admin, no fee switch that can drain
  pool (the `feeTo` switch only redirects 1/6 of LP fees to treasury)
- V2 TWAP is computed from `price0CumulativeLast` /
  `price1CumulativeLast` — two SLOADs at start and end of window, ~no
  gas to query
- Pool depth is fixed (LP burned), so manipulation cost is deterministic

V3 has `observe()` which is cleaner, but V3 oracle observations have a
ringbuffer size; if no one pokes the pool for `cardinality` ticks the
old data is gone. V2 cumulatives are unbounded.

**Window.** 7 days.

Manipulation cost: a burned-LP V2 pool with fixed depth `L`, to shift
TWAP by `x%` for `T` seconds, the attacker pays roughly `L · x²` to
displace spot plus 0.6% on every round-trip the arbitrageurs force them
into. At 12s blocks for 7 days that's 50,400 blocks of continuous
defense. Even on a thin pool (e.g. $5M TVL) a 50% sustained TWAP shift
runs into 7-figure attacker cost, and the only thing it buys them is
the right to spam at the wrong price — which still requires holding
real CAW.

### L1→L2 transport (opportunistic piggyback)

CAW lives on L2. The price is read on L1. We need to get the TWAP from
L1 to L2 without paying for a dedicated message per sample.

The protocol already sends L1→L2 messages routinely:
- `mintAndAuth` / `mintAndDepositAndQuickSign` (per new user)
- `deposit` (per CAW deposit to L2)
- `updateOwners` (per L1 NFT transfer batch)

Plan: every existing L1→L2 message carries a price sample as a piggyback
field. No new message types. No new LZ fees. The L2 maintains its own
running TWAP from these samples (TWAP-of-TWAP — more
manipulation-resistant, not less, since each sample is itself a 7-day
average).

#### Selector whitelist constraint

`CawProfile._lzReceive` (line 794) routes incoming L2-bound messages by
the first 4 bytes of the payload, then delegatecalls
`address(this).<selector>(args)`. The whitelist is in
`isAuthorizedFunction` (line 849):

```solidity
function isAuthorizedFunction(bytes4 selector) private pure returns (bool) {
  return selector == bytes4(keccak256("setWithdrawable(uint32[],uint256[])"));
}
```

The mirror exists on L2 too (`CawProfileL2._lzReceive`, line 962). Both
contracts are at or near the EIP-170 24,576-byte cap
(see `project_eip170_24576_cap.md`).

**Two viable strategies:**

**Strategy A: piggyback inside existing payloads.** Extend
`updateOwners(tokenIds, owners, stamps)` to
`updateOwners(tokenIds, owners, stamps, priceSample)` and similar for
the mint/deposit messages. Pros: no new selector, no whitelist change,
no extra calldata cost beyond the sample itself. Cons: every existing
message signature changes, which means every contract that constructs
these payloads on L1 and decodes them on L2 has to be updated in
lockstep. Pre-launch this is fine ([[project-pre-launch-freedom]]),
post-launch it's a hard fork.

**Strategy B: add a new whitelisted selector.** New
`recordPriceSample(uint128 priceX96, uint64 timestamp)` selector
(or include `priceCumulativeLast` so the L2 can do the TWAP math
itself). Pros: payload format for existing messages doesn't change.
Cons: 4 lines added to `isAuthorizedFunction`, new handler function on
L2, both contracts grow — and they're already at the cap.

**Decision: Strategy A.** Pre-launch we can change wire formats
freely, and the existing messages are already changing as the protocol
evolves. Adding 32 bytes to each payload is far cheaper than adding a
handler function and risking a tip over the 24,576 cap.

#### Selectors that gain the price-sample piggyback

Every L1→L2 message currently ends in
`(uint32[] tokenIds, address[] owners, uint64[] stamps)` — that's the
`updateOwners` payload tacked on for ownership-sync. The piggyback
extends each of these *seven* selectors to also carry
`(uint128 priceCumulativeLast, uint32 sampleTimestamp)`:

| Selector const | Defined at | New signature |
| -------------- | ---------- | ------------- |
| `mintSelector` | `CawProfile.sol:76` | `mintAndUpdateOwners(uint32,address,string,uint32[],address[],uint64[],uint128,uint32)` |
| `addToBalanceSelector` | `CawProfile.sol:78` | `depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[],uint64[],uint128,uint32)` |
| `authSelector` | `CawProfile.sol:79` | `authenticateAndUpdateOwners(uint32,uint32,uint32[],address[],uint64[],uint128,uint32)` |
| `updateOwnersSelector` | `CawProfile.sol:80` | `updateOwners(uint32[],address[],uint64[],uint128,uint32)` |
| `mintAuthSelector` | `CawProfile.sol:83` | `mintAuthAndUpdateOwners(uint32,uint32,address,string,uint32[],address[],uint64[],uint128,uint32)` |
| `depositRegisterSessionSelector` | `CawProfile.sol:89` | `depositAndRegisterSessionAndUpdateOwners(uint32,uint32,uint256,address,address,uint64,uint256,uint64,uint32[],address[],uint64[],uint128,uint32)` |
| `mintAuthRegisterSessionSelector` | `CawProfile.sol:93` | `mintAuthAndRegisterSessionAndUpdateOwners(uint32,uint32,address,string,address,uint64,uint256,uint64,uint32[],address[],uint64[],uint128,uint32)` |

Each L2-side handler in `CawProfileL2` gets the two trailing params and
calls `oracle.recordSample(priceCumulativeLast, sampleTimestamp)`
before dispatching to its existing logic.

#### L1 price reading: separate contract

`CawProfile` is at the EIP-170 cap
(`project_eip170_24576_cap.md`), so the price-read logic doesn't go
inline. A new immutable contract:

```solidity
contract CawL1PriceReader {
  IUniswapV2Pair public immutable pair;
  bool public immutable cawIsToken0;

  constructor(IUniswapV2Pair _pair, address cawToken) {
    pair = _pair;
    cawIsToken0 = (_pair.token0() == cawToken);
  }

  function readSample() external view returns (uint128 cumulative, uint32 timestamp) {
    // Read price0/price1CumulativeLast + reserves, advance the cumulative
    // by the unaccrued portion since last _update() if needed. Standard
    // UniV2 oracle trick — see Compound's UniswapAnchoredView or
    // OpenZeppelin's UniswapV2OracleLibrary.
  }
}
```

`CawProfile` holds an `immutable CawL1PriceReader priceReader` and
calls `priceReader.readSample()` once per L1→L2 send, splicing the
result into the outgoing payload. One external call (~2.5K gas worst
case), reader is independently testable, reader's pool address is the
single source of truth.

If the reader contract ever needs to be replaced (it won't — it's
immutable and read-only), the answer is: it can't. The pool address is
the lockdown point, exactly as designed.

#### Sample format

Each piggybacked sample is a `(uint128 priceCumulativeLast, uint32
blockTimestamp)` pair extracted from the burned-LP V2 pair's storage at
the time the L1 message is constructed. L2 stores `(cumulative,
timestamp)` pairs in a ring buffer and computes a 7-day TWAP from the
oldest entry within the window:

```
TWAP_eth_per_caw = (latest_cumulative - oldest_in_window_cumulative)
                 / (latest_timestamp  - oldest_in_window_timestamp)
```

Standard V2 TWAP math (the same thing apps like Compound's UniV2 oracle
do). Sample weighting is time-weighted by construction — each
cumulative is already the integral of price over time.

#### Stale-oracle behavior

If no L1 messages arrive for >24h (quiet protocol period), and CAW
price has moved meaningfully in the meantime, the L2 oracle is stale.

Policy: if `(now - latest_sample_timestamp) > 24 hours`, **the cap does
not bind** and baseline cost applies. Rationale: a stale low price
would falsely cap; a stale high price would falsely uncap. The
conservative choice for users is to default to baseline (the cap is a
ceiling, not a floor, so falling back to baseline can only make things
*more* expensive than the cap would, never less). Users may pay more
than the cap during the stale window, but they're guaranteed never to
be over-charged via stale price.

Optional escape hatch: a permissionless `pokeOracle()` on L1 that
constructs and ships a price-only L1→L2 message (caller pays the LZ
fee themselves). Not required for v1; can be added later if stale
windows are a real UX problem.

### Where the cap math lives

Three sites:

1. **`CawActions._applyAction`** (or wherever the per-type `actionCost`
   is set, lines 1087-1129). After the switch sets the baseline
   `actionCost`, take the min against `oracleCap.maxCostInCaw(actionType)`.
   This is the authoritative enforcement.

2. **`CawProfileL2` (or new `CawCapOracle` contract).** Stores the
   ring buffer of `(cumulative, timestamp)` samples and exposes
   `maxCostInCaw(actionType) → uint256`. New contract is cleaner
   (separate concern, doesn't bloat the cap-constrained L2 contract).

3. **FE pricing UI.** Shows the user the *effective* cost (post-cap),
   not the baseline. Reads from the same oracle contract via
   `eth_call`. Pre-check, not enforcement.

The contract-side enforcement is the source of truth; FE is UX.

## Failure modes

| Scenario | Behavior |
| -------- | -------- |
| Burned-LP pool dies | Cap permanently dormant, baseline applies forever |
| Oracle stale >24h | Cap dormant for the stale window, baseline applies |
| TWAP manipulation attempt | Uneconomic on burned-LP V2 over 7 days; even if successful, attacker only gets to spam at slightly favorable rates while still spending real CAW |
| LZ message delivery delay | Same as stale oracle — cap dormant, baseline applies |
| CAW price drops sharply | No floor — baseline applies, no protocol change |
| CAW price rises sharply | Cap activates, per-action CAW cost drops, ETH-notional cost stays constant |

## Implementation plan

1. **Deploy `CawCapOracle` on L2.** New contract, holds ring buffer +
   per-action-type immutable `maxEthPerAction` constants + cap math.
   Owner: none (renounceable, but no admin to begin with).

2. **Extend L1 → L2 message payloads.** Add 32-byte
   `(priceCumulativeLast, blockTimestamp)` field to each of:
   `setOwnersAndDepositTokens`, `setUsernameAndOwner`,
   `setUsernameAndOwnerAndDepositTokens`,
   `setUsernameAndOwnerAndDepositAndRegisterSession`,
   `setOwnersAndDepositAndRegisterSession`, `updateOwners`. Each L1
   send site reads the V2 pair's cumulative + timestamp inline.

3. **L2 receive sites call `oracle.recordSample(...)` before dispatching.**
   Cheap (one SSTORE + one ring-buffer increment).

4. **`CawActions._applyAction` calls `oracle.maxCostInCaw(actionType)`**
   and clamps `actionCost`. Single external call per action; can be
   cached per-batch via `BatchCursor`.

5. **FE shows post-cap cost.** Read once per session via `eth_call`,
   refresh when L2 receives a new sample (existing event indexing
   handles this).

6. **Tests.** Unit tests for ring buffer + TWAP math, integration tests
   for L1→L2 sample flow, end-to-end test for cap binding above a
   threshold CAW price.

## Open questions (decide before implementation)

- **Ring buffer size.** 7-day window with samples arriving on every L1
  message — depends on L1 message frequency. At ~100 L1 messages/day
  that's 700 samples; round up to 1024 for power-of-2 modulo math.
  Confirm against actual L1 message frequency at launch.

- **Sample-on-L1-only or also L2 self-pokes?** Cheapest: L1-only.
  Risk: long quiet periods → stale oracle. Default to L1-only, accept
  stale → baseline fallback. Add `pokeOracle()` later if needed.

- **Whose responsibility is it to read the pair on L1?** Cheapest: read
  in the same tx that ships the L1→L2 message. Adds 2 SLOADs to every
  user-paid L1 action — small but real. Alternative: a separate keeper
  that writes the latest sample to a known L1 storage slot, and L1
  send sites read that slot instead. Worse failure mode (keeper goes
  down), skip it.

- **Per-action-type cap values.** Numbers above are a strawman. Should
  be reviewed against the existing baseline ratios and the UX target
  ($0.01 likes at ETH=$5k) before being baked in as immutable
  constants.

## Related

- `project_pre_launch_freedom.md` — clean-break design preference, no
  compat shims, applies to the message-format change
- `project_eip170_24576_cap.md` — CawProfileL2 is at the cap, drives
  Strategy A over B
- `feedback_size_cap_first.md` — measure contract size before adding
  any code to size-capped contracts
- `feedback_minter_is_extension_point.md` — if cap math doesn't fit in
  CawProfileL2, a separate `CawCapOracle` is the extension point
- `project_lz_fee_buffer_150.md` — fee-buffer policy for LZ paths
- `project_l1l2_ownership_desync.md` — the L1→L2 message machinery this
  rides on
