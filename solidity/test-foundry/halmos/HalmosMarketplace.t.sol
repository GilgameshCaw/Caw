// SPDX-License-Identifier: MIT
// test-foundry/halmos/HalmosMarketplace.t.sol
//
// Halmos symbolic-execution checks for CawProfileMarketplace.withdrawPayouts
// and withdrawPayoutsTo.
//
// Key properties:
//   1. Recipient receives exactly pendingPayouts[msg.sender] and the mapping is zeroed.
//   2. No double-withdraw: a second call with the same sender yields 0 (reverts).
//   3. withdrawPayoutsTo(recipient) credits recipient, not sender.
//
// Run with:
//   cd solidity
//   python3.11 -m halmos --contract HalmosMarketplaceTest \
//     --solver-timeout-assertion 300000 --function check_
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

/// @dev Minimal harness extracting the pendingPayouts pull-pattern.
///      Reentrancy guard is modeled via a simple mutex flag (no OpenZeppelin
///      import needed for symbolic reasoning).
contract MarketplacePayoutHarness {
    mapping(address => uint256) public pendingPayouts;
    bool private _locked;

    // Track ETH actually sent (symbolic receiver just accepts)
    mapping(address => uint256) public ethReceived;

    modifier nonReentrant() {
        require(!_locked, "ReentrancyGuard: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    // Seed a payout for a seller
    function seedPayout(address seller, uint256 amount) external {
        pendingPayouts[seller] += amount;
    }

    // Mirrors CawProfileMarketplace._withdrawPayoutsTo
    function withdrawPayouts() external nonReentrant {
        _withdrawPayoutsTo(msg.sender);
    }

    function withdrawPayoutsTo(address recipient) external nonReentrant {
        require(recipient != address(0), "Zero address");
        _withdrawPayoutsTo(recipient);
    }

    function _withdrawPayoutsTo(address recipient) internal {
        uint256 amount = pendingPayouts[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingPayouts[msg.sender] = 0;
        // In harness: just record the amount; no actual ETH transfer
        ethReceived[recipient] += amount;
    }
}

contract HalmosMarketplaceTest is Test {
    MarketplacePayoutHarness internal h;

    function setUp() public {
        h = new MarketplacePayoutHarness();
    }

    // ── check 1 ──────────────────────────────────────────────────────────────
    // withdrawPayouts sends exactly pendingPayouts[sender] and zeroes it.
    function check_withdrawPayouts_exact_debit(
        address seller,
        uint256 amount
    ) public {
        vm.assume(seller != address(0));
        vm.assume(amount > 0 && amount <= type(uint128).max);

        h.seedPayout(seller, amount);
        uint256 payoutBefore = h.pendingPayouts(seller);

        vm.prank(seller);
        h.withdrawPayouts();

        assert(h.pendingPayouts(seller) == 0);
        assert(h.ethReceived(seller) == payoutBefore);
    }

    // ── check 2 ──────────────────────────────────────────────────────────────
    // A second withdrawPayouts call with same sender must revert (nothing left).
    function check_withdrawPayouts_no_double_withdraw(
        address seller,
        uint256 amount
    ) public {
        vm.assume(seller != address(0));
        vm.assume(amount > 0 && amount <= type(uint128).max);

        h.seedPayout(seller, amount);

        vm.prank(seller);
        h.withdrawPayouts();

        // Second call must revert
        vm.prank(seller);
        try h.withdrawPayouts() {
            assert(false); // must not succeed
        } catch {
            // Expected: "Nothing to withdraw"
        }
    }

    // ── check 3 ──────────────────────────────────────────────────────────────
    // withdrawPayoutsTo credits the RECIPIENT, not the caller.
    function check_withdrawPayoutsTo_credits_recipient(
        address seller,
        address recipient,
        uint256 amount
    ) public {
        vm.assume(seller != address(0));
        vm.assume(recipient != address(0));
        vm.assume(seller != recipient); // distinct addresses
        vm.assume(amount > 0 && amount <= type(uint128).max);

        h.seedPayout(seller, amount);
        uint256 payoutBefore = h.pendingPayouts(seller);

        vm.prank(seller);
        h.withdrawPayoutsTo(recipient);

        // Recipient got the funds
        assert(h.ethReceived(recipient) == payoutBefore);
        // Seller's payout zeroed
        assert(h.pendingPayouts(seller) == 0);
        // Seller's ethReceived unchanged
        assert(h.ethReceived(seller) == 0);
    }

    // ── check 4 ──────────────────────────────────────────────────────────────
    // withdrawPayoutsTo with zero recipient must revert.
    function check_withdrawPayoutsTo_rejects_zero_recipient(
        address seller,
        uint256 amount
    ) public {
        vm.assume(seller != address(0));
        vm.assume(amount > 0);
        h.seedPayout(seller, amount);

        vm.prank(seller);
        try h.withdrawPayoutsTo(address(0)) {
            assert(false); // must not succeed
        } catch {
            // Expected: "Zero address"
        }
    }

    // ── check 5 ──────────────────────────────────────────────────────────────
    // pendingPayouts for OTHER sellers is never affected by a withdrawal.
    function check_withdrawPayouts_isolated(
        address sellerA,
        address sellerB,
        uint256 amountA,
        uint256 amountB
    ) public {
        vm.assume(sellerA != address(0) && sellerB != address(0));
        vm.assume(sellerA != sellerB);
        vm.assume(amountA > 0 && amountA <= type(uint128).max);
        vm.assume(amountB > 0 && amountB <= type(uint128).max);

        h.seedPayout(sellerA, amountA);
        h.seedPayout(sellerB, amountB);

        vm.prank(sellerA);
        h.withdrawPayouts();

        // sellerA's payout zeroed
        assert(h.pendingPayouts(sellerA) == 0);
        // sellerB's payout unchanged
        assert(h.pendingPayouts(sellerB) == amountB);
    }
}
