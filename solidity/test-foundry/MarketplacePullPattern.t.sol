// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfileMarketplace.sol";
import "./mocks/MockCawProfile.sol";

/// @title MarketplacePullPatternTest
/// @notice Unit tests verifying H-15 (seller ETH pull pattern) and H-17
///         (defaulted-auction escape hatch) fixes in CawProfileMarketplace.
///
/// H-15: buy(), settleAuction(), and acceptOffer() ETH paths must credit
///       pendingPayouts instead of pushing ETH directly to the seller.
///       The seller must call withdrawPayouts() / withdrawPayoutsTo() to
///       receive funds.
///
/// H-17: refundDefaultedAuction() lets the highest bidder self-refund after
///       endTime + AUCTION_DEFAULT_GRACE (7 days) when the seller never
///       settles. ETH path uses pendingPayouts; ERC20 uses safeTransfer.
contract MarketplacePullPatternTest is Test {
    CawProfileMarketplace internal marketplace;
    MockCawProfile        internal nft;

    address internal seller  = address(0xA11CE);
    address internal buyer   = address(0xB0B);
    address internal bidderA = address(0xB1DDA);
    address internal bidderB = address(0xB1DDB);

    uint32 internal constant TOKEN_ID = 1;
    uint64 internal constant DURATION = 1 days;

    receive() external payable {}

    /// @dev Extract the `active` field (index 10) from the listings tuple.
    function _isActive(uint256 listingId) internal view returns (bool active) {
        ( , , , , , , , , , , active) = marketplace.listings(listingId);
    }

    function setUp() public {
        nft = new MockCawProfile();
        address[] memory pts = new address[](0);
        marketplace = new CawProfileMarketplace(address(nft), 1, pts);

        nft.mintTo(seller, TOKEN_ID);
        vm.prank(seller);
        nft.setApprovalForAll(address(marketplace), true);

        vm.deal(seller,  100 ether);
        vm.deal(buyer,   100 ether);
        vm.deal(bidderA, 100 ether);
        vm.deal(bidderB, 100 ether);
    }

    // =====================================================================
    // H-15: buy() — ETH queued to pendingPayouts, not pushed to seller
    // =====================================================================

    function test_H15_BuyCreditsSellerViaPendingPayouts() public {
        uint256 price = 1 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.FIXED,
            address(0), price, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        uint256 sellerBalBefore = seller.balance;

        vm.prank(buyer);
        marketplace.buy{value: price}(listingId);

        // Seller's wallet must NOT have increased — payment is queued.
        assertEq(seller.balance, sellerBalBefore, "H-15: seller balance should not change on buy");

        // pendingPayouts must hold the price.
        assertEq(marketplace.pendingPayouts(seller), price,
            "H-15: price must be in pendingPayouts after buy");

        // Listing is inactive; buyer owns the NFT.
        assertFalse(_isActive(listingId), "listing should be inactive");
        assertEq(nft.ownerOf(TOKEN_ID), buyer, "buyer must own NFT");
    }

    function test_H15_BuyThenWithdrawPayoutsDeliversToSeller() public {
        uint256 price = 1 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.FIXED,
            address(0), price, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.prank(buyer);
        marketplace.buy{value: price}(listingId);

        uint256 sellerBalBefore = seller.balance;
        vm.prank(seller);
        marketplace.withdrawPayouts();

        assertEq(seller.balance, sellerBalBefore + price,
            "H-15: seller must receive price after withdrawPayouts");
        assertEq(marketplace.pendingPayouts(seller), 0,
            "H-15: pendingPayouts must be zero after withdrawal");
        assertEq(address(marketplace).balance, 0, "marketplace ETH must be empty");
    }

    function test_H15_WithdrawPayoutsToAlternateRecipient() public {
        address recipient = address(0xDEAD);
        vm.deal(recipient, 0);
        uint256 price = 2 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.FIXED,
            address(0), price, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.prank(buyer);
        marketplace.buy{value: price}(listingId);

        assertEq(marketplace.pendingPayouts(seller), price);

        vm.prank(seller);
        marketplace.withdrawPayoutsTo(recipient);

        assertEq(recipient.balance, price,
            "H-15: withdrawPayoutsTo must deliver to specified recipient");
        assertEq(marketplace.pendingPayouts(seller), 0);
    }

    function test_H15_PayoutQueuedEventEmittedOnBuy() public {
        uint256 price = 1 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.FIXED,
            address(0), price, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.expectEmit(true, false, false, true);
        emit CawProfileMarketplace.PayoutQueued(seller, price);

        vm.prank(buyer);
        marketplace.buy{value: price}(listingId);
    }

    // =====================================================================
    // H-15: settleAuction() — ETH queued to pendingPayouts
    // =====================================================================

    function test_H15_SettleAuctionCreditsSellerViaPendingPayouts() public {
        uint256 minBid = 0.1 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        uint256 bid = 0.5 ether;
        vm.prank(bidderA);
        marketplace.placeBid{value: bid}(listingId);

        vm.warp(block.timestamp + DURATION + 1);

        uint256 sellerBalBefore = seller.balance;
        marketplace.settleAuction(listingId);

        // Seller's wallet unchanged immediately.
        assertEq(seller.balance, sellerBalBefore,
            "H-15: seller balance should not change on settleAuction");

        // pendingPayouts holds the winning bid.
        assertEq(marketplace.pendingPayouts(seller), bid,
            "H-15: winning bid must be in pendingPayouts after settle");

        // NFT transferred to winner.
        assertEq(nft.ownerOf(TOKEN_ID), bidderA, "winner must own NFT");
    }

    function test_H15_SettleAuctionThenWithdrawPayouts() public {
        uint256 minBid = 0.1 ether;
        uint256 bid    = 0.3 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.prank(bidderA);
        marketplace.placeBid{value: bid}(listingId);

        vm.warp(block.timestamp + DURATION + 1);
        marketplace.settleAuction(listingId);

        uint256 sellerBalBefore = seller.balance;
        vm.prank(seller);
        marketplace.withdrawPayouts();

        assertEq(seller.balance, sellerBalBefore + bid,
            "H-15: seller must receive bid after withdrawPayouts");
        assertEq(marketplace.pendingPayouts(seller), 0);
    }

    // =====================================================================
    // H-15: acceptOffer() — ETH queued to pendingPayouts
    // =====================================================================

    function test_H15_AcceptOfferCreditsSellerViaPendingPayouts() public {
        uint256 offerAmt = 0.5 ether;

        vm.prank(buyer);
        marketplace.createOfferETH{value: offerAmt}(TOKEN_ID, 1 days);
        uint256 offerId = marketplace.nextOfferId() - 1;

        uint256 sellerBalBefore = seller.balance;

        vm.prank(seller);
        marketplace.acceptOffer(offerId);

        // Seller wallet unchanged.
        assertEq(seller.balance, sellerBalBefore,
            "H-15: seller balance should not change on acceptOffer");

        // pendingPayouts holds the offer amount.
        assertEq(marketplace.pendingPayouts(seller), offerAmt,
            "H-15: offer amount must be in pendingPayouts after acceptOffer");

        // Buyer owns NFT.
        assertEq(nft.ownerOf(TOKEN_ID), buyer, "buyer must own NFT after acceptOffer");
    }

    // =====================================================================
    // H-15: escrow conservation — bidder push refunds still work for EOAs
    // =====================================================================

    function test_H15_OutbidEOAStillReceivesPushRefund() public {
        uint256 minBid = 0.1 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        uint256 bid1 = 0.1 ether;
        vm.prank(bidderA);
        marketplace.placeBid{value: bid1}(listingId);

        uint256 bidderABalBefore = bidderA.balance;
        uint256 bid2 = 0.2 ether;
        vm.prank(bidderB);
        marketplace.placeBid{value: bid2}(listingId);

        // EOA bidderA should have received push refund.
        assertEq(bidderA.balance, bidderABalBefore + bid1,
            "Outbid EOA must receive push refund");
        assertEq(marketplace.pendingReturns(bidderA, listingId), 0,
            "pendingReturns must be empty for EOA outbid (push succeeded)");
    }

    // =====================================================================
    // H-17: refundDefaultedAuction() — bidder can self-refund after grace
    // =====================================================================

    function test_H17_RefundDefaultedAuction_CreditsViaPendingPayouts() public {
        uint256 minBid = 0.1 ether;
        uint256 bid    = 0.5 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.prank(bidderA);
        marketplace.placeBid{value: bid}(listingId);

        // Advance past auction end + grace period (7 days).
        vm.warp(block.timestamp + DURATION + marketplace.AUCTION_DEFAULT_GRACE() + 1);

        // Bidder calls refundDefaultedAuction.
        vm.prank(bidderA);
        marketplace.refundDefaultedAuction(listingId);

        // Bid credited to pendingPayouts (pull pattern).
        assertEq(marketplace.pendingPayouts(bidderA), bid,
            "H-17: bid must be in pendingPayouts after refundDefaultedAuction");

        // Listing is inactive.
        assertFalse(_isActive(listingId),
            "H-17: listing must be inactive after refundDefaultedAuction");

        // Bidder withdraws.
        uint256 bidderBalBefore = bidderA.balance;
        vm.prank(bidderA);
        marketplace.withdrawPayouts();
        assertEq(bidderA.balance, bidderBalBefore + bid,
            "H-17: bidder must receive full bid after withdrawPayouts");
    }

    function test_H17_RefundDefaultedAuction_RevertsBeforeGrace() public {
        uint256 minBid = 0.1 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.prank(bidderA);
        marketplace.placeBid{value: minBid}(listingId);

        // Advance only past end but within grace period.
        vm.warp(block.timestamp + DURATION + 1 days);

        vm.prank(bidderA);
        vm.expectRevert(bytes("Grace period not elapsed"));
        marketplace.refundDefaultedAuction(listingId);
    }

    function test_H17_RefundDefaultedAuction_RevertsIfNoBids() public {
        uint256 minBid = 0.1 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        // No bids; advance past grace period.
        vm.warp(block.timestamp + DURATION + marketplace.AUCTION_DEFAULT_GRACE() + 1);

        vm.prank(bidderA);
        vm.expectRevert(bytes("No bids"));
        marketplace.refundDefaultedAuction(listingId);
    }

    function test_H17_RefundDefaultedAuction_OnlyHighestBidder() public {
        uint256 minBid = 0.1 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.prank(bidderA);
        marketplace.placeBid{value: minBid}(listingId);

        vm.warp(block.timestamp + DURATION + marketplace.AUCTION_DEFAULT_GRACE() + 1);

        // bidderB is not the highest bidder.
        vm.prank(bidderB);
        vm.expectRevert(bytes("Only highest bidder"));
        marketplace.refundDefaultedAuction(listingId);
    }

    function test_H17_SettleAuction_BlockedAfterDefaultRefund() public {
        uint256 minBid = 0.1 ether;
        uint256 bid    = 0.5 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.prank(bidderA);
        marketplace.placeBid{value: bid}(listingId);

        vm.warp(block.timestamp + DURATION + marketplace.AUCTION_DEFAULT_GRACE() + 1);

        vm.prank(bidderA);
        marketplace.refundDefaultedAuction(listingId);

        // Listing is now inactive; settleAuction must revert.
        vm.expectRevert(bytes("Listing not active"));
        marketplace.settleAuction(listingId);
    }

    // =====================================================================
    // H-17: AuctionDefaulted event
    // =====================================================================

    function test_H17_AuctionDefaultedEventEmitted() public {
        uint256 minBid = 0.1 ether;
        uint256 bid    = 0.5 ether;

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), minBid, 0, DURATION);
        uint256 listingId = marketplace.nextListingId() - 1;

        vm.prank(bidderA);
        marketplace.placeBid{value: bid}(listingId);

        vm.warp(block.timestamp + DURATION + marketplace.AUCTION_DEFAULT_GRACE() + 1);

        vm.expectEmit(true, true, false, true);
        emit CawProfileMarketplace.AuctionDefaulted(listingId, bidderA, bid);

        vm.prank(bidderA);
        marketplace.refundDefaultedAuction(listingId);
    }
}
