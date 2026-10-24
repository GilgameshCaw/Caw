// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfile.sol";
import "../contracts/CawProfileMarketplace.sol";
import "../contracts/CawNetworkManager.sol";
import "../contracts/MintableCaw.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

contract LzRefund_BuyAndBurn {
    receive() external payable {}
}

contract LzRefund_URI {
    function generate(string memory) external pure returns (string memory) { return ""; }
}

/// @dev Stand-in for an EIP-7702 account (SmartEOA.executeBatch): a relayer
///      submits the call, the ETH comes out of this account's own balance.
contract LzRefund_Account {
    function exec(address to, uint256 value, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
    receive() external payable {}
}

/// @dev Same, but it can't take ETH.
contract LzRefund_NoReceiveAccount {
    function exec(address to, uint256 value, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
}

/// @title MarketplaceLzRefundTest
/// @notice The unused part of the ETH sent for the LZ owner sync goes back to
///         the marketplace caller who paid it, not to tx.origin. Under an
///         EIP-7702 relay tx.origin is the relayer, so before this fix the
///         relayer kept the LZ overpay (and, for a Dutch sale, the price drop).
///         Real CawProfile + MockLayerZeroEndpoint (which keeps the fee and
///         refunds the excess to the refund address).
contract MarketplaceLzRefundTest is Test {
    uint32 constant L1_EID = 30101;
    uint32 constant L2_EID = 40245;
    uint32 constant NETWORK_ID = 1;

    CawProfile internal cawProfile;
    CawProfileMarketplace internal marketplace;
    MockLayerZeroEndpoint internal lzL1;
    MockLayerZeroEndpoint internal lzL2;
    MintableCaw internal caw;
    LzRefund_Account internal account;

    address internal seller  = address(0xA11CE);
    address internal buyer   = address(0xB0B);
    address internal relayer = address(0x5E1A);
    address internal offerer = address(0x0FFE);

    uint32 internal nextId = 1;

    receive() external payable {}

    function setUp() public {
        caw = new MintableCaw();
        lzL1 = new MockLayerZeroEndpoint(L1_EID);
        lzL2 = new MockLayerZeroEndpoint(L2_EID);
        CawNetworkManager nm = new CawNetworkManager(address(new LzRefund_BuyAndBurn()));
        cawProfile = new CawProfile(
            address(caw),
            address(new LzRefund_URI()),
            address(new LzRefund_BuyAndBurn()),
            address(nm),
            address(lzL1),
            L1_EID,
            address(0),         // priceReader
            address(0xDEAD),    // ledger: only used for mainnet-chosen tokens
            address(this),      // pathwayExpander (owner, for setPeer)
            address(this)       // minter
        );
        // The L2 peer only has to be a contract: the mock swallows delivery failures.
        cawProfile.setPeer(L2_EID, bytes32(uint256(uint160(address(lzL2)))));
        lzL1.setDestLzEndpoint(address(lzL2), address(lzL2));
        nm.createNetwork("TestNet", address(this), L2_EID, 0, 0, 0, 0, 5e11);

        address[] memory pts = new address[](1);
        pts[0] = address(caw);
        marketplace = new CawProfileMarketplace(address(cawProfile), L2_EID, pts);

        account = new LzRefund_Account();
        vm.deal(address(account), 10 ether);
        vm.deal(buyer, 10 ether);
        vm.deal(offerer, 10 ether);
        vm.deal(address(this), 10 ether);
        vm.prank(seller);
        cawProfile.setApprovalForAll(address(marketplace), true);
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    /// Mint `id` to `owner`; `onL2` puts it on L2_EID's chosen chains.
    function _mint(address owner, bool onL2) internal returns (uint32 id) {
        id = nextId++;
        string memory name = string(abi.encodePacked("u", vm.toString(id)));
        if (onL2) cawProfile.mintAndAuth{value: 1 ether}(NETWORK_ID, owner, name, id, L2_EID, 0, "");
        else cawProfile.mint(NETWORK_ID, owner, name, id, 0);
    }

    function _list(uint32 id, CawProfileMarketplace.ListingType t, uint256 start, uint256 end) internal returns (uint256) {
        vm.prank(seller);
        return marketplace.createListing(id, t, address(0), start, end, 1000);
    }

    /// What the LZ send actually cost: the mock endpoints keep the fee.
    function _lzHeld() internal view returns (uint256) {
        return address(lzL1).balance + address(lzL2).balance;
    }

    /// Relayer submits a call from `acct`; tx.origin == msg.sender == relayer.
    function _relay(address acct, address to, uint256 value, bytes memory data) internal {
        vm.prank(relayer, relayer);
        LzRefund_Account(payable(acct)).exec(to, value, data);
    }

    // ---------------------------------------------------------------------
    // tests
    // ---------------------------------------------------------------------

    function test_relayedFixedBuy_unusedLzEthBackToAccount() public {
        uint32 id = _mint(seller, true);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, 0.1 ether, 0);
        bytes memory data = abi.encodeCall(marketplace.buy, (lid, 0));
        uint256 a0 = address(account).balance;
        uint256 l0 = _lzHeld();

        _relay(address(account), address(marketplace), 0.15 ether, data);

        uint256 lzCost = _lzHeld() - l0;
        assertGt(lzCost, 0, "LZ send happened");
        assertEq(cawProfile.ownerOf(id), address(account));
        assertEq(relayer.balance, 0, "relayer kept nothing");
        assertEq(a0 - address(account).balance, 0.1 ether + lzCost, "account paid price + LZ fee only");
        assertEq(address(marketplace).balance, 0.1 ether, "marketplace holds only the seller payout");
        assertEq(address(cawProfile).balance, 0, "nothing stranded in CawProfile");
    }

    function test_relayedDutchBuy_priceDropBackToAccount() public {
        uint32 id = _mint(seller, true);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.DUTCH_AUCTION, 1 ether, 0.1 ether);
        vm.warp(block.timestamp + 500);
        // The FE sends the price it showed when the modal opened (the start price).
        bytes memory data = abi.encodeCall(marketplace.buy, (lid, 0));
        uint256 a0 = address(account).balance;
        uint256 l0 = _lzHeld();

        _relay(address(account), address(marketplace), 1.05 ether, data);

        uint256 price = 0.55 ether; // 1 - 0.9 * 500/1000
        assertEq(marketplace.pendingPayouts(seller), price);
        assertEq(relayer.balance, 0, "relayer kept nothing");
        assertEq(a0 - address(account).balance, price + (_lzHeld() - l0));
    }

    function test_relayedBuy_tokenNotOnL2_wholeExtraBack() public {
        uint32 id = _mint(seller, false);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, 0.1 ether, 0);
        bytes memory data = abi.encodeCall(marketplace.buy, (lid, 0));
        uint256 a0 = address(account).balance;
        uint256 l0 = _lzHeld();

        _relay(address(account), address(marketplace), 0.15 ether, data);

        assertEq(_lzHeld(), l0, "no LZ send");
        assertEq(relayer.balance, 0);
        assertEq(a0 - address(account).balance, 0.1 ether);
    }

    function test_relayedBuy_mainnetEid_noSendWholeExtraBack() public {
        uint32 id = _mint(seller, false);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, 0.1 ether, 0);
        bytes memory data = abi.encodeCall(marketplace.buy, (lid, L1_EID));
        uint256 a0 = address(account).balance;
        uint256 l0 = _lzHeld();

        _relay(address(account), address(marketplace), 0.12 ether, data);

        assertEq(_lzHeld(), l0);
        assertEq(relayer.balance, 0);
        assertEq(a0 - address(account).balance, 0.1 ether);
    }

    function test_relayedBuyWithToken_lzEthBackToAccount() public {
        uint32 id = _mint(seller, true);
        vm.prank(seller);
        uint256 lid = marketplace.createListing(id, CawProfileMarketplace.ListingType.FIXED, address(caw), 100 ether, 0, 1000);
        caw.mint(address(account), 100 ether);
        _relay(address(account), address(caw), 0, abi.encodeCall(caw.approve, (address(marketplace), 100 ether)));
        bytes memory data = abi.encodeCall(marketplace.buyWithToken, (lid, 100 ether, 0));
        uint256 a0 = address(account).balance;
        uint256 l0 = _lzHeld();

        _relay(address(account), address(marketplace), 0.05 ether, data);

        uint256 lzCost = _lzHeld() - l0;
        assertGt(lzCost, 0);
        assertEq(relayer.balance, 0);
        assertEq(a0 - address(account).balance, lzCost);
    }

    function test_relayedAcceptOffer_unusedLzEthBackToSellerAccount() public {
        uint32 id = _mint(address(account), true);
        vm.prank(offerer);
        uint256 oid = marketplace.createOfferETH{value: 0.2 ether}(id, 1000);
        _relay(address(account), address(cawProfile), 0, abi.encodeCall(cawProfile.setApprovalForAll, (address(marketplace), true)));
        bytes memory data = abi.encodeCall(marketplace.acceptOffer, (oid, 0));
        uint256 a0 = address(account).balance;
        uint256 l0 = _lzHeld();

        _relay(address(account), address(marketplace), 0.05 ether, data);

        uint256 lzCost = _lzHeld() - l0;
        assertGt(lzCost, 0);
        assertEq(cawProfile.ownerOf(id), offerer);
        assertEq(relayer.balance, 0);
        assertEq(a0 - address(account).balance, lzCost);
        assertEq(marketplace.pendingPayouts(address(account)), 0.2 ether);
    }

    function test_relayedSettleAuction_unusedLzEthBackToSettler() public {
        uint32 id = _mint(seller, true);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.ENGLISH_AUCTION, 0.1 ether, 0);
        vm.prank(buyer);
        marketplace.placeBid{value: 0.1 ether}(lid);
        vm.warp(block.timestamp + 1001);
        bytes memory data = abi.encodeCall(marketplace.settleAuction, (lid, 0));
        uint256 a0 = address(account).balance;
        uint256 l0 = _lzHeld();

        _relay(address(account), address(marketplace), 0.05 ether, data);

        assertEq(cawProfile.ownerOf(id), buyer);
        assertEq(relayer.balance, 0);
        assertEq(a0 - address(account).balance, _lzHeld() - l0);
    }

    function test_directBuy_unchanged() public {
        uint32 id = _mint(seller, true);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, 0.1 ether, 0);
        uint256 b0 = buyer.balance;
        uint256 l0 = _lzHeld();

        vm.prank(buyer, buyer);
        marketplace.buy{value: 0.15 ether}(lid, 0);

        uint256 lzCost = _lzHeld() - l0;
        assertGt(lzCost, 0);
        assertEq(b0 - buyer.balance, 0.1 ether + lzCost);
    }

    function test_callerRejectsEth_refundQueuedToPendingPayouts() public {
        uint32 id = _mint(seller, true);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, 0.1 ether, 0);
        LzRefund_NoReceiveAccount nr = new LzRefund_NoReceiveAccount();
        vm.deal(address(nr), 1 ether);
        bytes memory data = abi.encodeCall(marketplace.buy, (lid, 0));
        uint256 l0 = _lzHeld();

        _relay(address(nr), address(marketplace), 0.15 ether, data);

        uint256 lzCost = _lzHeld() - l0;
        assertEq(relayer.balance, 0);
        assertEq(marketplace.pendingPayouts(address(nr)), 0.05 ether - lzCost);
    }

    function test_tooLittleLzEth_revertsWithoutTouchingEscrow() public {
        // Escrow ETH in the marketplace via an unrelated offer.
        uint32 other = _mint(address(0xCAFE), false);
        vm.prank(offerer);
        marketplace.createOfferETH{value: 1 ether}(other, 1000);
        uint32 id = _mint(seller, true);
        uint256 lid = _list(id, CawProfileMarketplace.ListingType.FIXED, 0.1 ether, 0);
        uint256 m0 = address(marketplace).balance;

        vm.prank(buyer, buyer);
        vm.expectRevert(bytes("Insufficient LZ fee"));
        marketplace.buy{value: 0.1 ether}(lid, 0);

        assertEq(address(marketplace).balance, m0);
        assertEq(cawProfile.ownerOf(id), seller);
    }
}
