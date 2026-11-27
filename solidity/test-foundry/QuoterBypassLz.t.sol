// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// authenticateQuote / depositQuote on a bypassLZ deployment (lzDestId == mainnetLzId).
//
// CawProfile.authenticate and deposit call the ledger directly on that path and
// send no LayerZero message, so they need only the storage fees. The two quote
// functions still called CawProfile.lzQuote, which reverts NoPeer because no
// peer is set for mainnetLzId. These tests quote on bypassLZ, pay exactly the
// quote into the real calls, and check that the cross-chain quotes still add
// the LayerZero fee to the storage fees.

import "forge-std/Test.sol";
import "../contracts/CawProfile.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/CawProfileQuoter.sol";
import "../contracts/MintableCaw.sol";
import "../contracts/CawNetworkManager.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

contract QBL_BuyAndBurn {
    receive() external payable {}
    function swapAndSplit(uint256, address) external payable returns (uint256) { return 0; }
}

contract QBL_URI {
    function generate(string memory) external pure returns (string memory) { return ""; }
}

contract QuoterBypassLzTest is Test {
    MintableCaw       internal cawToken;
    CawNetworkManager internal networkManager;
    CawProfileLedger  internal ledger;
    CawProfile        internal cawProfile;
    CawProfileQuoter  internal quoter;

    uint32 constant MAINNET_LZ_ID = 1;   // bypassLZ: the ledger is co-deployed on L1
    uint32 constant REMOTE_EID    = 2;   // a cross-chain peer, for the unchanged path
    uint32 constant FREE_NET      = 1;   // all fees 0
    uint32 constant PAID_NET      = 2;   // non-zero fees

    uint256 constant AUTH_FEE    = 3e14;
    uint256 constant DEPOSIT_FEE = 2e14;

    address internal USER = vm.addr(0xA1);
    uint32  constant TOKEN_ID = 7;

    function setUp() public {
        uint256 base = vm.getNonce(address(this));
        address predictedProfile = vm.computeCreateAddress(address(this), base + 6);

        cawToken = new MintableCaw();                                          // +0
        QBL_BuyAndBurn buyAndBurn = new QBL_BuyAndBurn();                      // +1
        QBL_URI uriGen = new QBL_URI();                                        // +2
        MockLayerZeroEndpoint lzL1 = new MockLayerZeroEndpoint(MAINNET_LZ_ID); // +3
        networkManager = new CawNetworkManager(address(buyAndBurn));           // +4

        ledger = new CawProfileLedger(                                         // +5
            MAINNET_LZ_ID,
            address(lzL1),
            address(0),          // capOracle dormant
            predictedProfile,    // _cawProfile
            address(0xdead),     // _cawActions (not exercised)
            address(0xcafe),     // _erc1271Sibling (not exercised)
            true,                // _bypassLZ: co-deployment
            address(this)        // _pathwayExpander
        );

        cawProfile = new CawProfile(                                           // +6
            address(cawToken), address(uriGen), address(buyAndBurn),
            address(networkManager), address(lzL1), MAINNET_LZ_ID,
            address(0),          // priceReader
            address(ledger),
            address(this),       // _pathwayExpander: OApp owner, so the test can setPeer
            address(this)        // _minter
        );
        require(address(cawProfile) == predictedProfile, "profile nonce mismatch");

        quoter = new CawProfileQuoter(address(cawProfile));

        // createNetwork starts each fee at its ceiling.
        networkManager.createNetwork("Free", address(this), MAINNET_LZ_ID, 0, 0, 0, 0, 5e11);
        networkManager.createNetwork("Paid", address(this), MAINNET_LZ_ID, 0, DEPOSIT_FEE, AUTH_FEE, 0, 5e11);
        assertEq(networkManager.getAuthFee(PAID_NET), AUTH_FEE);
        assertEq(networkManager.getDepositFee(PAID_NET), DEPOSIT_FEE);

        cawProfile.mint(FREE_NET, USER, "quoteuser", TOKEN_ID, 0);
        cawToken.mint(USER, 1_000 ether);
        vm.deal(USER, 1 ether);
        vm.prank(USER);
        cawToken.approve(address(cawProfile), type(uint256).max);
    }

    // ── bypassLZ: authenticateQuote ─────────────────────────────────────────

    function test_authenticateQuote_bypass_freeNetwork() public {
        MessagingFee memory q = quoter.authenticateQuote(FREE_NET, TOKEN_ID, MAINNET_LZ_ID, false);
        assertEq(q.nativeFee, 0);
        assertEq(q.lzTokenFee, 0);

        vm.prank(USER);
        cawProfile.authenticate{value: q.nativeFee}(FREE_NET, TOKEN_ID, MAINNET_LZ_ID, q.lzTokenFee);
        assertTrue(cawProfile.authenticated(FREE_NET, TOKEN_ID));
    }

    function test_authenticateQuote_bypass_paidNetwork() public {
        MessagingFee memory q = quoter.authenticateQuote(PAID_NET, TOKEN_ID, MAINNET_LZ_ID, false);
        assertEq(q.nativeFee, AUTH_FEE * 2);
        assertEq(q.lzTokenFee, 0);

        vm.prank(USER);
        cawProfile.authenticate{value: q.nativeFee}(PAID_NET, TOKEN_ID, MAINNET_LZ_ID, q.lzTokenFee);
        assertTrue(cawProfile.authenticated(PAID_NET, TOKEN_ID));
    }

    function test_authenticateQuote_bypass_payInLzToken_isNativeOnly() public view {
        MessagingFee memory q = quoter.authenticateQuote(PAID_NET, TOKEN_ID, MAINNET_LZ_ID, true);
        assertEq(q.nativeFee, AUTH_FEE * 2);
        assertEq(q.lzTokenFee, 0);
    }

    // ── bypassLZ: depositQuote ──────────────────────────────────────────────

    function test_depositQuote_bypass_notAuthenticated() public {
        assertFalse(cawProfile.authenticated(PAID_NET, TOKEN_ID));
        MessagingFee memory q = quoter.depositQuote(PAID_NET, TOKEN_ID, 10 ether, MAINNET_LZ_ID, false);
        assertEq(q.nativeFee, (DEPOSIT_FEE + AUTH_FEE) * 2);
        assertEq(q.lzTokenFee, 0);

        vm.prank(USER);
        cawProfile.deposit{value: q.nativeFee}(PAID_NET, TOKEN_ID, 10 ether, MAINNET_LZ_ID, q.lzTokenFee);
        assertTrue(cawProfile.authenticated(PAID_NET, TOKEN_ID));
        assertEq(ledger.cawBalanceOf(TOKEN_ID), 10 ether);
    }

    function test_depositQuote_bypass_authenticated() public {
        // Authenticate first, so the deposit quote leaves out the auth fee.
        MessagingFee memory a = quoter.authenticateQuote(PAID_NET, TOKEN_ID, MAINNET_LZ_ID, false);
        vm.prank(USER);
        cawProfile.authenticate{value: a.nativeFee}(PAID_NET, TOKEN_ID, MAINNET_LZ_ID, 0);

        MessagingFee memory q = quoter.depositQuote(PAID_NET, TOKEN_ID, 10 ether, MAINNET_LZ_ID, false);
        assertEq(q.nativeFee, DEPOSIT_FEE * 2);
        assertEq(q.lzTokenFee, 0);

        vm.prank(USER);
        cawProfile.deposit{value: q.nativeFee}(PAID_NET, TOKEN_ID, 10 ether, MAINNET_LZ_ID, q.lzTokenFee);
        assertEq(ledger.cawBalanceOf(TOKEN_ID), 10 ether);
    }

    function test_depositQuote_bypass_payInLzToken_isNativeOnly() public view {
        MessagingFee memory q = quoter.depositQuote(PAID_NET, TOKEN_ID, 10 ether, MAINNET_LZ_ID, true);
        assertEq(q.nativeFee, (DEPOSIT_FEE + AUTH_FEE) * 2);
        assertEq(q.lzTokenFee, 0);
    }

    // The bypassLZ quotes now agree with depositZapQuote, which already had the short-circuit.
    function test_depositQuote_bypass_matchesDepositZapQuote() public view {
        MessagingFee memory q = quoter.depositQuote(PAID_NET, TOKEN_ID, 10 ether, MAINNET_LZ_ID, false);
        MessagingFee memory z = quoter.depositZapQuote(PAID_NET, TOKEN_ID, MAINNET_LZ_ID, false);
        assertEq(q.nativeFee, z.nativeFee);
        assertEq(q.lzTokenFee, z.lzTokenFee);
    }

    // ── cross-chain (lzDestId != mainnetLzId): unchanged ────────────────────

    function _setRemotePeer() internal {
        cawProfile.setPeer(REMOTE_EID, bytes32(uint256(uint160(address(0xBEEF)))));
    }

    function _bundleLzFee(uint32 networkId, uint256 amount) internal view returns (MessagingFee memory) {
        // Same payload the quoter builds: no pending transfer updates here.
        bytes4 sel = bytes4(keccak256(
            "lzDepositMintSession(uint32,uint32,uint256,string,address,uint64,uint256,uint64,uint32[],address[],uint64[])"
        ));
        (uint32[] memory t, address[] memory o, uint64[] memory s) = cawProfile.pendingTransferUpdates(REMOTE_EID, address(this), TOKEN_ID);
        bytes memory payload = abi.encodeWithSelector(
            sel, networkId, TOKEN_ID, amount, "", address(0), uint64(0), uint256(0), uint64(0), t, o, s
        );
        return cawProfile.lzQuote(networkId, sel, t.length, payload, REMOTE_EID, false);
    }

    function test_authenticateQuote_crossChain_addsLzFee() public {
        _setRemotePeer();
        MessagingFee memory lz = _bundleLzFee(PAID_NET, 0);
        assertGt(lz.nativeFee, 0, "mock endpoint should charge an LZ fee");

        MessagingFee memory q = quoter.authenticateQuote(PAID_NET, TOKEN_ID, REMOTE_EID, false);
        assertEq(q.nativeFee, lz.nativeFee + AUTH_FEE * 2);
        assertEq(q.lzTokenFee, lz.lzTokenFee);
    }

    function test_depositQuote_crossChain_addsLzFee() public {
        _setRemotePeer();
        MessagingFee memory lz = _bundleLzFee(PAID_NET, 10 ether);
        assertGt(lz.nativeFee, 0, "mock endpoint should charge an LZ fee");

        MessagingFee memory q = quoter.depositQuote(PAID_NET, TOKEN_ID, 10 ether, REMOTE_EID, false);
        assertEq(q.nativeFee, lz.nativeFee + (DEPOSIT_FEE + AUTH_FEE) * 2);
        assertEq(q.lzTokenFee, lz.lzTokenFee);
    }

    // A cross-chain quote with no peer still reverts, as before.
    function test_crossChain_noPeer_stillReverts() public {
        vm.expectRevert(abi.encodeWithSignature("NoPeer(uint32)", REMOTE_EID));
        quoter.authenticateQuote(PAID_NET, TOKEN_ID, REMOTE_EID, false);
        vm.expectRevert(abi.encodeWithSignature("NoPeer(uint32)", REMOTE_EID));
        quoter.depositQuote(PAID_NET, TOKEN_ID, 10 ether, REMOTE_EID, false);
    }
}
