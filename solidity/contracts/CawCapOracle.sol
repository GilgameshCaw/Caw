// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CawCapOracle
/// @notice L2-side oracle that maintains a ring buffer of price samples
///         piggybacked on L1→L2 messages, computes a 7-day TWAP, and
///         returns the per-action CAW cap when the cap binds.
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

  // ─── Errors / Events ──────────────────────────────────────────────────────

  event SampleRecorded(uint64 indexed index, uint256 cumulative, uint32 timestamp);

  /// @notice Only CawProfileL2 may write samples. Set in constructor,
  ///         immutable thereafter.
  address public immutable l2Writer;

  error UnauthorizedWriter();
  error TimestampNotMonotonic();

  // ─── Constructor ──────────────────────────────────────────────────────────

  /// @param _l2Writer Address of CawProfileL2 (the only contract permitted
  ///                  to call `recordSample`).
  constructor(address _l2Writer) {
    require(_l2Writer != address(0), "writer zero");
    l2Writer = _l2Writer;
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

    // ethCap is in wei; twap is UQ112.112 of WETH-per-CAW.
    //   wei_per_caw = twap / 2^112 (gives WETH-per-CAW as a regular ratio)
    //   caw_per_action_at_cap = ethCap / wei_per_caw
    //                         = ethCap * 2^112 / twap
    //
    // Result is whole CAW (the unit `baseline` and `actionCost` use in
    // CawActions). Multiplication by 2^112 first ensures no precision loss
    // for sub-1 CAW results; ethCap is ≤ ~3e12, twap is ≤ 2^224, so
    // ethCap << 112 fits in uint256 with headroom.
    uint256 ethCapShifted = ethCap << 112;
    uint256 cappedCaw = ethCapShifted / twap;

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

    unchecked {
      // V2 cumulatives can wrap (uint256); subtraction in unchecked block
      // gives the right window delta either way.
      uint256 cumDelta = uint256(latest.cumulative) - uint256(oldest.cumulative);
      uint256 timeDelta = uint256(latest.timestamp - oldest.timestamp);
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
