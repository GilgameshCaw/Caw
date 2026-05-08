// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfileMarketplace.sol";
import "./mocks/MockCawProfile.sol";

/// @title MarketplaceFuzzTest
/// @notice Property-based tests for the CawProfileMarketplace.
///         Focus on the ETH-escrow conservation invariant for English auctions
///         and offers, plus cancellation/refund correctness.
///
/// @dev Strategy: deploy a real Marketplace with a minimal ERC721 stand-in
///      (MockCawProfile). Bidders are EOAs (this test contract address-derives
///      with vm.addr), so push refunds via call{gas: 2300} succeed — meaning
///      pendingReturns stays zero on the happy path and the simple
///      `address(marketplace).balance == sum(open bids + open offers)`
///      invariant holds.
contract MarketplaceFuzzTest is Test {
    CawProfileMarketplace internal marketplace;
    MockCawProfile internal nft;

    address internal seller   = address(0xA11CE);
    address internal bidderA  = address(0xB1DDA);
    address internal bidderB  = address(0xB1DDB);
    address internal bidderC  = address(0xB1DDC);

    uint32  internal constant TOKEN_ID  = 1;
    uint64  internal constant DURATION  = 7 days;
    uint256 internal constant START_PRICE = 1 ether;

    receive() external payable {}

    function setUp() public {
        nft = new MockCawProfile();
        address[] memory pts = new address[](0);
        marketplace = new CawProfileMarketplace(address(nft), pts);

        nft.mintTo(seller, TOKEN_ID);

        vm.prank(seller);
        nft.setApprovalForAll(address(marketplace), true);

        // Fund participants generously so fuzz inputs in [0, 100 ether] always work.
        vm.deal(seller,  10_000 ether);
        vm.deal(bidderA, 10_000 ether);
        vm.deal(bidderB, 10_000 ether);
        vm.deal(bidderC, 10_000 ether);
    }

    // ---------- helpers ----------

    function _createEnglishListing(uint256 startPrice, uint64 duration)
        internal
        returns (uint256 listingId)
    {
        vm.prank(seller);
        listingId = marketplace.createListing(
            TOKEN_ID,
            CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0),
            startPrice,
            0,
            duration
        );
    }

    function _bid(address who, uint256 listingId, uint256 amt) internal {
        vm.prank(who);
        marketplace.placeBid{value: amt}(listingId);
    }

    /// @dev Read balance & pendingReturns; marketplace ETH should equal the
    ///      open highestBid + every bidder's pendingReturns balance.
    function _assertEscrowConservation(uint256 listingId, address[] memory bidders) internal view {
        ( , , , , , , , , uint256 highestBid, , bool active) = marketplace.listings(listingId);
        uint256 expected = active ? highestBid : 0;
        for (uint256 i = 0; i < bidders.length; i++) {
            expected += marketplace.pendingReturns(bidders[i], listingId);
        }
        assertEq(address(marketplace).balance, expected, "escrow != tracked");
    }

    // ---------------------------------------------------------------
    // FUZZ: cancelOffer (by offerer) refunds 100% of escrowed ETH.
    // ---------------------------------------------------------------
    function testFuzz_OfferCancelRefundsFully(uint96 amount, uint64 duration) public {
        amount   = uint96(bound(amount, 1, 100 ether));
        duration = uint64(bound(duration, 1, 365 days));

        uint256 balBefore = bidderA.balance;
        vm.prank(bidderA);
        uint256 offerId = marketplace.createOfferETH{value: amount}(TOKEN_ID, duration);

        // After creation, offerer is down `amount`.
        assertEq(bidderA.balance, balBefore - amount, "offerer not debited");
        assertEq(address(marketplace).balance, amount, "escrow != offer");

        vm.prank(bidderA);
        marketplace.cancelOffer(offerId);

        // 100% refund.
        assertEq(bidderA.balance, balBefore, "not fully refunded");
        assertEq(address(marketplace).balance, 0, "escrow not drained");
    }

    // ---------------------------------------------------------------
    // FUZZ: anti-snipe always extends to >= ANTI_SNIPE_DURATION.
    // ---------------------------------------------------------------
    function testFuzz_AntiSnipe(uint64 duration, uint96 startPrice, uint96 lateOffset) public {
        duration   = uint64(bound(duration, 11 minutes, 30 days));
        startPrice = uint96(bound(startPrice, 1 wei, 10 ether));
        // Place a bid in the last <10 minutes window.
        lateOffset = uint96(bound(lateOffset, 0, 9 minutes));

        uint256 listingId = _createEnglishListing(startPrice, duration);
        ( , , , , , , uint64 startTime0, uint64 endTime0, , , ) = marketplace.listings(listingId);

        vm.warp(uint256(endTime0) - lateOffset - 1);
        _bid(bidderA, listingId, startPrice);

        ( , , , , , , , uint64 endTime1, , , ) = marketplace.listings(listingId);

        // After bid, end time must be at least ANTI_SNIPE_DURATION away.
        assertGe(uint256(endTime1) - block.timestamp, marketplace.ANTI_SNIPE_DURATION(), "anti-snipe failed");
        // And monotonic with the original.
        assertGe(endTime1, endTime0 - lateOffset, "endTime regressed");
        // unused stack consumer:
        startTime0 = startTime0;
    }

    // ---------------------------------------------------------------
    // FUZZ: cancelListing on English auction with a live highest bidder
    //       moves the bid to pendingReturns (no funds lost).
    // ---------------------------------------------------------------
    function testFuzz_CancelEnglishWithBidPreservesFunds(uint96 startPrice, uint96 bidAmount) public {
        startPrice = uint96(bound(startPrice, 1 wei, 1 ether));
        bidAmount  = uint96(bound(bidAmount, startPrice, 100 ether));

        uint256 listingId = _createEnglishListing(startPrice, DURATION);
        _bid(bidderA, listingId, bidAmount);

        uint256 mktBalBefore = address(marketplace).balance;
        assertEq(mktBalBefore, bidAmount);

        vm.prank(seller);
        marketplace.cancelListing(listingId);

        // Listing inactive; bidder's pendingReturns equals their bid.
        ( , , , , , , , , , , bool active) = marketplace.listings(listingId);
        assertTrue(!active);
        assertEq(marketplace.pendingReturns(bidderA, listingId), bidAmount, "bidder not credited");
        assertEq(address(marketplace).balance, bidAmount, "escrow leaked");

        // Bidder withdraws — full refund.
        uint256 bidderBalBefore = bidderA.balance;
        vm.prank(bidderA);
        marketplace.withdrawBid(listingId);
        assertEq(bidderA.balance, bidderBalBefore + bidAmount, "withdraw incomplete");
        assertEq(address(marketplace).balance, 0, "escrow leaked post-withdraw");
    }

    // ---------------------------------------------------------------
    // FUZZ: full bid sequence — escrow conservation across an arbitrary
    //       sequence of placeBid calls. Highest stands; previous bidders'
    //       refunds either land via push (gas:2300 to EOA) OR sit in
    //       pendingReturns. In either case, mkt.balance == openBid +
    //       sum(pendingReturns).
    // ---------------------------------------------------------------
    function testFuzz_BidSequenceEscrowConserved(
        uint96 startPrice,
        uint96 bid1,
        uint96 bid2,
        uint96 bid3
    ) public {
        startPrice = uint96(bound(startPrice, 1 wei, 1 ether));
        // Each successive bid has to be at least 5% above the prior one.
        bid1 = uint96(bound(bid1, startPrice, 50 ether));
        bid2 = uint96(bound(bid2, bid1 + (bid1 / 19) + 1, 200 ether));
        bid3 = uint96(bound(bid3, bid2 + (bid2 / 19) + 1, 800 ether));

        uint256 listingId = _createEnglishListing(startPrice, DURATION);
        _bid(bidderA, listingId, bid1);
        _bid(bidderB, listingId, bid2);
        _bid(bidderC, listingId, bid3);

        address[] memory bidders = new address[](3);
        bidders[0] = bidderA;
        bidders[1] = bidderB;
        bidders[2] = bidderC;
        _assertEscrowConservation(listingId, bidders);
    }

    // ---------------------------------------------------------------
    // FUZZ: a token with an active listing reverts on createListing
    //       again (per `Token already listed`). Important so the FE can
    //       trust listingByTokenId to be authoritative.
    // ---------------------------------------------------------------
    function testFuzz_NoDoubleListing(uint96 price1, uint96 price2, uint64 d1, uint64 d2) public {
        price1 = uint96(bound(price1, 1 wei, 100 ether));
        price2 = uint96(bound(price2, 1 wei, 100 ether));
        d1 = uint64(bound(d1, 1, 30 days));
        d2 = uint64(bound(d2, 1, 30 days));

        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.FIXED, address(0), price1, 0, d1);

        vm.prank(seller);
        vm.expectRevert(bytes("Token already listed"));
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.FIXED, address(0), price2, 0, d2);
    }
}
