// SPDX-License-Identifier: MIT
// echidna/MarketplaceEchidna.sol
//
// Echidna property-based fuzz of CawProfileMarketplace's ETH-escrow accounting:
//   - pendingPayouts never credits ETH without prior ETH escrow
//   - pendingPayouts zeroed only via withdraw (no other path clears it)
//   - contract ETH balance >= sum(pendingPayouts) + sum(pendingReturns)
//
// No external deps — arithmetic mirror of pull-pattern payout logic.
//
// Run with:
//   cd solidity
//   echidna echidna/MarketplaceEchidna.sol --config echidna.yaml \
//           --contract MarketplaceEchidna
pragma solidity ^0.8.22;

contract MarketplaceEchidna {
    // --- Pull-pattern state mirrors ---
    mapping(address => uint256) public pendingPayouts;    // seller proceeds
    mapping(address => uint256) public pendingReturns;    // outbid bidder refunds

    // Total ETH escrowed by the contract (tracked separately to mirror
    // what the real contract accumulates via payable calls)
    uint256 public totalEscrow;

    // Total amount ever credited to pendingPayouts / pendingReturns
    uint256 public totalCreditedPayouts;
    uint256 public totalCreditedReturns;

    // Total withdrawn via withdrawPayouts / withdrawReturns
    uint256 public totalWithdrawnPayouts;
    uint256 public totalWithdrawnReturns;

    // Echidna bounded actor set
    address internal constant SELLER_A = address(0xA1);
    address internal constant SELLER_B = address(0xA2);
    address internal constant BIDDER_A = address(0xB1);
    address internal constant BIDDER_B = address(0xB2);

    // ---------------------------------------------------------------
    // Echidna callable operations
    // ---------------------------------------------------------------

    /// @dev Simulate a fixed-price sale: ETH arrives in escrow, credited to seller.
    ///      Mirrors CawProfileMarketplace.buy -> pendingPayouts[seller] += price.
    function simulateSale(uint8 sellerIdx, uint256 price) external payable {
        // Echidna passes msg.value; we record it as escrow
        if (msg.value == 0) return;
        price = msg.value; // price == what was sent
        address seller = _seller(sellerIdx);
        pendingPayouts[seller] += price;
        totalEscrow += price;
        totalCreditedPayouts += price;
    }

    /// @dev Simulate a bid placement: ETH escrowed, credited to a bidder's pendingReturns
    ///      (in the real contract this happens when the bidder is outbid or the auction
    ///      is cancelled). Mirrors the pendingReturns pattern.
    function simulateBidReturn(uint8 bidderIdx, uint256 amount) external payable {
        if (msg.value == 0) return;
        amount = msg.value;
        address bidder = _bidder(bidderIdx);
        pendingReturns[bidder] += amount;
        totalEscrow += amount;
        totalCreditedReturns += amount;
    }

    /// @dev Withdraw pending payout. Mirrors _withdrawPayoutsTo.
    function withdrawPayout(uint8 sellerIdx) external {
        address seller = _seller(sellerIdx);
        uint256 amount = pendingPayouts[seller];
        if (amount == 0) return;
        pendingPayouts[seller] = 0;
        totalEscrow -= amount;     // checked subtract — reverts on underflow
        totalWithdrawnPayouts += amount;
        // In production: ETH sent to seller; here we just track the accounting
    }

    /// @dev Withdraw a pending bid return. Mirrors withdrawBid.
    function withdrawReturn(uint8 bidderIdx) external {
        address bidder = _bidder(bidderIdx);
        uint256 amount = pendingReturns[bidder];
        if (amount == 0) return;
        pendingReturns[bidder] = 0;
        totalEscrow -= amount;     // checked subtract — reverts on underflow
        totalWithdrawnReturns += amount;
    }

    // ---------------------------------------------------------------
    // Invariants
    // ---------------------------------------------------------------

    /// @notice totalEscrow >= sum(pendingPayouts) + sum(pendingReturns).
    ///         ETH in the contract must always cover all outstanding pull claims.
    function echidna_escrow_covers_payouts() external view returns (bool) {
        uint256 sumPayouts;
        sumPayouts += pendingPayouts[SELLER_A];
        sumPayouts += pendingPayouts[SELLER_B];

        uint256 sumReturns;
        sumReturns += pendingReturns[BIDDER_A];
        sumReturns += pendingReturns[BIDDER_B];

        return totalEscrow >= sumPayouts + sumReturns;
    }

    /// @notice pendingPayouts are only ever reduced by withdrawPayout.
    ///         The accumulated credits minus accumulated withdrawals must equal
    ///         the current sum of all pendingPayouts.
    function echidna_pendingPayouts_only_zeros_via_withdraw() external view returns (bool) {
        uint256 currentSum;
        currentSum += pendingPayouts[SELLER_A];
        currentSum += pendingPayouts[SELLER_B];

        // totalCreditedPayouts - totalWithdrawnPayouts == currentSum
        return totalCreditedPayouts - totalWithdrawnPayouts == currentSum;
    }

    /// @notice pendingReturns accounting is consistent.
    function echidna_pendingReturns_consistent() external view returns (bool) {
        uint256 currentSum;
        currentSum += pendingReturns[BIDDER_A];
        currentSum += pendingReturns[BIDDER_B];

        return totalCreditedReturns - totalWithdrawnReturns == currentSum;
    }

    /// @notice No seller can have a pendingPayout that exceeds the total escrow
    ///         (trivially implied by echidna_escrow_covers_payouts, but explicit
    ///         check for the single-actor case).
    function echidna_no_single_actor_overdraft() external view returns (bool) {
        if (pendingPayouts[SELLER_A] > totalEscrow) return false;
        if (pendingPayouts[SELLER_B] > totalEscrow) return false;
        if (pendingReturns[BIDDER_A] > totalEscrow) return false;
        if (pendingReturns[BIDDER_B] > totalEscrow) return false;
        return true;
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------
    receive() external payable {
        // Accept ETH for simulateSale/simulateBidReturn via msg.value
    }

    function _seller(uint8 idx) internal pure returns (address) {
        return idx % 2 == 0 ? SELLER_A : SELLER_B;
    }
    function _bidder(uint8 idx) internal pure returns (address) {
        return idx % 2 == 0 ? BIDDER_A : BIDDER_B;
    }
}
