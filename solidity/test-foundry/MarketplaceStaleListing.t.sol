// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfile.sol";
import "../contracts/CawProfileMarketplace.sol";
import "../contracts/CawNetworkManager.sol";
import "../contracts/MintableCaw.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

contract StaleListing_BuyAndBurn {
    receive() external payable {}
}

contract StaleListing_URI {
    function generate(string memory) external pure returns (string memory) { return ""; }
}

/// @title MarketplaceStaleListingTest
/// @notice Listings don't escrow the token. If the seller transfers it away
///         while the listing is active, and the new owner has approved the
///         marketplace (the FE's listing flow does setApprovalForAll), a sale
///         must not move the new owner's token and pay the old seller. It
///         reverts, and reclaimListing / reclaimBid clear the listing as before.
///         Real CawProfile + MockLayerZeroEndpoint.
contract MarketplaceStaleListingTest is Test {
    uint32 constant L1_EID = 30101;
    uint32 constant L2_EID = 40245;
    uint32 constant NETWORK_ID = 1;

    CawProfile internal cawProfile;
    CawProfileMarketplace internal marketplace;
    MintableCaw internal caw;

    address internal seller   = address(0xA11CE);
    address internal buyer    = address(0xB0B);
    address internal newOwner = address(0xC0FFEE);

    uint32 internal nextId = 1;

    receive() external payable {}

    function setUp() public {
        caw = new MintableCaw();
        MockLayerZeroEndpoint lzL1 = new MockLayerZeroEndpoint(L1_EID);
        MockLayerZeroEndpoint lzL2 = new MockLayerZeroEndpoint(L2_EID);
        CawNetworkManager nm = new CawNetworkManager(address(new StaleListing_BuyAndBurn()));
        cawProfile = new CawProfile(
            address(caw),
            address(new StaleListing_URI()),
            address(new StaleListing_BuyAndBurn()),
            address(nm),
            address(lzL1),
            L1_EID,
            address(0),         // priceReader
            address(0xDEAD),    // ledger: only used for mainnet-chosen tokens
            address(this),      // pathwayExpander (owner, for setPeer)
            address(this)       // minter
        );
        cawProfile.setPeer(L2_EID, bytes32(uint256(uint160(address(lzL2)))));
        lzL1.setDestLzEndpoint(address(lzL2), address(lzL2));
        nm.createNetwork("TestNet", address(this), L2_EID, 0, 0, 0, 0, 5e11);

        address[] memory pts = new address[](1);
        pts[0] = address(caw);
        marketplace = new CawProfileMarketplace(address(cawProfile), L2_EID, pts);

        vm.deal(buyer, 10 ether);
        vm.deal(address(this), 10 ether);
        vm.prank(seller);
        cawProfile.setApprovalForAll(address(marketplace), true);
        vm.prank(newOwner);
        cawProfile.setApprovalForAll(address(marketplace), true);
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    function _mint(address owner) internal returns (uint32 id) {
        id = nextId++;
        string memory name = string(abi.encodePacked("u", vm.toString(id)));
        cawProfile.mintAndAuth{value: 1 ether}(NETWORK_ID, owner, name, id, L2_EID, 0, "");
    }

    function _list(uint32 id, CawProfileMarketplace.ListingType t, address paymentToken, uint256 price) internal returns (uint256) {
        vm.prank(seller);
        return marketplace.createListing(id, t, paymentToken, price, 0, 1000);
    }

    function _giveAway(uint32 id) internal {
        vm.prank(seller);
        cawProfile.transferFrom(seller, newOwner, id);
    }

    // ---------------------------------------------------------------------
    // tests
    // ---------------------------------------------------------------------

    function test_buy_afterSellerTransferredAway_reverts() public {
        uint32 id = _mint(seller);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, address(0), 0.1 ether);
        _giveAway(id);

        vm.prank(buyer, buyer);
        vm.expectRevert(bytes("ERC721: transfer from incorrect owner"));
        marketplace.buy{value: 0.15 ether}(lid, 0);

        assertEq(cawProfile.ownerOf(id), newOwner);
        assertEq(marketplace.pendingPayouts(seller), 0);

        marketplace.reclaimListing(lid);
        assertEq(marketplace.listingByTokenId(id), 0);
    }

    function test_buyWithToken_afterSellerTransferredAway_reverts() public {
        uint32 id = _mint(seller);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, address(caw), 100 ether);
        _giveAway(id);
        caw.mint(buyer, 100 ether);
        vm.prank(buyer);
        caw.approve(address(marketplace), 100 ether);

        vm.prank(buyer, buyer);
        vm.expectRevert(bytes("ERC721: transfer from incorrect owner"));
        marketplace.buyWithToken{value: 0.05 ether}(lid, 100 ether, 0);

        assertEq(cawProfile.ownerOf(id), newOwner);
        assertEq(caw.balanceOf(buyer), 100 ether);
    }

    function test_settleAuction_afterSellerTransferredAway_reverts() public {
        uint32 id = _mint(seller);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.ENGLISH_AUCTION, address(0), 0.1 ether);
        vm.prank(buyer);
        marketplace.placeBid{value: 0.1 ether}(lid);
        _giveAway(id);
        vm.warp(block.timestamp + 1001);

        vm.expectRevert(bytes("ERC721: transfer from incorrect owner"));
        marketplace.settleAuction{value: 0.05 ether}(lid, 0);

        assertEq(cawProfile.ownerOf(id), newOwner);

        marketplace.reclaimBid(lid);
        assertEq(marketplace.pendingReturns(buyer, lid), 0.1 ether);
        assertEq(marketplace.pendingPayouts(seller), 0);
    }

    /// Control: only who owns the token at sale time matters.
    function test_buy_afterSellerGotTokenBack_succeeds() public {
        uint32 id = _mint(seller);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, address(0), 0.1 ether);
        _giveAway(id);
        vm.prank(newOwner);
        cawProfile.transferFrom(newOwner, seller, id);

        vm.prank(buyer, buyer);
        marketplace.buy{value: 0.15 ether}(lid, 0);

        assertEq(cawProfile.ownerOf(id), buyer);
        assertEq(marketplace.pendingPayouts(seller), 0.1 ether);
    }
}
