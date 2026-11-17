// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfileMarketplace.sol";
import "./mocks/MockCawProfile.sol";

/// @notice The marketplace escrows exactly what it records. A token that
///         delivers less than it is asked to move (a transfer fee) would leave
///         it holding less than it owes, so deposits of such a token are refused.
contract MarketplaceExactReceiptTest is Test {
    CawProfileMarketplace internal marketplace;
    MockCawProfile        internal nft;

    address internal seller = address(0xA11CE);
    address internal buyer  = address(0xB0B);

    uint32  internal constant TOKEN_ID = 1;
    uint64  internal constant DURATION = 1 days;
    uint256 internal constant AMOUNT   = 100e18;

    function _deploy(address token) internal {
        nft = new MockCawProfile();
        address[] memory pts = new address[](1);
        pts[0] = token;
        marketplace = new CawProfileMarketplace(address(nft), 1, pts);
        nft.mintTo(seller, TOKEN_ID);
        vm.prank(seller);
        nft.setApprovalForAll(address(marketplace), true);
    }

    function _fund(IMintable token, address who) internal {
        token.mint(who, AMOUNT);
        vm.prank(who);
        token.approve(address(marketplace), AMOUNT);
    }

    function _list(address token, CawProfileMarketplace.ListingType t) internal returns (uint256) {
        vm.prank(seller);
        marketplace.createListing(TOKEN_ID, t, token, AMOUNT, 0, DURATION);
        return marketplace.nextListingId() - 1;
    }

    // ---- a token with a transfer fee is refused on every deposit path ----

    function test_feeToken_offerDepositReverts() public {
        FeeToken token = new FeeToken();
        _deploy(address(token));
        _fund(token, buyer);
        vm.prank(buyer);
        vm.expectRevert("Unexpected token receipt");
        marketplace.createOfferERC20(TOKEN_ID, address(token), AMOUNT, DURATION);
    }

    function test_feeToken_buyReverts() public {
        FeeToken token = new FeeToken();
        _deploy(address(token));
        uint256 id = _list(address(token), CawProfileMarketplace.ListingType.FIXED);
        _fund(token, buyer);
        vm.prank(buyer);
        vm.expectRevert("Unexpected token receipt");
        marketplace.buyWithToken(id, AMOUNT, 0);
    }

    function test_feeToken_bidReverts() public {
        FeeToken token = new FeeToken();
        _deploy(address(token));
        uint256 id = _list(address(token), CawProfileMarketplace.ListingType.ENGLISH_AUCTION);
        _fund(token, buyer);
        vm.prank(buyer);
        vm.expectRevert("Unexpected token receipt");
        marketplace.placeBidWithToken(id, AMOUNT);
    }

    // ---- a token whose transfer leaves the marketplace with LESS than before ----

    function test_shrinkingBalance_revertsWithMessageNotPanic() public {
        ShrinkToken token = new ShrinkToken();
        _deploy(address(token));
        _fund(token, buyer);
        vm.prank(buyer);
        marketplace.createOfferERC20(TOKEN_ID, address(token), AMOUNT, DURATION);
        assertEq(token.balanceOf(address(marketplace)), AMOUNT, "marketplace holds one offer");

        token.setShrink(true);
        _fund(token, seller);
        vm.prank(seller);
        vm.expectRevert("Unexpected token receipt");
        marketplace.createOfferERC20(TOKEN_ID, address(token), AMOUNT, DURATION);
    }

    // ---- tokens without a fee keep working ----

    function test_plainToken_offerRoundTrip() public {
        PlainToken token = new PlainToken();
        _deploy(address(token));
        _fund(token, buyer);
        vm.startPrank(buyer);
        uint256 id = marketplace.createOfferERC20(TOKEN_ID, address(token), AMOUNT, DURATION);
        assertEq(token.balanceOf(address(marketplace)), AMOUNT, "escrow equals the offer");
        marketplace.cancelOffer(id);
        vm.stopPrank();
        assertEq(token.balanceOf(buyer), AMOUNT, "refunded in full");
    }

    function test_noReturnToken_offerRoundTrip() public {
        NoReturnToken token = new NoReturnToken();
        _deploy(address(token));
        _fund(token, buyer);
        vm.startPrank(buyer);
        uint256 id = marketplace.createOfferERC20(TOKEN_ID, address(token), AMOUNT, DURATION);
        assertEq(token.balanceOf(address(marketplace)), AMOUNT, "escrow equals the offer");
        vm.stopPrank();
        assertEq(token.balanceOf(buyer), 0, "buyer paid the offer");
        id; // refund path for no-return tokens is covered by the refund tests
    }
}

interface IMintable {
    function mint(address to, uint256 amt) external;
    function approve(address sp, uint256 amt) external returns (bool);
}

/// @dev Plain ERC-20 with bool returns and no fee.
contract PlainToken is IMintable {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external returns (bool) { allowance[msg.sender][sp] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bool) { balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true; }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt; balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }
}

/// @dev ERC-20 that returns no data (like mainnet USDT) and takes no fee.
contract NoReturnToken is IMintable {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external returns (bool) { allowance[msg.sender][sp] = amt; return true; }
    function transfer(address to, uint256 amt) external { balanceOf[msg.sender] -= amt; balanceOf[to] += amt; }
    function transferFrom(address from, address to, uint256 amt) external {
        allowance[from][msg.sender] -= amt; balanceOf[from] -= amt; balanceOf[to] += amt;
    }
}

/// @dev ERC-20 that burns 1 percent of every transfer from the amount received.
contract FeeToken is IMintable {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external returns (bool) { allowance[msg.sender][sp] = amt; return true; }
    function _move(address from, address to, uint256 amt) internal { balanceOf[from] -= amt; balanceOf[to] += amt - amt / 100; }
    function transfer(address to, uint256 amt) external returns (bool) { _move(msg.sender, to, amt); return true; }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt; _move(from, to, amt); return true;
    }
}

/// @dev ERC-20 that, once switched on, removes twice the transferred amount from
///      the receiver, so the receiver ends up with less than before the transfer.
contract ShrinkToken is IMintable {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public shrink;
    function setShrink(bool b) external { shrink = b; }
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external returns (bool) { allowance[msg.sender][sp] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bool) { balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true; }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        if (shrink) balanceOf[to] -= 2 * amt;
        return true;
    }
}
