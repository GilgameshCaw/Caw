// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ICawActions.sol";

/// @title CawCapOracle
/// @notice L2-side oracle that maintains a ring buffer of price samples
///         piggybacked on L1→L2 messages, computes a 7-day TWAP, and
///         **pushes** the resulting ratio to CawActions whenever the cap
///         state changes. CawActions then reads it from storage — zero
///         external calls per action (vs one STATICCALL per action before).
///
///         The oracle is **immutable and admin-less**. Pool address lives in
///         CawL1PriceReader on L1; the L2 side just consumes samples and does
///         the math. If the source pool dies the cumulative stops advancing,
///         the TWAP becomes meaningless within ~7 days, and the >24h-stale
///         policy makes the cap permanently dormant.
///
/// @dev    Sample storage: ring buffer of (cumulative, timestamp) pairs.
///         Power-of-2 sized so indexing is `idx & (SIZE-1)`. Sized for the
///         expected L1→L2 message rate; if it overflows old samples are
///         overwritten — fine, the TWAP only looks at the oldest sample
///         within the 7-day window.
///
///         Per-action caps are immutable constants. The full economic model
///         (which actions cap, at what ETH ceiling) is baked at deploy time.
///
/// @dev    Audit-trail tags in this contract (e.g. "H-N", "M-N", "Round N",
///         "Audit fix YYYY-MM-DD") are decoded in `docs/AUDIT_TRAIL.md`.
contract CawCapOracle {
  // ─── Constants ────────────────────────────────────────────────────────────

  /// @notice TWAP window. Manipulation cost on a burned-LP V2 pair over this
  ///         length is uneconomic by orders of magnitude.
  uint256 public constant TWAP_WINDOW = 7 days;

  /// @notice If the most recent sample is older than this, the cap is treated
  ///         as dormant and baseline action costs apply. Conservative because
  ///         a stale low price would falsely cap users to a too-cheap CAW
  ///         amount; falling back to baseline can only over-charge, never
  ///         under-charge relative to the cap.
  uint256 public constant STALE_THRESHOLD = 24 hours;

  /// @notice Minimum span between the oldest and latest samples before TWAP is
  ///         considered "fresh." Stops the cap from binding based on a
  ///         too-short window (e.g. a burst of samples within an hour).
  ///         Together with the per-window dilution of any single manipulated
  ///         sample, this ensures the TWAP reflects an actual price-discovery
  ///         period before kicking in.
  uint256 public constant MIN_WINDOW = 1 days;

  /// @notice Ring buffer size. Power of 2 for cheap modular indexing.
  ///         Sized for ~700 samples in a 7-day window (≈100 L1→L2 msgs/day);
  ///         oversized 1024 gives headroom without paying for empty slots.
  uint256 public constant BUFFER_SIZE = 1024;
  uint256 private constant BUFFER_MASK = BUFFER_SIZE - 1;

  /// @notice Per-action ETH-denominated cost ceilings (in wei).
  ///         Anchored to LIKE = $0.01 at ETH = $5,000 (i.e. 2e11 wei),
  ///         other actions ratioed off LIKE using today's baseline CAW
  ///         amounts from CawActions.sol:1085-1126.
  ///
  ///         Values are immutable. If protocol economics need to change, the
  ///         oracle is redeployed (cap-only — the protocol works fine without
  ///         the oracle).
  uint256 public constant CAP_LIKE              =   2e11; //  $0.01 @ ETH=$5k
  uint256 public constant CAP_RECAW             =   4e11; //  $0.02
  uint256 public constant CAP_CAW               =   5e11; //  $0.025
  uint256 public constant CAP_FOLLOW            =  30e11; //  $0.15
  uint256 public constant CAP_UNLIKE_UNFOLLOW   =   1e11; //  $0.005

  /// @notice Baseline CAW amounts per action (the manifesto numbers).
  ///         Mirrored from CawActions for the scale computation. Must be
  ///         kept in sync with CawActions._applyAction — if you change a
  ///         baseline there, change it here too. Tests cover this by
  ///         asserting `oracle.baselineFor(t) == actions._applyAction
  ///         constant for t`.
  uint256 public constant BASELINE_LIKE              =  2_000;
  uint256 public constant BASELINE_RECAW             =  4_000;
  uint256 public constant BASELINE_CAW               =  5_000;
  uint256 public constant BASELINE_FOLLOW            = 30_000;
  uint256 public constant BASELINE_UNLIKE_UNFOLLOW   =  1_000;

  // ─── Storage ──────────────────────────────────────────────────────────────

  /// @dev Packed sample: 192 bits cumulative (truncated from UQ112.112,
  ///      enough precision over a 7-day window) + 32 bits timestamp.
  ///      Single SSTORE per sample.
  struct Sample {
    uint224 cumulative;
    uint32  timestamp;
  }

  Sample[BUFFER_SIZE] private buf;

  /// @notice Index of the next slot to write. `samplesWritten % BUFFER_SIZE`
  ///         is the write position; once `samplesWritten >= BUFFER_SIZE`,
  ///         all slots are populated.
  uint64 public samplesWritten;

  /// @notice Timestamp of the last time _maybePushCapRatio or _maybePushTipRatio
  ///         was entered (whether or not it ultimately pushed a new ratio). Used
  ///         by pushRatioIfStale to rate-limit permissionless callers. Updated on
  ///         every path that enters the push logic — both the recordSample
  ///         trampoline and the external pushRatioIfStale function — so the
  ///         5-minute interval applies uniformly across both callers.
  uint64 public lastPushAttemptAt;

  /// @notice Timestamp of the last successful CAP-ratio push to CawActions.
  ///         L-1 audit fix: separate from the tip-push timer so neither path
  ///         starves the other's 3-hour heartbeat. Previously a single shared
  ///         lastSuccessfulPushAt meant frequent cap pushes (volatile market
  ///         with cap binding) would suppress the tip 3-hour refresh and
  ///         vice versa.
  uint64 public lastSuccessfulCapPushAt;

  /// @notice Timestamp of the last successful TIP-ratio push to CawActions.
  ///         L-1 audit fix sibling — independent heartbeat for the tip path.
  uint64 public lastSuccessfulTipPushAt;

  /// @notice Minimum interval between organic pushes. If neither the cap nor
  ///         the tip ratio moved more than 100 bps, a push still fires after
  ///         this interval so CawActions doesn't hold ancient state.
  uint64 public constant MIN_PUSH_REFRESH_INTERVAL = 3 hours;

  // ─── Errors / Events ──────────────────────────────────────────────────────

  event SampleRecorded(uint64 indexed index, uint256 cumulative, uint32 timestamp);

  /// @notice Only CawProfileL2 may write samples. Set in constructor,
  ///         immutable thereafter.
  address public immutable l2Writer;

  /// @notice CawActions contract to which this oracle pushes ratio updates.
  ///         Required (non-zero). The oracle actively calls setCapRatio on
  ///         every sample that produces a cap-state change.
  ICawActions public immutable cawActions;

  error UnauthorizedWriter();
  error TimestampNotMonotonic();

  // ─── Constructor ──────────────────────────────────────────────────────────

  /// @param _l2Writer   Address of CawProfileL2 (the only contract permitted
  ///                    to call `recordSample`).
  /// @param _cawActions Address of CawActions (required; receives setCapRatio
  ///                    calls when the cap state changes).
  constructor(address _l2Writer, address _cawActions) {
    require(_l2Writer != address(0), "writer zero");
    require(_cawActions != address(0), "cawActions zero");
    l2Writer = _l2Writer;
    cawActions = ICawActions(_cawActions);
  }

  // ─── Sample ingestion ─────────────────────────────────────────────────────

  /// @notice Record a price sample. Called by CawProfileL2 from each
  ///         L1→L2 message handler before dispatching the message's
  ///         primary effect.
  /// @dev    Silently no-ops on non-monotonic timestamps. LayerZero doesn't
  ///         guarantee ordering across messages from different L1 txs, so
  ///         out-of-order delivery is possible. The TWAP just skips
  ///         out-of-order samples rather than corrupting state.
  function recordSample(uint256 cumulative, uint32 timestamp) external {
    if (msg.sender != l2Writer) revert UnauthorizedWriter();

    // Reject samples older than the most recent. Out-of-order delivery is
    // legal in LZ and shouldn't poison the TWAP.
    uint64 nextIdx = samplesWritten;
    if (nextIdx > 0) {
      Sample memory prev = buf[(nextIdx - 1) & BUFFER_MASK];
      if (timestamp <= prev.timestamp) return; // silent skip
    }

    // Truncate cumulative to 224 bits. UQ112.112 over 7 days at any plausible
    // CAW/WETH price fits in <140 bits; 224 gives massive headroom.
    buf[nextIdx & BUFFER_MASK] = Sample({
      cumulative: uint224(cumulative),
      timestamp: timestamp
    });
    samplesWritten = nextIdx + 1;

    emit SampleRecorded(nextIdx, cumulative, timestamp);

    // Push ratio to CawActions if the cap state has changed. A revert inside
    // _maybePushRatio (e.g. CawActions OOG or unexpected revert) is caught
    // here so sample ingestion always succeeds — the outer try/catch in
    // CawProfileL2._lzReceive preserves L2 delivery and the STALE_THRESHOLD
    // backstop in CawActions makes the cap dormant within 24 h, bounding
    // exposure to a single missed push cycle.
    // solhint-disable-next-line no-empty-blocks
    (bool ok,) = address(this).call(abi.encodeWithSelector(this._maybePushRatioExternal.selector));
    // Ignore ok — a failed push is intentionally swallowed; see comment above.
    ok; // silence unused-variable warning
  }

  /// @dev External trampoline so the call above can catch reverts. Only
  ///      callable from this contract itself; any other caller is rejected.
  function _maybePushRatioExternal() external {
    require(msg.sender == address(this), "self-only");
    lastPushAttemptAt = uint64(block.timestamp);
    _maybePushCapRatio();
    _maybePushTipRatio();
  }

  /// @notice Permissionless freshness-recovery entry point.
  ///
  ///         Problem addressed (H-9/H-10): `_maybePushRatio` is normally
  ///         triggered only by `recordSample`, which is itself triggered by
  ///         incoming L1→L2 LayerZero messages. If the L1 chain is idle for
  ///         >24 h, no fresh sample arrives and CawActions retains a stale
  ///         ratio for up to 48 h (24 h oracle staleness + 24 h CawActions
  ///         backstop) before the cap goes dormant.
  ///
  ///         This function lets any account trigger a ratio evaluation with no
  ///         special permissions. Two guards keep it spam-free:
  ///          1. 5-minute rate limit via `lastPushAttemptAt` — callers who
  ///             invoke more frequently than once every 5 minutes waste their
  ///             own gas and get nothing.
  ///          2. The existing hysteresis check inside `_maybePushRatio`
  ///             (100 bps threshold) — if the ratio hasn't moved materially,
  ///             no external call to CawActions is made.
  ///
  ///         The function does not guarantee that a push will occur; it simply
  ///         ensures the oracle re-evaluates its current TWAP and pushes only
  ///         if warranted. In the idle-chain scenario, the most recent samples
  ///         are already in the buffer; this call just re-runs the evaluation
  ///         that `recordSample` would have triggered if a new message arrived.
  function pushRatioIfStale() external {
    require(block.timestamp >= lastPushAttemptAt + 5 minutes, "TooSoon");
    lastPushAttemptAt = uint64(block.timestamp);
    _maybePushCapRatio();
    _maybePushTipRatio();
  }

  // ─── Push-ratio logic ────────────────────────────────────────────────────────

  /// @dev Evaluate whether the cap state has changed enough to warrant a push.
  ///      Called after every successful sample write. Reads the current stored
  ///      ratio from CawActions (one external view call) to decide:
  ///       - oracle stale / under-populated → push 0 if currently non-zero
  ///       - cap doesn't bind              → push 0 if currently non-zero
  ///       - cap binds + moved > 100 bps   → push new ratio
  ///       - cap binds + within 100 bps    → no-op (hysteresis, unless 3h stale)
  function _maybePushCapRatio() internal {
    (uint256 newRatio, bool fresh) = twapEthPerCaw();

    uint192 currentRatio = cawActions.capStateRatio();

    if (!fresh) {
      // Oracle stale or under-populated. If CawActions has a live ratio,
      // clear it so the cap goes dormant. Otherwise no-op.
      if (currentRatio != 0) {
        cawActions.setCapRatio(0);
        lastSuccessfulCapPushAt = uint64(block.timestamp);
      }
      return;
    }

    // Use LIKE as the binding probe. If LIKE doesn't bind, no action type binds
    // (it has the tightest ETH ceiling per-CAW). CAP_LIKE = 2e11 wei.
    uint256 likeCap = (CAP_LIKE << 112) / newRatio / 1e18;
    bool bindsNow = likeCap < BASELINE_LIKE;

    if (!bindsNow) {
      // Cap currently not binding. Clear stored ratio if non-zero.
      if (currentRatio != 0) {
        cawActions.setCapRatio(0);
        lastSuccessfulCapPushAt = uint64(block.timestamp);
      }
      return;
    }

    // Cap binds. Push if: ratio moved > 100 bps, transitioning from dormant,
    // or 3-hour stale refresh (so CawActions never holds ancient state).
    bool staleRefresh = block.timestamp - lastSuccessfulCapPushAt >= MIN_PUSH_REFRESH_INTERVAL;
    if (currentRatio == 0 || _movedMoreThanBps(uint256(currentRatio), newRatio, 100) || staleRefresh) {
      // H-8: explicit overflow guard before narrowing cast.
      // At astronomical CAW prices the UQ112.112 TWAP could theoretically exceed
      // uint192.max (≈ 6.28e57); silent truncation would push a wrong ratio to
      // CawActions. Revert instead — the cap goes dormant (safe side).
      require(newRatio <= type(uint192).max, "RatioOverflow");
      cawActions.setCapRatio(uint192(newRatio));
      lastSuccessfulCapPushAt = uint64(block.timestamp);
    }
  }

  /// @dev Evaluate whether the tip state should be pushed to CawActions.
  ///      Unlike _maybePushCapRatio, there is NO bindsNow gate — the tip ratio
  ///      is pushed whenever the TWAP is fresh and one of these is true:
  ///       - currentTipRatio == 0      (oracle activating from dormant)
  ///       - ratio moved > 100 bps     (price moved materially)
  ///       - >= MIN_PUSH_REFRESH_INTERVAL since last successful push (stale refresh)
  ///      When the TWAP is stale / under-populated, push 0 to clear if non-zero.
  function _maybePushTipRatio() internal {
    (uint256 newRatio, bool fresh) = twapEthPerCaw();

    (, uint192 currentTipRatio) = cawActions.tipState();

    if (!fresh) {
      // Oracle stale or under-populated. Clear if CawActions has a live tip ratio.
      if (currentTipRatio != 0) {
        cawActions.setTipRatio(0);
        lastSuccessfulTipPushAt = uint64(block.timestamp);
      }
      return;
    }

    // Push if: activating from dormant, ratio moved significantly, OR 3-hour refresh.
    bool shouldPush = (currentTipRatio == 0)
      || _movedMoreThanBps(uint256(currentTipRatio), newRatio, 100)
      || (block.timestamp - lastSuccessfulTipPushAt >= MIN_PUSH_REFRESH_INTERVAL);

    if (shouldPush) {
      require(newRatio <= type(uint192).max, "RatioOverflow");
      cawActions.setTipRatio(uint192(newRatio));
      lastSuccessfulTipPushAt = uint64(block.timestamp);
    }
  }

  /// @dev Returns true if the ratio moved by more than `bps` basis points.
  function _movedMoreThanBps(uint256 oldR, uint256 newR, uint256 bps) internal pure returns (bool) {
    if (oldR == 0) return true;
    uint256 diff = newR > oldR ? newR - oldR : oldR - newR;
    return diff * 10000 > oldR * bps;
  }

  // ─── TWAP + cap ───────────────────────────────────────────────────────────

  /// @notice Returns the per-action CAW cap for a given baseline CAW amount
  ///         + per-action ETH ceiling. Caller passes both so this contract
  ///         doesn't need to know about action types directly.
  ///
  ///         If the oracle is stale or under-populated, returns `baseline`
  ///         (cap dormant). Otherwise returns `min(baseline, ethCap / twap)`.
  ///
  /// @param  baseline   Manifesto CAW amount for the action.
  /// @param  ethCap     ETH-denominated ceiling for the action (wei).
  /// @return capped     Effective CAW cost after applying the cap.
  function capForAction(uint256 baseline, uint256 ethCap) public view returns (uint256 capped) {
    (uint256 twap, bool fresh) = twapEthPerCaw();
    if (!fresh || twap == 0) return baseline; // dormant fallback

    // Units walk-through.
    //   twap   : UQ112.112 of (WETH-raw / CAW-raw), where both reserves are
    //            raw-token units (i.e. 18-decimal wei). So twap × 2^-112 is
    //            "wei per raw-CAW-unit (1e-18 CAW)".
    //   ethCap : wei (atto-ETH).
    //
    // What we want:
    //   capped_whole_caw = ethCap_wei / wei_per_whole_caw
    //   wei_per_whole_caw = wei_per_raw_caw × 1e18 = (twap × 2^-112) × 1e18
    //   → capped_whole_caw = ethCap × 2^112 / (twap × 1e18)
    //
    // Order of ops: shift first (no precision loss; shift fits since
    // ethCap ≤ ~3e12, ethCap << 112 ≤ ~1.5e46 << 2^256), then divide.
    uint256 cappedCaw = (ethCap << 112) / twap / 1e18;

    // Floor at 1 whole CAW. If twap is so high that capped_whole_caw rounds
    // to 0, the user would otherwise pay nothing — violates "actions always
    // cost something" and short-circuits the depositor distribution.
    if (cappedCaw == 0) cappedCaw = 1;

    return cappedCaw < baseline ? cappedCaw : baseline;
  }

  /// @notice 7-day TWAP of WETH-per-CAW as UQ112.112. `fresh` is false if
  ///         the oracle is stale or doesn't have enough history; callers
  ///         should fall back to baseline costs in that case.
  function twapEthPerCaw() public view returns (uint256 twap, bool fresh) {
    uint64 nextIdx = samplesWritten;
    if (nextIdx < 2) return (0, false); // need ≥ 2 samples

    Sample memory latest = buf[(nextIdx - 1) & BUFFER_MASK];

    // Staleness check: the most recent sample must be within STALE_THRESHOLD.
    if (block.timestamp > latest.timestamp + STALE_THRESHOLD) return (0, false);

    // Find the oldest sample within the TWAP_WINDOW. Walk backward from
    // latest-1 until we either fall off the populated range or find a
    // sample older than `latest.timestamp - TWAP_WINDOW`.
    uint64 oldestIdx;
    bool foundWindowAnchor = false;
    uint64 cursor = nextIdx - 1;
    uint64 maxScan = nextIdx > BUFFER_SIZE ? uint64(BUFFER_SIZE) : nextIdx;

    // Early protocol life: if latest.timestamp < TWAP_WINDOW, no sample can
    // possibly be old enough to anchor the window. Skip the search and fall
    // through to "use the oldest we have." (We can't compute
    // `latest.timestamp - TWAP_WINDOW` directly without underflow — and the
    // unchecked wrap would silently false-positive in the comparison below,
    // anchoring on a too-recent sample.)
    if (uint256(latest.timestamp) >= TWAP_WINDOW) {
      uint32 windowStart = latest.timestamp - uint32(TWAP_WINDOW);

      for (uint64 i = 1; i < maxScan; i++) {
        uint64 probe = cursor - i;
        Sample memory s = buf[probe & BUFFER_MASK];
        if (s.timestamp == 0) break; // unwritten slot (early life)
        if (s.timestamp <= windowStart) {
          oldestIdx = probe;
          foundWindowAnchor = true;
          break;
        }
      }
    }

    Sample memory oldest;
    if (foundWindowAnchor) {
      oldest = buf[oldestIdx & BUFFER_MASK];
    } else {
      // No sample old enough to anchor a full window — use the oldest we have.
      // Acceptable in early protocol life: the window just starts at the
      // first-ever sample. As history accumulates the window converges.
      uint64 oldestAvailable;
      if (nextIdx > BUFFER_SIZE) {
        oldestAvailable = nextIdx - uint64(BUFFER_SIZE);
      } else {
        oldestAvailable = 0;
      }
      oldest = buf[oldestAvailable & BUFFER_MASK];
    }

    if (oldest.timestamp >= latest.timestamp) return (0, false);

    // M-1: enforce a minimum spread between oldest and latest. Stops the cap
    // from binding off a too-short window (e.g. only a few hours of history
    // available right after deploy, or after a long quiet period the buffer
    // happens to be densely-packed near `latest`). Combined with the natural
    // per-sample dilution of any single manipulated sample, this is what
    // makes the manipulate-one-sample attack uneconomic — the TWAP averages
    // across ≥1 day of price action regardless.
    uint256 timeDelta = uint256(latest.timestamp - oldest.timestamp);
    if (timeDelta < MIN_WINDOW) return (0, false);

    unchecked {
      // C-2 fix: V2 `priceCumulativeLast` is uint256 and wraps mod 2^256;
      // consumers recover the delta by unchecked subtraction. We store the
      // low 224 bits of the cumulative in `Sample.cumulative`, so a wrap
      // through the 2^224 boundary mid-window would surface here as
      // `latest.cumulative < oldest.cumulative` in 224-bit space, and an
      // unchecked uint256 subtract would produce 2^256 − 2^224 + (true delta).
      // Mask to 224 bits to recover the true delta in our truncated space.
      //
      // Per-window bound: at any plausible WETH-per-CAW price the cumulative
      // growth over 7 days is < 2^140 (UQ112.112 of a sub-1e18 fraction times
      // 604800 seconds), so the true delta fits comfortably in 224 bits and
      // masking is lossless. If the pair somehow produces a per-window delta
      // ≥ 2^224, the mask would silently truncate, but reaching that requires
      // sustained reserves so extreme they imply pool death — in which case
      // the staleness path catches it within a day anyway.
      uint256 cumDelta = (uint256(latest.cumulative) - uint256(oldest.cumulative)) & ((uint256(1) << 224) - 1);
      twap = cumDelta / timeDelta;
    }
    fresh = true;
  }

  // ─── Convenience: typed caps per action ──────────────────────────────────

  function capLike() external view returns (uint256) {
    return capForAction(BASELINE_LIKE, CAP_LIKE);
  }
  function capRecaw() external view returns (uint256) {
    return capForAction(BASELINE_RECAW, CAP_RECAW);
  }
  function capCaw() external view returns (uint256) {
    return capForAction(BASELINE_CAW, CAP_CAW);
  }
  function capFollow() external view returns (uint256) {
    return capForAction(BASELINE_FOLLOW, CAP_FOLLOW);
  }
  function capUnlikeUnfollow() external view returns (uint256) {
    return capForAction(BASELINE_UNLIKE_UNFOLLOW, CAP_UNLIKE_UNFOLLOW);
  }
}
