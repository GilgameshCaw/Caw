// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// A listing does not escrow the NFT: the seller keeps it and approves the marketplace. The
// listing stays `active` if the seller later moves the NFT to another wallet.
//
// `CawProfile.transferAndSync` moves the token from its CURRENT owner, as long as the caller is
// approved by that owner (owner == caller, isApprovedForAll(owner, caller) or
// getApproved(tokenId) == caller). The marketplace never checked that the current owner is the
// listing's seller. So if the wallet that received the NFT has approved the marketplace for all
// tokens (the frontend's listing flow calls setApprovalForAll), a buyer of the stale listing takes
// that wallet's token, and the old seller is paid.
//
// reclaimListing / reclaimBid already treat "owner != seller" as the stale state; the sale paths
// (buy, buyWithToken, settleAuction) must treat it the same way.
//
// MockCawProfile in this folder skips the approval check on purpose, so these tests use a stand-in
// that mirrors the real check (CawProfile.sol, transferAndSync).

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/CawProfileMarketplace.sol";

contract ApprovalCheckingProfile is ERC721 {
    error NotApproved();

    constructor() ERC721("MockCAW", "MCAW") {}

    function mintTo(address to, uint256 tokenId) external { _safeMint(to, tokenId); }

    /// @dev Same caller check and transfer as CawProfile.transferAndSync (without LayerZero).
    function transferAndSync(address to, uint256 tokenId, uint32, uint256) external payable {
        address owner = ownerOf(tokenId);
        if (!(owner == msg.sender || isApprovedForAll(owner, msg.sender) || getApproved(tokenId) == msg.sender)) {
            revert NotApproved();
        }
        _transfer(owner, to, tokenId);
        if (msg.value > 0) {
            (bool ok, ) = msg.sender.call{value: msg.value}("");
            require(ok, "refund fail");
        }
    }
}

