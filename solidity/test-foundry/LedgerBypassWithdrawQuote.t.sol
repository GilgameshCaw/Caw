// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// CawProfileLedger.withdrawQuote on a bypassLZ ledger (the L1 co-deployment).
//
// On that ledger setWithdrawable calls CawProfile directly, sends no LayerZero
// message, and refuses a non-zero fee (NoFee). withdrawQuote still quoted an LZ
// message to layer1EndpointId, and a bypassLZ ledger has no peer, so it
// reverted with NoPeer, and so did CawActions.withdrawQuote, which forwards to
// it. ValidatorService asks CawActions.withdrawQuote before every batch that
// holds a WITHDRAW. These tests check that the quote is 0 on bypassLZ, that a
// setWithdrawable paid with it credits L1, and that a cross-chain ledger still
// quotes the LZ fee.

import "forge-std/Test.sol";
import "../contracts/CawProfile.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/CawActions.sol";
import "../contracts/MintableCaw.sol";
import "../contracts/CawNetworkManager.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

contract LBW_BuyAndBurn {
    receive() external payable {}
    function swapAndSplit(uint256, address) external payable returns (uint256) { return 0; }
}

contract LBW_URI {
    function generate(string memory) external pure returns (string memory) { return ""; }
}

contract LedgerBypassWithdrawQuoteTest is Test {
    MintableCaw       internal cawToken;
    CawNetworkManager internal networkManager;
    CawProfileLedger  internal ledger;      // bypassLZ: co-deployed on L1
    CawActions        internal cawActions;
    CawProfile        internal cawProfile;
    MockLayerZeroEndpoint internal lzL1;

    uint32 constant MAINNET_LZ_ID = 1;
    uint32 constant NETWORK_ID    = 1;
    uint32 constant TOKEN_ID      = 11;
    address internal USER = vm.addr(0xA1);
    address internal SIBLING = vm.addr(0xBEEF);

    function setUp() public {
        uint256 base = vm.getNonce(address(this));
        address predictedActions = vm.computeCreateAddress(address(this), base + 6);
        address predictedProfile = vm.computeCreateAddress(address(this), base + 7);

        cawToken = new MintableCaw();                                       // +0
        LBW_BuyAndBurn buyAndBurn = new LBW_BuyAndBurn();                   // +1
        LBW_URI uriGen = new LBW_URI();                                     // +2
        lzL1 = new MockLayerZeroEndpoint(MAINNET_LZ_ID);                    // +3
        networkManager = new CawNetworkManager(address(buyAndBurn));        // +4

        ledger = new CawProfileLedger(                                      // +5
            MAINNET_LZ_ID, address(lzL1), address(0),
            predictedProfile, predictedActions, SIBLING,
            true,                // _bypassLZ
            address(this)
        );
        cawActions = new CawActions(                                        // +6
            address(ledger), address(0), bytes32(0), SIBLING, address(0), 0, 0
        );
        require(address(cawActions) == predictedActions, "actions nonce mismatch");
        cawProfile = new CawProfile(                                        // +7
            address(cawToken), address(uriGen), address(buyAndBurn),
            address(networkManager), address(lzL1), MAINNET_LZ_ID,
            address(0), address(ledger), address(this), address(this)
        );
        require(address(cawProfile) == predictedProfile, "profile nonce mismatch");

        networkManager.createNetwork("L1Net", address(this), MAINNET_LZ_ID, 0, 0, 0, 0, 5e11);
        cawToken.mint(address(this), 1_000 ether);
    }

    function _one(uint256 amount) internal pure returns (uint32[] memory t, uint256[] memory a) {
        t = new uint32[](1); t[0] = TOKEN_ID;
        a = new uint256[](1); a[0] = amount;
    }

    function test_ledgerWithdrawQuote_bypass_isZero() public view {
        assertTrue(ledger.bypassLZ());
        (uint32[] memory t, uint256[] memory a) = _one(10 ether);
        MessagingFee memory q = ledger.withdrawQuote(t, a, false);
        assertEq(q.nativeFee, 0);
        assertEq(q.lzTokenFee, 0);
    }

    function test_ledgerWithdrawQuote_bypass_payInLzToken_isZero() public view {
        (uint32[] memory t, uint256[] memory a) = _one(10 ether);
        MessagingFee memory q = ledger.withdrawQuote(t, a, true);
        assertEq(q.nativeFee, 0);
        assertEq(q.lzTokenFee, 0);
    }

    // The entry point ValidatorService calls.
    function test_cawActionsWithdrawQuote_bypass_isZero() public view {
        (uint32[] memory t, uint256[] memory a) = _one(10 ether);
        MessagingFee memory q = cawActions.withdrawQuote(t, a, false);
        assertEq(q.nativeFee, 0);
        assertEq(q.lzTokenFee, 0);
    }

    // A batch of several withdrawals is still 0.
    function test_ledgerWithdrawQuote_bypass_batch_isZero() public view {
        uint32[] memory t = new uint32[](3);
        uint256[] memory a = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) { t[i] = uint32(TOKEN_ID + i); a[i] = (i + 1) * 1 ether; }
        MessagingFee memory q = cawActions.withdrawQuote(t, a, false);
        assertEq(q.nativeFee, 0);
        assertEq(q.lzTokenFee, 0);
    }

    // setWithdrawable paid with the quote credits L1; a non-zero fee is still refused.
    function test_setWithdrawable_withQuotedFee_creditsL1() public {
        cawToken.approve(address(cawProfile), 100 ether);
        cawProfile.mintAndDeposit(NETWORK_ID, USER, "withdrawer", TOKEN_ID, 100 ether, MAINNET_LZ_ID, 0, "", 0, 0);

        (uint32[] memory t, uint256[] memory a) = _one(40 ether);
        MessagingFee memory q = cawActions.withdrawQuote(t, a, false);

        vm.deal(address(cawActions), 1 ether);
        vm.prank(address(cawActions));
        ledger.setWithdrawable{value: q.nativeFee}(t, a, q.lzTokenFee);
        assertEq(cawProfile.withdrawable(TOKEN_ID), 40 ether);

        vm.prank(address(cawActions));
        vm.expectRevert(CawProfileLedger.NoFee.selector);
        ledger.setWithdrawable{value: 1}(t, a, 0);
    }

    // A cross-chain ledger (not bypassLZ) still quotes the LZ message.
    function test_ledgerWithdrawQuote_crossChain_quotesLzFee() public {
        MockLayerZeroEndpoint lzL2 = new MockLayerZeroEndpoint(2);
        CawProfileLedger remote = new CawProfileLedger(
            MAINNET_LZ_ID, address(lzL2), address(0),
            address(0xC0FFEE),   // L1 CawProfile peer
            address(0xdead), SIBLING,
            false,               // _bypassLZ
            address(this)
        );
        assertFalse(remote.bypassLZ());
        (uint32[] memory t, uint256[] memory a) = _one(10 ether);
        MessagingFee memory q = remote.withdrawQuote(t, a, false);
        assertGt(q.nativeFee, 0, "mock endpoint should charge an LZ fee");
    }
}
