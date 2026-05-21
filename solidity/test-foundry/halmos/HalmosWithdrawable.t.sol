// SPDX-License-Identifier: MIT
// test-foundry/halmos/HalmosWithdrawable.t.sol
//
// Halmos symbolic-execution checks for CawProfile.withdrawTo and
// CawProfile.setWithdrawable.
//
// These are PURE LOGIC checks over a minimal harness — no LayerZero,
// no ERC721, no oracle dependencies.  We extract the exact arithmetic
// from the production functions and prove invariants symbolically.
//
// Run with:
//   cd solidity
//   python3.11 -m halmos --contract HalmosWithdrawableTest \
//     --solver-timeout-assertion 300000 --function check_
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

/// @dev Thin harness that mirrors the exact state transitions of
///      CawProfile.withdrawTo and CawProfile.setWithdrawable without
///      the full contract's constructor overhead (LZ, OApp, etc.).
///      Halmos proves properties over symbolic inputs.
contract WithdrawableHarness {
    mapping(uint32 => uint256) public withdrawable;
    uint256 public totalCaw;

    // CawProfile.setWithdrawable auth flags
    bool public fromLZ;
    address public cawProfileL2;

    constructor(address _l2) {
        cawProfileL2 = _l2;
    }

    /// @dev Mirrors setWithdrawable from CawProfile (auth stripped to harness-level).
    function setWithdrawable_auth(uint32[] memory tokenIds, uint256[] memory amounts) external {
        require(fromLZ || msg.sender == cawProfileL2, "NotL2Mirror");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            withdrawable[tokenIds[i]] += amounts[i];
        }
    }

    /// @dev Mirrors the key state transitions of CawProfile.withdrawTo.
    ///      Returns actual amount withdrawn.
    function withdrawTo_logic(uint32 tokenId) external returns (uint256 amount) {
        require(withdrawable[tokenId] > 0, "NothingToWithdraw");
        amount = withdrawable[tokenId];
        totalCaw -= withdrawable[tokenId];
        withdrawable[tokenId] = 0;
    }

    // Test helpers to set state
    function setWithdrawable_direct(uint32 tokenId, uint256 amount) external {
        withdrawable[tokenId] = amount;
    }
    function setTotalCaw(uint256 amount) external {
        totalCaw = amount;
    }
    function setFromLZ(bool v) external { fromLZ = v; }
}

contract HalmosWithdrawableTest is Test {
    WithdrawableHarness internal h;
    address internal l2 = address(0xCAFE);

    function setUp() public {
        h = new WithdrawableHarness(l2);
    }

    // ── check 1 ──────────────────────────────────────────────────────────────
    // withdrawTo zeroes withdrawable[tokenId] and debits totalCaw by exactly
    // the pre-call withdrawable amount.
    function check_withdrawTo_zeroes_and_debits(
        uint32 tokenId,
        uint256 initialAmount,
        uint256 initialTotal
    ) public {
        vm.assume(initialAmount > 0);
        vm.assume(initialTotal >= initialAmount); // totalCaw always >= withdrawable

        h.setWithdrawable_direct(tokenId, initialAmount);
        h.setTotalCaw(initialTotal);

        uint256 withdrawn = h.withdrawTo_logic(tokenId);

        assert(withdrawn == initialAmount);
        assert(h.withdrawable(tokenId) == 0);
        assert(h.totalCaw() == initialTotal - initialAmount);
    }

    // ── check 2 ──────────────────────────────────────────────────────────────
    // withdrawTo REVERTS when withdrawable[tokenId] == 0.
    function check_withdrawTo_reverts_on_zero(uint32 tokenId) public {
        // withdrawable starts at 0 by default; prove the revert path
        assert(h.withdrawable(tokenId) == 0);
        try h.withdrawTo_logic(tokenId) {
            // Should not reach here
            assert(false);
        } catch {
            // Expected — NothingToWithdraw
        }
    }

    // ── check 3 ──────────────────────────────────────────────────────────────
    // withdrawTo cannot underflow totalCaw because we require totalCaw >= withdrawable.
    // Symbolic: any attempt where amount > totalCaw should revert (underflow in safe
    // Solidity) or be excluded by assumption.
    // This check proves the subtraction never underflows given valid state.
    function check_withdrawTo_no_underflow(
        uint32 tokenId,
        uint256 w,
        uint256 total
    ) public {
        vm.assume(w > 0 && w <= total);
        h.setWithdrawable_direct(tokenId, w);
        h.setTotalCaw(total);

        uint256 totalBefore = h.totalCaw();
        h.withdrawTo_logic(tokenId);
        uint256 totalAfter = h.totalCaw();

        // No underflow: totalAfter == totalBefore - w
        assert(totalAfter == totalBefore - w);
        // And totalAfter <= totalBefore (monotone decrease)
        assert(totalAfter <= totalBefore);
    }

    // ── check 4 ──────────────────────────────────────────────────────────────
    // setWithdrawable only credits when called by cawProfileL2 or fromLZ flag.
    // A random address must be rejected.
    function check_setWithdrawable_auth_rejects_random(
        address caller,
        uint32 tokenId,
        uint256 amount
    ) public {
        vm.assume(caller != l2);
        // fromLZ is false by default in harness

        vm.prank(caller);
        try h.setWithdrawable_auth(_singleton(tokenId), _singletonAmt(amount)) {
            // Must not succeed — auth failed
            assert(false);
        } catch {
            // Expected
        }
    }

    // ── check 5 ──────────────────────────────────────────────────────────────
    // setWithdrawable ACCUMULATES: calling twice adds both amounts.
    function check_setWithdrawable_accumulates(
        uint32 tokenId,
        uint256 a,
        uint256 b
    ) public {
        vm.assume(a <= type(uint128).max); // prevent overflow in test
        vm.assume(b <= type(uint128).max);

        h.setFromLZ(true);
        h.setWithdrawable_auth(_singleton(tokenId), _singletonAmt(a));
        h.setWithdrawable_auth(_singleton(tokenId), _singletonAmt(b));

        assert(h.withdrawable(tokenId) == a + b);
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    function _singleton(uint32 v) internal pure returns (uint32[] memory arr) {
        arr = new uint32[](1);
        arr[0] = v;
    }
    function _singletonAmt(uint256 v) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = v;
    }
}
