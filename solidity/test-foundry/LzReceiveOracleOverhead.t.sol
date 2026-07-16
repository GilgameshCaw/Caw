// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// =============================================================================
// LzReceiveOracleOverhead.t.sol
//
// Measures the PER-MESSAGE oracle overhead that CawProfileLedger._lzReceive
// pays on EVERY L1->L2 message, on top of the inner handler (e.g. _setOwnerOf).
//
// Root cause of the transferAndSync OOG (zinsanjp): the gas-budget test suite
// (LzGasBudgetAudit.t.sol) measures only the inner handler's storage writes, not
// the _lzReceive wrapper. Before dispatching, _lzReceive runs a
// capOracle.recordSample() piggyback. On the live L2 the oracle is wired, so
// that path executes: ring-buffer SSTOREs + _maybePushCapRatio / _maybePushTipRatio,
// each of which reads and may WRITE CawActions (setCapRatio / setTipRatio) —
// tens of thousands of gas, charged against the same enforced LZ budget.
//
// This test measures that overhead in its WORST case (a fresh monotonic sample
// that crosses the binding threshold so both cap+tip pushes fire) so gasBaseFor
// can be set to cover the full receive path, not just the handler.
// =============================================================================

import "forge-std/Test.sol";
import "../contracts/CawCapOracle.sol";
import "../contracts/test-helpers/MockCawActionsCapTarget.sol";

contract LzReceiveOracleOverheadTest is Test {
    MockCawActionsCapTarget mockTarget;
    address writer;

    uint256 constant PRICE_BINDING_WEI_PER_CAW = 1e9; // cap binds → setCapRatio fires
    uint256 constant MIN_WINDOW_SECS = 1 days;        // CawCapOracle.MIN_WINDOW

    function setUp() public {
        writer = makeAddr("writer");
        mockTarget = new MockCawActionsCapTarget();
        vm.warp(1_750_000_000);
    }

    function _uq(uint256 weiPerCaw) internal pure returns (uint256) {
        return (weiPerCaw * (2 ** 112)) / 1e18;
    }

    // Worst-case per-message oracle overhead: measure the SECOND recordSample
    // (the one that completes the TWAP window, crosses the binding threshold,
    // and drives setCapRatio + setTipRatio pushes into CawActions). This is the
    // marginal cost _lzReceive adds beyond the inner handler on a live-oracle L2.
    function test_recordSample_worstCase_gas() public {
        CawCapOracle oracle = new CawCapOracle(writer, address(mockTarget));

        uint256 now_ = block.timestamp;
        uint32 t0 = uint32(now_ - MIN_WINDOW_SECS - 60);
        uint32 t1 = uint32(now_);
        uint256 uq = _uq(PRICE_BINDING_WEI_PER_CAW);

        // First sample (untimed setup — establishes the window start).
        vm.prank(writer);
        oracle.recordSample(0, t0);

        // Second sample: completes the window, binds the cap, triggers pushes.
        // This is the worst-case per-message cost.
        vm.prank(writer);
        uint256 before = gasleft();
        oracle.recordSample(uq * (t1 - t0), t1);
        uint256 used = before - gasleft();

        // Confirm we actually hit the expensive branch (a real cap push).
        assertGt(mockTarget.setRatioCallCount(), 0, "expected a setCapRatio push");

        console.log("=== _lzReceive per-message oracle overhead (worst case) ===");
        console.log("recordSample worst-case gas:", used);
        console.log("setCapRatio calls:", mockTarget.setRatioCallCount());
        console.log("setTipRatio calls:", mockTarget.setTipRatioCallCount());
    }

    // Common case: a monotonic sample AFTER the oracle is already warm and the
    // ratio is within hysteresis, so no push fires. This is what most L1->L2
    // messages actually pay for the oracle piggyback.
    function test_recordSample_commonCase_gas() public {
        CawCapOracle oracle = new CawCapOracle(writer, address(mockTarget));

        uint256 now_ = block.timestamp;
        uint32 t0 = uint32(now_ - MIN_WINDOW_SECS - 60);
        uint32 t1 = uint32(now_ - 30);
        uint256 uq = _uq(PRICE_BINDING_WEI_PER_CAW);

        vm.prank(writer);
        oracle.recordSample(0, t0);
        vm.prank(writer);
        oracle.recordSample(uq * (t1 - t0), t1); // warms + first push

        // Third sample: same price, just later. Within hysteresis → no new push.
        uint32 t2 = uint32(now_);
        vm.prank(writer);
        uint256 before = gasleft();
        oracle.recordSample(uq * (t2 - t0), t2);
        uint256 used = before - gasleft();

        console.log("=== _lzReceive per-message oracle overhead (common: warm, no push) ===");
        console.log("recordSample common-case gas:", used);
        console.log("setCapRatio calls (cumulative):", mockTarget.setRatioCallCount());
    }

    // Cheapest case: a non-monotonic (stale) sample. recordSample early-returns.
    function test_recordSample_staleSkip_gas() public {
        CawCapOracle oracle = new CawCapOracle(writer, address(mockTarget));
        uint256 now_ = block.timestamp;
        uint32 t0 = uint32(now_ - MIN_WINDOW_SECS - 60);
        vm.prank(writer);
        oracle.recordSample(0, t0);

        // Same-or-older timestamp → silent skip after one SLOAD compare.
        vm.prank(writer);
        uint256 before = gasleft();
        oracle.recordSample(0, t0);
        uint256 used = before - gasleft();

        console.log("=== _lzReceive per-message oracle overhead (stale skip) ===");
        console.log("recordSample stale-skip gas:", used);
    }
}