contract TestToken is ERC20 {
    constructor() ERC20("Pay", "PAY") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MarketplaceSellerOwnershipTest is Test {
    CawProfileMarketplace internal marketplace;
    ApprovalCheckingProfile internal nft;
    TestToken internal token;

    address internal seller   = address(0xA11CE);
    address internal newOwner = address(0x0E0E);   // received the NFT; uses the marketplace for other tokens
    address internal stranger = address(0x5712);   // received the NFT; never approved the marketplace
    address internal buyer    = address(0xB0B);
    address internal bidder   = address(0xB1DDA);

    uint32 internal constant TOKEN_ID = 1;          // the listed token
    uint32 internal constant OTHER_ID = 2;          // another token of newOwner, listed by it
    uint256 internal constant PRICE = 1 ether;
    uint64  internal constant DURATION = 1 days;
    uint256 internal constant START = 1_750_000_000;

    function _isActive(uint256 listingId) internal view returns (bool active) {
        ( , , , , , , , , , , active) = marketplace.listings(listingId);
    }

    function setUp() public {
        vm.warp(START);
        nft = new ApprovalCheckingProfile();
        token = new TestToken();
        address[] memory pts = new address[](1);
        pts[0] = address(token);
        marketplace = new CawProfileMarketplace(address(nft), 1, pts);

        nft.mintTo(seller, TOKEN_ID);
        vm.prank(seller);
        nft.setApprovalForAll(address(marketplace), true);

        // newOwner already uses the marketplace (the listing flow sets approval for all).
        nft.mintTo(newOwner, OTHER_ID);
        vm.prank(newOwner);
        nft.setApprovalForAll(address(marketplace), true);

        vm.deal(buyer, 100 ether);
        vm.deal(bidder, 100 ether);
        token.mint(buyer, 100 ether);
        vm.prank(buyer);
        token.approve(address(marketplace), type(uint256).max);
    }

    function _listFixed(address paymentToken) internal returns (uint256 id) {
        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.FIXED, paymentToken, PRICE, 0, DURATION);
        id = marketplace.nextListingId() - 1;
    }

    function _moveAway(address to) internal {
        vm.prank(seller);
        nft.transferFrom(seller, to, TOKEN_ID);
    }

    // ───────────── the stale listing must not take another wallet's token ─────────────

    function test_buy_staleListing_doesNotTakeNewOwnersToken() public {
        uint256 id = _listFixed(address(0));
        _moveAway(newOwner);

        vm.prank(buyer);
        vm.expectRevert(bytes("Seller no longer owns NFT"));
        marketplace.buy{value: PRICE}(id, 0);

        assertEq(nft.ownerOf(TOKEN_ID), newOwner, "the wallet that holds the token keeps it");
        assertEq(marketplace.pendingPayouts(seller), 0, "the old seller is not paid for it");
        assertTrue(_isActive(id), "the listing is untouched (anyone can still reclaim it)");
    }

    function test_buyWithToken_staleListing_doesNotTakeNewOwnersToken() public {
        uint256 id = _listFixed(address(token));
        _moveAway(newOwner);

        vm.prank(buyer);
        vm.expectRevert(bytes("Seller no longer owns NFT"));
        marketplace.buyWithToken(id, PRICE, 0);

        assertEq(nft.ownerOf(TOKEN_ID), newOwner);
        assertEq(marketplace.pendingTokenPayouts(seller, address(token)), 0);
        assertEq(token.balanceOf(buyer), 100 ether, "the buyer's tokens were not taken");
    }

    function test_settleAuction_staleListing_doesNotTakeNewOwnersToken() public {
        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), PRICE, 0, DURATION);
        uint256 id = marketplace.nextListingId() - 1;
        vm.prank(bidder);
        marketplace.placeBid{value: PRICE}(id);

        _moveAway(newOwner);
        vm.warp(START + 2 days);

        vm.expectRevert(bytes("Seller no longer owns NFT"));
        marketplace.settleAuction(id, 0);
        assertEq(nft.ownerOf(TOKEN_ID), newOwner);

        // The bidder gets the bid back through the existing path.
        vm.prank(bidder);
        marketplace.reclaimBid(id);
        assertEq(marketplace.pendingReturns(bidder, id), PRICE);
    }

    // ───────────── controls ─────────────

    /// @dev A wallet that never approved the marketplace was already safe (per-token approval is cleared on transfer).
    ///      The reason is not asserted on purpose: on master the buy reverts inside transferAndSync (NotApproved),
    ///      with the new check it reverts earlier with "Seller no longer owns NFT"; this control must hold on both.
    function test_control_newOwnerWithoutApproval_buyReverts() public {
        uint256 id = _listFixed(address(0));
        _moveAway(stranger);
        vm.prank(buyer);
        vm.expectRevert();
        marketplace.buy{value: PRICE}(id, 0);
        assertEq(nft.ownerOf(TOKEN_ID), stranger);
    }

    function test_control_honestSale_stillWorks() public {
        uint256 id = _listFixed(address(0));
        vm.prank(buyer);
        marketplace.buy{value: PRICE}(id, 0);
        assertEq(nft.ownerOf(TOKEN_ID), buyer);
        assertEq(marketplace.pendingPayouts(seller), PRICE);
        assertFalse(_isActive(id));
    }

    function test_control_honestAuction_stillSettles() public {
        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.ENGLISH_AUCTION,
            address(0), PRICE, 0, DURATION);
        uint256 id = marketplace.nextListingId() - 1;
        vm.prank(bidder);
        marketplace.placeBid{value: PRICE}(id);
        vm.warp(START + 2 days);
        marketplace.settleAuction(id, 0);
        assertEq(nft.ownerOf(TOKEN_ID), bidder);
        assertEq(marketplace.pendingPayouts(seller), PRICE);
    }

    /// @dev The other way out of a stale listing is unchanged: anyone can reclaim it, and the new owner can then list.
    function test_staleListing_canStillBeReclaimed_andRelisted() public {
        uint256 id = _listFixed(address(0));
        _moveAway(newOwner);
        marketplace.reclaimListing(id);
        assertFalse(_isActive(id));
        assertEq(marketplace.listingByTokenId(TOKEN_ID), 0);

        vm.prank(newOwner);
        marketplace.createListing(TOKEN_ID, CawProfileMarketplace.ListingType.FIXED, address(0), 2 ether, 0, DURATION);
    }
}
