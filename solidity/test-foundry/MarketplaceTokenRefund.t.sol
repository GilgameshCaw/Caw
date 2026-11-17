// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfileMarketplace.sol";
import "./mocks/MockCawProfile.sol";

/// @notice Refunding an ERC-20 offer when the payment token does not return a
///         bool from transfer (Ethereum mainnet USDT behaves this way).
contract MarketplaceTokenRefundTest is Test {
    CawProfileMarketplace internal marketplace;
    MockCawProfile        internal nft;

    address internal offerer = address(0xB0B);
    address internal other   = address(0xCAFE);

    uint32  internal constant TOKEN_ID = 1;
    uint64  internal constant DURATION = 1 days;
    uint256 internal constant AMOUNT   = 100e6;

    function _deploy(address token) internal {
        nft = new MockCawProfile();
        address[] memory pts = new address[](1);
        pts[0] = token;
        marketplace = new CawProfileMarketplace(address(nft), 1, pts);
    }

    function _openOffer(NoReturnToken token) internal returns (uint256 offerId) {
        token.mint(offerer, AMOUNT);
        vm.startPrank(offerer);
        token.approve(address(marketplace), AMOUNT);
        offerId = marketplace.createOfferERC20(TOKEN_ID, address(token), AMOUNT, DURATION);
        vm.stopPrank();
    }

    function _isActive(uint256 offerId) internal view returns (bool active) {
        (, , , , , active) = marketplace.offers(offerId);
    }

    /// The offerer cancels and gets the escrow back.
    function test_cancelOffer_noReturnToken_refundsOfferer() public {
        NoReturnToken token = new NoReturnToken();
        _deploy(address(token));
        uint256 offerId = _openOffer(token);

        vm.prank(offerer);
        marketplace.cancelOffer(offerId);

        assertFalse(_isActive(offerId), "offer closed");
        assertEq(token.balanceOf(offerer), AMOUNT, "escrow returned");
        assertEq(token.balanceOf(address(marketplace)), 0, "marketplace holds nothing");
    }

    /// A blocklisted offerer: anyone can still close the expired offer, and the
    /// refund is queued for the offerer to pull to another address.
    function test_cancelOffer_noReturnToken_blockedOfferer_queuesRefund() public {
        NoReturnToken token = new NoReturnToken();
        _deploy(address(token));
        uint256 offerId = _openOffer(token);
        token.setBlocked(offerer, true);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(other);
        marketplace.cancelOffer(offerId);

        assertFalse(_isActive(offerId), "offer closed");
        assertEq(marketplace.pendingTokenPayouts(offerer, address(token)), AMOUNT, "refund queued");

        address fresh = address(0xF8E54);
        vm.prank(offerer);
        marketplace.withdrawTokenPayouts(address(token), fresh);
        assertEq(token.balanceOf(fresh), AMOUNT, "pulled to a fresh address");
        assertEq(marketplace.pendingTokenPayouts(offerer, address(token)), 0, "ledger cleared");
    }

    /// A token that returns false instead of reverting keeps working.
    function test_cancelOffer_falseReturningToken_queuesRefund() public {
        FalseReturnToken token = new FalseReturnToken();
        _deploy(address(token));
        token.mint(offerer, AMOUNT);
        vm.startPrank(offerer);
        token.approve(address(marketplace), AMOUNT);
        uint256 offerId = marketplace.createOfferERC20(TOKEN_ID, address(token), AMOUNT, DURATION);
        vm.stopPrank();
        token.setFailTransfers(true);

        vm.prank(offerer);
        marketplace.cancelOffer(offerId);

        assertEq(marketplace.pendingTokenPayouts(offerer, address(token)), AMOUNT, "refund queued");
    }
}

/// @dev ERC-20 whose transfer/transferFrom/approve return no data, like mainnet
///      USDT, and revert when the recipient is blocklisted.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function setBlocked(address a, bool b) external { blocked[a] = b; }
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external { allowance[msg.sender][sp] = amt; }
    function transfer(address to, uint256 amt) external {
        require(!blocked[to], "blocked");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
    }
    function transferFrom(address from, address to, uint256 amt) external {
        require(!blocked[to], "blocked");
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
    }
}

/// @dev ERC-20 whose transfer returns false (without reverting) when failing.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfers;

    function setFailTransfers(bool b) external { failTransfers = b; }
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external returns (bool) { allowance[msg.sender][sp] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bool) {
        if (failTransfers) return false;
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}
