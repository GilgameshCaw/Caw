// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// twapEthPerCaw() finds the start of the 7-day window in the sample ring buffer.
//
// It used to walk backwards one slot per sample inside the window. CawProfileLedger gives
// recordSample 180,000 gas (ORACLE_RECORD_GAS_CAP); the walk costs about 2,100 gas per sample
// when the slots are cold, so with more than ~40 samples in the window the push into
// CawActions ran out of gas inside recordSample's own swallow-on-revert self-call and was
// dropped (the sample itself was still written).
//
// The slots are in strictly increasing time order, so the anchor is now a binary search.
//
// These tests check:
//   1. The answer is the same as the old linear walk (kept below as `_refTwap`, the
//      specification) for many layouts: early life, an exact boundary, a ring that wrapped,
//      a ring too dense to span a day, and random gaps.
//   2. With the 180,000 gas cap, the ratio push now lands with a full window.
//   3. The cost of reading the TWAP no longer grows with the number of samples.

import "forge-std/Test.sol";
import "../contracts/CawCapOracle.sol";
import "../contracts/test-helpers/MockCawActionsCapTarget.sol";

interface ICoolVm { function cool(address) external; }

contract CapOracleWindowSearchTest is Test {
    uint256 constant PRICE_WEI_PER_CAW = 1e9;  // the cap binds at this price
    uint256 constant GAS_CAP = 180_000;        // CawProfileLedger.ORACLE_RECORD_GAS_CAP
    uint256 constant WINDOW = 7 days;
    uint256 constant BUF = 1024;

    address writer;
    MockCawActionsCapTarget target;
    CawCapOracle oracle;

    function setUp() public {
        writer = makeAddr("writer");
        target = new MockCawActionsCapTarget();
        oracle = new CawCapOracle(writer, address(target));
        vm.warp(1_750_000_000);
    }

    // ─── helpers ───────────────────────────────────────────────────────────────

    function _uq() internal pure returns (uint256) {
        return (PRICE_WEI_PER_CAW * (2 ** 112)) / 1e18;
    }

    function _record(uint256 cumulative, uint32 ts) internal {
        vm.prank(writer);
        oracle.recordSample(cumulative, ts);
    }

    /// @dev n samples from t0 to t1 inclusive, evenly spaced, constant price.
    function _seedEven(uint256 n, uint32 t0, uint32 t1) internal {
        uint256 uq = _uq();
        for (uint256 i = 0; i < n; i++) {
            uint32 t = n == 1 ? t0 : uint32(uint256(t0) + (uint256(t1 - t0) * i) / (n - 1));
            _record(uq * (t - t0), t);
        }
    }

    function _slot(uint64 idx) internal view returns (uint224 cum, uint32 ts) {
        // `buf` is the first state variable: slot i holds sample i (224-bit cumulative, then
        // the 32-bit timestamp in the top bits).
        uint256 w = uint256(vm.load(address(oracle), bytes32(uint256(idx & (BUF - 1)))));
        cum = uint224(w);
        ts = uint32(w >> 224);
    }

    /// @dev The previous implementation of twapEthPerCaw (backward linear walk), kept as the
    ///      specification the binary search must match.
    function _refTwap() internal view returns (uint256 twap, bool fresh) {
        uint64 nextIdx = oracle.samplesWritten();
        if (nextIdx < 2) return (0, false);
        (uint224 lc, uint32 lt) = _slot(nextIdx - 1);
        if (block.timestamp > uint256(lt) + 24 hours) return (0, false);

        uint64 oldestIdx;
        bool found;
        uint64 cursor = nextIdx - 1;
        uint64 maxScan = nextIdx > BUF ? uint64(BUF) : nextIdx;
        if (uint256(lt) >= WINDOW) {
            uint32 windowStart = lt - uint32(WINDOW);
            for (uint64 i = 1; i < maxScan; i++) {
                (, uint32 ts) = _slot(cursor - i);
                if (ts == 0) break;
                if (ts <= windowStart) {
                    oldestIdx = cursor - i;
                    found = true;
                    break;
                }
            }
        }
        uint224 oc;
        uint32 ot;
        if (found) {
            (oc, ot) = _slot(oldestIdx);
        } else {
            (oc, ot) = _slot(nextIdx > BUF ? nextIdx - uint64(BUF) : 0);
        }
        if (ot >= lt) return (0, false);
        uint256 timeDelta = uint256(lt - ot);
        if (timeDelta < 1 days) return (0, false);
        unchecked {
            uint256 cumDelta = (uint256(lc) - uint256(oc)) & ((uint256(1) << 224) - 1);
            twap = cumDelta / timeDelta;
        }
        fresh = true;
    }

    function _assertSameAsReference(string memory label) internal view {
        (uint256 a, bool fa) = oracle.twapEthPerCaw();
        (uint256 b, bool fb) = _refTwap();
        assertEq(fa, fb, string.concat(label, ": fresh differs"));
        assertEq(a, b, string.concat(label, ": twap differs"));
    }

    function _cool(address a) internal { ICoolVm(address(vm)).cool(a); }

    // ─── 1. same answer as the linear walk ────────────────────────────────────

    function test_same_early_life_fewSamples() public {
        uint32 t1 = uint32(block.timestamp);
        _seedEven(2, t1 - 2 days, t1);
        _assertSameAsReference("2 samples over 2 days");
        (, bool fresh) = oracle.twapEthPerCaw();
        assertTrue(fresh, "the reference layout is fresh, so the comparison is not vacuous");
    }

    function test_same_noSampleOldEnough_usesOldest() public {
        uint32 t1 = uint32(block.timestamp);
        _seedEven(50, t1 - 6 days, t1);          // history is shorter than the window
        _assertSameAsReference("history shorter than 7d");
    }

    function test_same_evenSpacing_manySizes() public {
        uint256[8] memory ns = [uint256(3), 10, 41, 100, 400, 700, 1023, 1024];
        for (uint256 i = 0; i < ns.length; i++) {
            oracle = new CawCapOracle(writer, address(target));
            uint32 t1 = uint32(block.timestamp);
            _seedEven(ns[i], t1 - uint32(WINDOW) - 1 hours, t1);
            _assertSameAsReference(string.concat("even n=", vm.toString(ns[i])));
            (, bool fresh) = oracle.twapEthPerCaw();
            assertTrue(fresh, "fresh");
        }
    }

    function test_same_ringWrapped_spansDays() public {
        // 1,500 samples over 7 days + 1 hour: the ring keeps only the newest 1,024 (about 4.8 days).
        uint32 t1 = uint32(block.timestamp);
        _seedEven(1_500, t1 - uint32(WINDOW) - 1 hours, t1);
        assertEq(oracle.samplesWritten(), 1_500);
        _assertSameAsReference("wrapped ring");
        (, bool fresh) = oracle.twapEthPerCaw();
        assertTrue(fresh, "4.8 days of history is fresh");
    }

    function test_same_ringTooDense_notFresh() public {
        // 1,500 samples 12 seconds apart: the ring spans ~3.4 hours, less than MIN_WINDOW.
        uint32 t1 = uint32(block.timestamp);
        _seedEven(1_500, t1 - 1_499 * 12, t1);
        _assertSameAsReference("too dense");
        (, bool fresh) = oracle.twapEthPerCaw();
        assertFalse(fresh);
    }

    function test_same_exactBoundary() public {
        // A sample exactly at windowStart anchors the window (<=), one second later does not.
        uint32 t1 = uint32(block.timestamp);
        uint32 ws = t1 - uint32(WINDOW);
        uint256 uq = _uq();
        uint32[6] memory ts = [ws - 2 days, ws - 1, ws, ws + 1, t1 - 1 days, t1];
        for (uint256 i = 0; i < ts.length; i++) _record(uq * (ts[i] - ts[0]), ts[i]);
        _assertSameAsReference("boundary");

        oracle = new CawCapOracle(writer, address(target));
        uint32[5] memory ts2 = [ws - 2 days, ws + 1, ws + 2, t1 - 1 days, t1];
        for (uint256 i = 0; i < ts2.length; i++) _record(uq * (ts2[i] - ts2[0]), ts2[i]);
        _assertSameAsReference("boundary, none at or before");
    }

    function test_same_firstSampleHasTimestampZero() public {
        // L1 sends a zeroed prefix when no price reader is set; the very first slot can hold ts 0.
        uint32 t1 = uint32(block.timestamp);
        _record(0, 0);
        _seedEven(20, t1 - 8 days, t1);
        _assertSameAsReference("ts 0 in slot 0");
    }

    /// @dev Random gaps (1 second to 12 hours), random sizes, random clock offset after the
    ///      last sample (including past the 24h stale threshold).
    function testFuzz_same_randomLayout(uint256 seed, uint8 count, uint32 tail) public {
        uint256 n = bound(uint256(count), 2, 200);
        uint32 t = 1_700_000_000;
        uint256 cum = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 gap = 1 + uint256(keccak256(abi.encode(seed, i, "gap"))) % 12 hours;
            uint256 inc = uint256(keccak256(abi.encode(seed, i, "inc"))) % (1e24);
            t += uint32(gap);
            cum += inc;
            _record(cum, t);
        }
        vm.warp(uint256(t) + bound(uint256(tail), 0, 30 hours));
        _assertSameAsReference("random layout");
    }

    // ─── 2. the push lands within the ledger's gas cap ────────────────────────

    function _pushesWithCap(uint256 n) internal returns (uint256 pushes, uint256 gasUsed) {
        uint32 t1 = uint32(block.timestamp);
        uint32 t0 = t1 - uint32(WINDOW) - 1 hours;
        _seedEven(n, t0, t1);
        uint256 before = target.setRatioCallCount() + target.setTipRatioCallCount();

        // The next sample arrives 3 hours + 1 second later: the stale refresh is due, so a
        // push is expected regardless of price movement.
        // (t2 is computed, not read back from block.timestamp: the compiler may reuse the
        // value read before the warp.)
        uint32 t2 = t1 + 3 hours + 1;
        vm.warp(t2);
        _cool(address(oracle));
        _cool(address(target));
        vm.prank(writer);
        uint256 g = gasleft();
        try oracle.recordSample{gas: GAS_CAP}(_uq() * (t2 - t0), t2) {} catch {}
        gasUsed = g - gasleft();
        pushes = target.setRatioCallCount() + target.setTipRatioCallCount() - before;
    }

    function test_pushLandsWithinGasCap_fullWindow_700() public {
        (uint256 pushes, uint256 gasUsed) = _pushesWithCap(700);
        console.log("700 samples in the window: pushes", pushes, "gas", gasUsed);
        assertEq(pushes, 2, "cap and tip ratios were pushed");
        assertLt(gasUsed, GAS_CAP, "within the cap, with headroom");
    }

    function test_pushLandsWithinGasCap_fullRing_1024() public {
        (uint256 pushes, uint256 gasUsed) = _pushesWithCap(1_024);
        console.log("1024 samples in the window: pushes", pushes, "gas", gasUsed);
        assertEq(pushes, 2);
        assertLt(gasUsed, GAS_CAP);
    }

    function test_pushLandsWithinGasCap_smallWindow_stillWorks() public {
        (uint256 pushes,) = _pushesWithCap(10);
        assertEq(pushes, 2);
    }

    // ─── 3. the read no longer grows with the number of samples ────────────────

    function _twapGasCold(uint256 n) internal returns (uint256 used) {
        oracle = new CawCapOracle(writer, address(target));
        uint32 t1 = uint32(block.timestamp);
        _seedEven(n, t1 - uint32(WINDOW) - 1 hours, t1);
        _cool(address(oracle));
        uint256 g = gasleft();
        (, bool fresh) = oracle.twapEthPerCaw();
        used = g - gasleft();
        assertTrue(fresh);
    }

    function test_twapReadCost_doesNotGrowWithSamples() public {
        uint256 g10 = _twapGasCold(10);
        uint256 g100 = _twapGasCold(100);
        uint256 g700 = _twapGasCold(700);
        uint256 g1024 = _twapGasCold(1_024);
        console.log("twap read, cold: n=10", g10);
        console.log("twap read, cold: n=100", g100);
        console.log("twap read, cold: n=700", g700);
        console.log("twap read, cold: n=1024", g1024);
        assertLt(g1024, 40_000, "about 10 slot reads plus fixed work");
        assertLt(g1024, g10 * 3, "within a small factor of the 10-sample read");
    }
}
