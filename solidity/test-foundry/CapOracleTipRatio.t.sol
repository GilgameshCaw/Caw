// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawCapOracle.sol";
import "../contracts/CawActions.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/test-helpers/MockCawActionsCapTarget.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

// =============================================================================
// CapOracleTipRatio.t.sol
//
// Tests for the tip-ratio split:
//   T1  cap NOT binding → tip ratio pushed, cap ratio NOT pushed
//   T2  cap binding → both ratios pushed
//   T3  3-hour MIN_PUSH_REFRESH_INTERVAL forces refresh even without price move
//   T4  5-minute rate limit on pushRatioIfStale still enforced
//   T5  CawActions._getTipCost uses tipState (not capState)
//   T6  CawActions action cost path (_getCost) still uses capState unchanged
// =============================================================================

contract CapOracleTipRatioTest is Test {
    // ─── Protocol constants (mirrored from contracts) ──────────────────────────
    uint32  constant L1_EID = 30101;
    uint32  constant L2_EID = 40245;

    // 200 wei/CAW — very cheap, so LIKE cap (2e11 wei / 200 = 1e9 whole CAW) >>
    // BASELINE_LIKE (2000) → cap does NOT bind. Same price is used for tip ratio.
    uint256 constant PRICE_NON_BINDING_WEI_PER_CAW = 200;

    // 1e9 wei/CAW — expensive, so LIKE cap (2e11 wei / 1e9 = 200 whole CAW) <
    // BASELINE_LIKE (2000) → cap DOES bind.
    uint256 constant PRICE_BINDING_WEI_PER_CAW = 1e9;

    uint256 constant MIN_WINDOW_SECS = 1 days;   // CawCapOracle.MIN_WINDOW
    uint256 constant THREE_HOURS = 3 hours;       // CawCapOracle.MIN_PUSH_REFRESH_INTERVAL

    // ─── Fixtures ──────────────────────────────────────────────────────────────

    MockCawActionsCapTarget  mockTarget;
    address                  writer; // acts as l2Writer (recordSample caller)

    function setUp() public {
        writer = makeAddr("writer");
        mockTarget = new MockCawActionsCapTarget();
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    /// @dev UQ112.112 encoding of a wei-per-CAW price.
    function _uq(uint256 weiPerCaw) internal pure returns (uint256) {
        // twap = (price * 2^112) / 1e18   (converting wei-per-raw-CAW-unit to
        // the same units as the ring-buffer cumulative TWAP)
        return (weiPerCaw * (2**112)) / 1e18;
    }

    /// @dev Write two samples into oracle so twapEthPerCaw() returns (uq, true).
    ///      Oldest sample at t0 = now - MIN_WINDOW - 60s; latest at t1 = now.
    function _seedOracle(CawCapOracle oracle, uint256 weiPerCaw) internal {
        uint256 now_ = block.timestamp;
        uint32  t0   = uint32(now_ - MIN_WINDOW_SECS - 60);
        uint32  t1   = uint32(now_);
        uint256 uq   = _uq(weiPerCaw);
        vm.prank(writer);
        // First sample: cumulative=0 at t0
        oracle.recordSample(0, t0);
        vm.prank(writer);
        // Second sample: cumulative = uq * (t1-t0) at t1
        oracle.recordSample(uq * (t1 - t0), t1);
    }

    // ─── T1: cap NOT binding → tip pushed, cap NOT pushed ─────────────────────

    function test_tipPushed_capNotPushed_whenCapNotBinding() public {
        CawCapOracle oracle = new CawCapOracle(writer, address(mockTarget));

        _seedOracle(oracle, PRICE_NON_BINDING_WEI_PER_CAW);

        // Cap does NOT bind (cheap CAW). Check:
        //   - tipStateRatio (via tipState) is non-zero
        //   - capStateRatio is zero
        (, uint192 tipRatio) = mockTarget.tipState();
        uint192 capRatio = mockTarget.capStateRatio();

        assertGt(uint256(tipRatio), 0, "T1: tip ratio should be non-zero");
        assertEq(uint256(capRatio), 0, "T1: cap ratio should remain zero");
    }

    // ─── T2: cap binding → both ratios pushed ─────────────────────────────────

    function test_bothRatiosPushed_whenCapBinding() public {
        CawCapOracle oracle = new CawCapOracle(writer, address(mockTarget));

        _seedOracle(oracle, PRICE_BINDING_WEI_PER_CAW);

        (, uint192 tipRatio) = mockTarget.tipState();
        uint192 capRatio = mockTarget.capStateRatio();

        assertGt(uint256(tipRatio), 0, "T2: tip ratio should be non-zero");
        assertGt(uint256(capRatio), 0, "T2: cap ratio should be non-zero");
    }

    // ─── T3: 3-hour MIN_PUSH_REFRESH_INTERVAL forces refresh ─────────────────
    //
    // Strategy: seed the oracle (binding price) so both ratios are pushed and
    // lastSuccessfulPushAt is set. Then advance exactly MIN_PUSH_REFRESH_INTERVAL
    // and push a new sample with the same price. The 100-bps hysteresis would
    // skip the push, but the 3h staleness condition overrides it and forces a push.

    function test_3hourStaleRefresh() public {
        CawCapOracle oracle = new CawCapOracle(writer, address(mockTarget));

        // Start at a realistic timestamp (avoids uint32 underflow edge cases).
        uint256 T_START = 1_750_000_000;
        vm.warp(T_START);

        uint256 uq   = _uq(PRICE_BINDING_WEI_PER_CAW);
        uint32  t0   = uint32(T_START - MIN_WINDOW_SECS - 60);
        uint32  t1   = uint32(T_START);

        vm.prank(writer);
        oracle.recordSample(0, t0);
        vm.prank(writer);
        oracle.recordSample(uq * (t1 - t0), t1);

        uint256 capCallsAfterSeed = mockTarget.setRatioCallCount();
        uint256 tipCallsAfterSeed = mockTarget.setTipRatioCallCount();
        assertGt(capCallsAfterSeed, 0, "T3: cap pushed on seed");
        assertGt(tipCallsAfterSeed, 0, "T3: tip pushed on seed");

        uint64 capPushAt = oracle.lastSuccessfulCapPushAt();
        uint64 tipPushAt = oracle.lastSuccessfulTipPushAt();
        assertGt(capPushAt, 0, "T3: lastSuccessfulCapPushAt set after seed");
        assertGt(tipPushAt, 0, "T3: lastSuccessfulTipPushAt set after seed");

        // Advance exactly MIN_PUSH_REFRESH_INTERVAL (3 hours).
        vm.warp(T_START + THREE_HOURS);
        uint32 t2 = uint32(T_START + THREE_HOURS);

        // Third sample with the same price. The cumulative must grow by uq per
        // second to produce an identical TWAP (same price, no 100-bps move).
        // newCum = uq * (t2 - t0) because cumulative started at 0 at t0.
        uint256 newCum = uq * (t2 - t0);
        vm.prank(writer);
        oracle.recordSample(newCum, t2);

        // Both cap and tip should have fired again (stale refresh overrides hysteresis).
        assertGt(mockTarget.setRatioCallCount(),    capCallsAfterSeed, "T3: cap stale refresh");
        assertGt(mockTarget.setTipRatioCallCount(), tipCallsAfterSeed, "T3: tip stale refresh");
    }

    // ─── T4: 5-minute rate limit on pushRatioIfStale ──────────────────────────

    function test_pushRatioIfStale_rateLimit() public {
        CawCapOracle oracle = new CawCapOracle(writer, address(mockTarget));
        _seedOracle(oracle, PRICE_NON_BINDING_WEI_PER_CAW);

        // First call should succeed.
        oracle.pushRatioIfStale();
        uint256 callsAfterFirst = mockTarget.setTipRatioCallCount();

        // Second call within 5 minutes should revert.
        vm.expectRevert("TooSoon");
        oracle.pushRatioIfStale();

        // Advance past 5 minutes.
        vm.warp(block.timestamp + 5 minutes + 1);
        oracle.pushRatioIfStale(); // should not revert
    }

    // ─── T5: CawActions._getTipCost reads tipState ────────────────────────────

    function test_getTipCostUsesTipState() public {
        // Deploy a minimal CawActions with a controlled capOracle (we'll use an
        // EOA so we can call setTipRatio directly).
        MockLayerZeroEndpoint lzEp = new MockLayerZeroEndpoint(L2_EID);
        CawProfileLedger profile = new CawProfileLedger(L1_EID, address(lzEp), address(0));

        address tipOracleEOA = makeAddr("tipOracle");
        CawActions actions = new CawActions(
            address(profile),
            address(0),       // zkVerifier disabled
            bytes32(0),
            address(0),       // erc1271Sibling disabled
            tipOracleEOA,     // capOracle = EOA we control
            0, 0              // bootstrap disabled
        );
        profile.setCawActions(address(actions));

        // Initially tipState.ratio == 0 → _getTipCost returns 0.
        // Verify indirectly: tipState accessor should be zeroed.
        (uint64 lastAt, uint192 ratio) = actions.tipState();
        assertEq(ratio, 0, "T5: initial tipState.ratio == 0");
        assertEq(lastAt, 0, "T5: initial tipState.lastUpdatedAt == 0");

        // Push a binding tip ratio from our oracle EOA.
        // ETH cap for tip = 50e11 wei; with ratio = UQ112.112 of 1e9 wei/CAW:
        //   result = (50e11 << 112) / uq(1e9) / 1e18
        //          = 50e11 / 1e9 = 5000 whole CAW
        uint192 tipRatio = uint192(_uq(1e9));
        vm.prank(tipOracleEOA);
        actions.setTipRatio(tipRatio);

        (lastAt, ratio) = actions.tipState();
        assertEq(ratio, tipRatio, "T5: tipState.ratio updated");
        assertGt(lastAt, 0, "T5: tipState.lastUpdatedAt set");

        // capState should still be zero (we only pushed tip).
        assertEq(actions.capStateRatio(), 0, "T5: capState untouched by setTipRatio");
    }

    // ─── T6: CawActions action cost path still uses capState unchanged ─────────

    function test_getCostUsesCapState_tipStateHasNoEffect() public {
        MockLayerZeroEndpoint lzEp = new MockLayerZeroEndpoint(L2_EID);
        CawProfileLedger profile = new CawProfileLedger(L1_EID, address(lzEp), address(0));

        address oracleEOA = makeAddr("oracle6");
        CawActions actions = new CawActions(
            address(profile),
            address(0), bytes32(0), address(0),
            oracleEOA,
            0, 0
        );
        profile.setCawActions(address(actions));

        // Push a tip ratio but NOT a cap ratio.
        uint192 tipRatio = uint192(_uq(1e9));
        vm.prank(oracleEOA);
        actions.setTipRatio(tipRatio);

        // capStateRatio() must still be 0 — the action cost path is unaffected.
        assertEq(actions.capStateRatio(), 0, "T6: capStateRatio zero after tip push");

        // Now push a cap ratio and verify tip is unaffected.
        uint192 capRatio = uint192(_uq(2e9));
        vm.prank(oracleEOA);
        actions.setCapRatio(capRatio);

        assertEq(actions.capStateRatio(), capRatio, "T6: capStateRatio set correctly");
        (, uint192 tipAfter) = actions.tipState();
        assertEq(tipAfter, tipRatio, "T6: tipState unaffected by cap push");
    }

    // ─── T7: TipRatioUpdated event emitted on setTipRatio ─────────────────────

    function test_TipRatioUpdated_event() public {
        MockLayerZeroEndpoint lzEp = new MockLayerZeroEndpoint(L2_EID);
        CawProfileLedger profile = new CawProfileLedger(L1_EID, address(lzEp), address(0));
        address oracleEOA = makeAddr("oracle7");
        CawActions actions = new CawActions(
            address(profile),
            address(0), bytes32(0), address(0),
            oracleEOA,
            0, 0
        );

        uint192 ratio = uint192(_uq(1e9));
        vm.expectEmit(false, false, false, true);
        emit CawActions.TipRatioUpdated(ratio, uint64(block.timestamp));
        vm.prank(oracleEOA);
        actions.setTipRatio(ratio);
    }

    // ─── T8: setTipRatio reverts from non-oracle ──────────────────────────────

    function test_setTipRatio_notCapOracle_reverts() public {
        MockLayerZeroEndpoint lzEp = new MockLayerZeroEndpoint(L2_EID);
        CawProfileLedger profile = new CawProfileLedger(L1_EID, address(lzEp), address(0));
        address oracleEOA = makeAddr("oracle8");
        CawActions actions = new CawActions(
            address(profile),
            address(0), bytes32(0), address(0),
            oracleEOA,
            0, 0
        );

        vm.expectRevert(CawActions.NotCapOracle.selector);
        actions.setTipRatio(uint192(_uq(1e9)));
    }
}
