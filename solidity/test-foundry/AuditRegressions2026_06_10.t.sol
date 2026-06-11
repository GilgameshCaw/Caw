// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// =============================================================================
// AuditRegressions2026_06_10.t.sol
//
// Regression tests for four HIGH-severity fixes applied 2026-06-10:
//
//   VAULT-1   — CawProfile.mintAndDeposit now credits cawDepositedByPeer[lzDestId]
//               so a subsequent setWithdrawable debit no longer underflow-reverts.
//
//   RT-1      — CawProfileLedger.deposit takes a 4th `address owner` param.
//               bypassLZ mintAndDeposit passes the real owner → ownerOf is set.
//               depositFor passes address(0) → ownerOf is NOT overwritten.
//
//   MIX-1 /
//   MIX-1-ESC — processGroupSingle (ERC-1271 / sibling path) now enforces that
//               every action in the group shares groupActions[0].senderId.
//               Mixed-sender groups revert MixedSenders().
// =============================================================================

import "forge-std/Test.sol";
import "../contracts/CawProfile.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/CawActions.sol";
import "../contracts/MintableCaw.sol";
import "../contracts/CawNetworkManager.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

// ---------------------------------------------------------------------------
// Stubs (reused across all three test suites)
// ---------------------------------------------------------------------------

contract Stub_BuyAndBurn {
    receive() external payable {}
    function swapAndSplit(uint256, address) external payable returns (uint256) { return 0; }
}

contract Stub_URI {
    function generate(string memory) external pure returns (string memory) { return ""; }
}

// ---------------------------------------------------------------------------
// BaseSetup — full bypassLZ co-deployment with MAINNET_LZ_ID == L2_EID.
//
// Deploy order (nonce offsets from address(this)):
//   +0  cawToken
//   +1  buyAndBurn
//   +2  uriGen
//   +3  lzL1
//   +4  lzL2
//   +5  networkManager
//   +6  cawProfileLedger   (needs predicted CawProfile addr)
//   +7  cawActions         (needs CawProfileLedger addr)
//   +8  cawProfile         (needs CawProfileLedger + CawActions addrs)
// ---------------------------------------------------------------------------
contract AuditRegressionBase is Test {
    MintableCaw          internal cawToken;
    Stub_BuyAndBurn      internal buyAndBurn;
    Stub_URI             internal uriGen;
    CawNetworkManager    internal networkManager;
    CawProfileLedger     internal cawProfileLedger;
    CawActions           internal cawActions;
    CawProfile           internal cawProfile;

    uint32 constant MAINNET_LZ_ID = 1;
    uint32 constant L2_EID        = 1; // bypassLZ: L2_EID == MAINNET_LZ_ID
    uint32 constant NETWORK_ID    = 1;

    // Deployed once; reused across tests that need tokens.
    address internal USER  = vm.addr(0xA1);
    address internal USER2 = vm.addr(0xA2);
    uint32  internal TOKEN_ID  = 11;
    uint32  internal TOKEN_ID2 = 12;

    // ERC-1271 sibling address used for MIX-1 tests.
    // Not a real contract in these tests — we just need an address to prank from.
    address internal ERC1271_SIBLING;

    function setUp() public virtual {
        uint256 base = vm.getNonce(address(this));

        // Predict CawProfile address (nonce+8) before any deployments.
        address predictedProfile = vm.computeCreateAddress(address(this), base + 8);

        cawToken      = new MintableCaw();              // +0
        buyAndBurn    = new Stub_BuyAndBurn();          // +1
        uriGen        = new Stub_URI();                 // +2

        MockLayerZeroEndpoint lzL1 = new MockLayerZeroEndpoint(MAINNET_LZ_ID); // +3
        MockLayerZeroEndpoint lzL2 = new MockLayerZeroEndpoint(L2_EID);        // +4

        networkManager = new CawNetworkManager(address(buyAndBurn));            // +5

        // ERC-1271 sibling is a stable address we derive before CawProfileLedger.
        // We use vm.addr(0xBEEF) — not a contract, we'll vm.prank to call from it.
        ERC1271_SIBLING = vm.addr(0xBEEF);

        // +6: CawProfileLedger — needs predicted CawProfile (nonce+8).
        // _cawActions slot: we pass a placeholder first, then deploy CawActions (+7)
        // and CawProfile (+8). CawProfileLedger doesn't call cawActions in setUp.
        // We'll compute predictedActions too.
        address predictedLedger  = vm.computeCreateAddress(address(this), base + 6);
        address predictedActions = vm.computeCreateAddress(address(this), base + 7);

        cawProfileLedger = new CawProfileLedger(    // +6
            MAINNET_LZ_ID,
            address(lzL2),
            address(0),          // capOracle dormant
            predictedProfile,    // _cawProfile (nonce+8)
            predictedActions,    // _cawActions (nonce+7)
            ERC1271_SIBLING,     // _erc1271Sibling
            true,                // bypassLZ: co-deployment
            address(this)        // _pathwayExpander (test contract acts as it)
        );
        require(address(cawProfileLedger) == predictedLedger, "ledger nonce mismatch");

        // +7: CawActions — takes CawProfileLedger address.
        cawActions = new CawActions(
            address(cawProfileLedger),
            address(0),          // zkVerifier dormant
            bytes32(0),          // zkProgramVKey
            ERC1271_SIBLING,     // erc1271Sibling
            address(0),          // capOracle dormant
            0,                   // bootstrapRatio
            0                    // bootstrapExpiry
        );
        require(address(cawActions) == predictedActions, "actions nonce mismatch");

        // +8: CawProfile — needs CawProfileLedger + CawActions.
        cawProfile = new CawProfile(
            address(cawToken),
            address(uriGen),
            address(buyAndBurn),
            address(networkManager),
            address(lzL1),
            MAINNET_LZ_ID,
            address(0),               // minter = test contract itself (set below)
            address(cawProfileLedger),
            address(cawActions),
            address(this)             // pathwayExpander
        );
        require(address(cawProfile) == predictedProfile, "profile nonce mismatch");

        // Register a network (storageChainEid = L2_EID, all fees = 0).
        networkManager.createNetwork("TestNet", address(this), L2_EID, 0, 0, 0, 0, 5e11);

        // Fund users.
        cawToken.mint(address(this), 1_000_000 ether);
        cawToken.mint(USER,          1_000_000 ether);
        cawToken.mint(USER2,         1_000_000 ether);
    }

    // -------------------------------------------------------------------------
    // Helper: mint a token and deposit CAW in one bypassLZ call.
    // The test contract acts as minter (CawProfile constructor set it to address(this)).
    // -------------------------------------------------------------------------
    function _mintAndDeposit(address owner, uint32 tokenId, uint256 depositAmount) internal {
        cawToken.approve(address(cawProfile), depositAmount);
        cawProfile.mintAndDeposit(
            NETWORK_ID,
            owner,
            string(abi.encodePacked("u", vm.toString(tokenId))),
            tokenId,
            depositAmount,
            MAINNET_LZ_ID,  // bypassLZ path (MAINNET_LZ_ID == L2_EID)
            0,              // lzTokenAmount
            "",             // no session
            0,              // sponsorTokenId
            0               // repayAmount
        );
    }

    // -------------------------------------------------------------------------
    // Helper: pack a single CawActions action (ActionType.LIKE = 1, simplest
    // action that passes _applyAction without needing on-chain state beyond
    // a registered/authenticated token).  Layout mirrors _unpackAction:
    //   [1] actionType  [4] senderId  [4] receiverId  [4] receiverCawonce
    //   [4] networkId   [4] cawonce   [1] rc=0  [1] ac=0  [2] textLen=0
    // Total: 21 bytes per action.  groupBytes has NO header (processGroupSingle
    // takes the raw group slice, not the full packedActions with the count prefix).
    // -------------------------------------------------------------------------
    function _packAction(
        uint8  actionType,
        uint32 senderId,
        uint32 receiverId,
        uint32 networkId,
        uint32 cawonce
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            actionType,
            senderId,
            receiverId,
            uint32(0),  // receiverCawonce
            networkId,
            cawonce,
            uint8(0),   // recipientCount
            uint8(0),   // amountCount
            uint16(0)   // textLength
        );
    }
}

// =============================================================================
// VAULT-1 regression
// =============================================================================
contract Vault1RegressionTest is AuditRegressionBase {

    function test_vault1_mintAndDeposit_creditsDepositedByPeer() public {
        uint256 depositAmt = 500 ether;
        _mintAndDeposit(USER, TOKEN_ID, depositAmt);

        // cawDepositedByPeer[MAINNET_LZ_ID] must equal depositAmount.
        assertEq(
            cawProfile.cawDepositedByPeer(MAINNET_LZ_ID),
            depositAmt,
            "VAULT-1: cawDepositedByPeer not credited after mintAndDeposit"
        );
    }

    function test_vault1_setWithdrawable_does_not_revert_after_mintAndDeposit() public {
        uint256 depositAmt = 500 ether;
        _mintAndDeposit(USER, TOKEN_ID, depositAmt);

        // Simulate the L2→L1 setWithdrawable call (CawProfileLedger is the
        // authorised caller in bypassLZ mode).
        uint32[] memory tids = new uint32[](1);
        uint256[] memory amts = new uint256[](1);
        tids[0] = TOKEN_ID;
        amts[0] = depositAmt;

        // Should NOT revert (before fix: underflow revert at cawDepositedByPeer debit).
        vm.prank(address(cawProfileLedger));
        cawProfile.setWithdrawable(tids, amts);

        // cawDepositedByPeer zeroed out after the debit.
        assertEq(
            cawProfile.cawDepositedByPeer(MAINNET_LZ_ID),
            0,
            "VAULT-1: cawDepositedByPeer should be 0 after matching setWithdrawable"
        );

        assertEq(
            cawProfile.withdrawable(TOKEN_ID),
            depositAmt,
            "VAULT-1: withdrawable not set correctly"
        );
    }

    function test_vault1_depositFor_still_credits_depositedByPeer() public {
        // First mint a token without deposit so depositFor has something to top up.
        cawProfile.mint(NETWORK_ID, USER, "existinguser", TOKEN_ID, 0);

        uint256 depositAmt = 200 ether;
        vm.startPrank(USER);
        cawToken.approve(address(cawProfile), depositAmt);
        cawProfile.depositFor(NETWORK_ID, TOKEN_ID, depositAmt, MAINNET_LZ_ID, 0);
        vm.stopPrank();

        assertEq(
            cawProfile.cawDepositedByPeer(MAINNET_LZ_ID),
            depositAmt,
            "VAULT-1: depositFor should also credit cawDepositedByPeer"
        );
    }
}

// =============================================================================
// RT-1 regression
// =============================================================================
contract RT1RegressionTest is AuditRegressionBase {

    function test_rt1_ownerOf_set_after_mintAndDeposit() public {
        _mintAndDeposit(USER, TOKEN_ID, 100 ether);

        address onLedger = cawProfileLedger.ownerOf(TOKEN_ID);
        assertEq(
            onLedger,
            USER,
            "RT-1: ownerOf on CawProfileLedger not set after mintAndDeposit"
        );
    }

    function test_rt1_depositFor_does_not_reset_ownerOf() public {
        // Mint + deposit to establish USER as owner.
        _mintAndDeposit(USER, TOKEN_ID, 100 ether);

        // depositFor on the SAME token (existing) — must pass address(0) to ledger.
        uint256 topup = 50 ether;
        vm.startPrank(USER);
        cawToken.approve(address(cawProfile), topup);
        cawProfile.depositFor(NETWORK_ID, TOKEN_ID, topup, MAINNET_LZ_ID, 0);
        vm.stopPrank();

        // ownerOf must remain USER (not reset to address(0)).
        assertEq(
            cawProfileLedger.ownerOf(TOKEN_ID),
            USER,
            "RT-1: depositFor must not reset ownerOf"
        );

        // ownerSessionEpoch for USER must still be 0 — no owner-change occurred,
        // so _setOwnerOf's epoch bump branch was never triggered.
        // (tokenSessionEpoch is internal; ownerSessionEpoch[USER] being unchanged
        // is the observable proxy that no spurious epoch bump happened.)
        assertEq(
            cawProfileLedger.ownerSessionEpoch(USER),
            0,
            "RT-1: depositFor must not bump ownerSessionEpoch (no owner change)"
        );
    }

    function test_rt1_ownerOf_zero_without_deposit() public {
        // Plain mint (no deposit) → CawProfileLedger.mint is NOT called by CawProfile.mint,
        // so ownerOf stays address(0) until the first deposit or authenticate.
        cawProfile.mint(NETWORK_ID, USER, "plain", TOKEN_ID, 0);
        // CawProfile.mint does NOT call cawProfileLedger.mint in bypassLZ mode on its own;
        // the ledger only learns the owner via deposit() or authenticate().
        // Confirm: ownerOf == address(0) initially.
        assertEq(
            cawProfileLedger.ownerOf(TOKEN_ID),
            address(0),
            "RT-1: ownerOf should be zero before any deposit"
        );
    }

    // RT-1 SIBLING (audit 2026-06-11): plain mint → authenticate (no deposit).
    // Before the fix, the bypassLZ authenticate path called ledger auth() which
    // set authenticated=true but NEVER set ownerOf — leaving ownerOf==address(0)
    // and bricking every CawAction with SessionExpired. It ALSO passed swapped
    // args (tokenId, cawNetworkId), writing the wrong authenticated[] key.
    function test_rt1_sibling_authenticate_without_deposit_sets_ownerOf() public {
        // Plain mint: L1 owner = USER, but ledger ownerOf still 0.
        cawProfile.mint(NETWORK_ID, USER, "plain", TOKEN_ID, 0);
        assertEq(cawProfileLedger.ownerOf(TOKEN_ID), address(0), "precondition: ledger ownerOf 0");

        // Authenticate from the owner, NO deposit.
        vm.prank(USER);
        cawProfile.authenticate(NETWORK_ID, TOKEN_ID, MAINNET_LZ_ID, 0);

        // After fix: ledger ownerOf must be USER (token operable, not bricked).
        assertEq(
            cawProfileLedger.ownerOf(TOKEN_ID),
            USER,
            "RT-1 sibling: authenticate must set ledger ownerOf"
        );
        // And the auth flag must be on the CORRECT key (cawNetworkId, tokenId),
        // not the swapped (tokenId, cawNetworkId) the old callsite wrote.
        assertTrue(
            cawProfileLedger.authenticated(NETWORK_ID, TOKEN_ID),
            "RT-1 sibling: authenticated must be set on (networkId, tokenId)"
        );
    }
}

// =============================================================================
// MIX-1 regression — ERC-1271 sibling mixed-sender enforcement
// =============================================================================
contract Mix1RegressionTest is AuditRegressionBase {

    // -------------------------------------------------------------------------
    // Pack groupBytes for two actions with (possibly different) senderIds.
    // -------------------------------------------------------------------------
    function _packTwoActions(
        uint32 senderId0, uint32 cawonce0,
        uint32 senderId1, uint32 cawonce1
    ) internal view returns (bytes memory) {
        bytes memory a0 = _packAction(1, senderId0, senderId0, NETWORK_ID, cawonce0); // LIKE
        bytes memory a1 = _packAction(1, senderId1, senderId1, NETWORK_ID, cawonce1); // LIKE
        return abi.encodePacked(a0, a1);
    }

    function test_mix1_mixed_sender_erc1271_batch_reverts_MixedSenders() public {
        // Mint two tokens so ownerOf is set on the ledger (ownerOf is needed
        // to resolve ba.signer in _applyBatch, but MixedSenders fires BEFORE
        // that in the preVerifiedSigner branch, so the revert happens even
        // if the tokens aren't fully set up).
        _mintAndDeposit(USER,  TOKEN_ID,  100 ether);
        _mintAndDeposit(USER2, TOKEN_ID2, 100 ether);

        // groupBytes: action[0].senderId = TOKEN_ID, action[1].senderId = TOKEN_ID2 (different!)
        bytes memory groupBytes = _packTwoActions(
            TOKEN_ID,  1,
            TOKEN_ID2, 1
        );

        // The ERC-1271 sibling has pre-verified the signature for TOKEN_ID's owner.
        // It calls processGroupSingle with preVerifiedSigner = USER.
        // The MIX-1 guard must catch that action[1].senderId != action[0].senderId.
        vm.prank(ERC1271_SIBLING);
        vm.expectRevert(abi.encodeWithSignature("MixedSenders()"));
        cawActions.processGroupSingle(
            TOKEN_ID,     // validatorId (unused here since we revert)
            groupBytes,
            0,            // v (ignored in sibling path)
            bytes32(0),   // r (hash-chain anchor — dummy)
            bytes32(0),   // s (ignored in sibling path)
            2,            // groupSize
            USER          // preVerifiedSigner (non-zero → sibling path)
        );
    }

    function test_mix1_same_sender_erc1271_batch_does_NOT_revert() public {
        // Both actions share the same senderId → MixedSenders must NOT fire.
        // The call will proceed past the guard and fail elsewhere (e.g. cawonce
        // already used or token not authenticated for validator), but NOT with
        // MixedSenders. We check via vm.expectRevert on a specific selector.
        _mintAndDeposit(USER, TOKEN_ID, 100 ether);

        // Register TOKEN_ID as a validator so validatorId lookup doesn't revert.
        // CawActions._requireValidatorExists reads cawProfile.ownerOf(validatorId) != address(0).
        // TOKEN_ID is already minted and owned by USER on the ledger, so it qualifies.
        bytes memory groupBytes = _packTwoActions(
            TOKEN_ID, 1,
            TOKEN_ID, 2   // same senderId, cawonce 1 and 2 (contiguous — not enforced in sibling path)
        );

        vm.prank(ERC1271_SIBLING);
        // We do NOT expect MixedSenders. The call may revert for other reasons
        // (e.g. cawonce already used = CawonceUsed, or session not found =
        // SessionExpired). We just ensure MixedSenders is NOT raised.
        //
        // Strategy: catch any revert and assert its selector != MixedSenders().
        bytes4 MIXED_SENDERS = bytes4(keccak256("MixedSenders()"));
        try cawActions.processGroupSingle(
            TOKEN_ID,
            groupBytes,
            0,
            bytes32(0),
            bytes32(0),
            2,
            USER
        ) {
            // If it succeeds, great — definitely not MixedSenders.
        } catch (bytes memory reason) {
            if (reason.length >= 4) {
                bytes4 selector;
                assembly { selector := mload(add(reason, 32)) }
                assertNotEq(
                    selector,
                    MIXED_SENDERS,
                    "MIX-1: same-sender batch must not revert MixedSenders"
                );
            }
            // Any other revert (CawonceUsed, SessionExpired, etc.) is acceptable.
        }
    }

    function test_mix1_single_action_erc1271_does_NOT_revert_MixedSenders() public {
        // Single-action sibling call: the loop runs 0 iterations (i from 1 to groupSize=1),
        // so MixedSenders can never fire regardless of the senderId.
        _mintAndDeposit(USER, TOKEN_ID, 100 ether);

        bytes memory groupBytes = _packAction(1, TOKEN_ID, TOKEN_ID, NETWORK_ID, 1);

        vm.prank(ERC1271_SIBLING);
        bytes4 MIXED_SENDERS = bytes4(keccak256("MixedSenders()"));
        try cawActions.processGroupSingle(
            TOKEN_ID,
            groupBytes,
            0,
            bytes32(0),
            bytes32(0),
            1,           // groupSize = 1
            USER
        ) {
            // Success is fine.
        } catch (bytes memory reason) {
            if (reason.length >= 4) {
                bytes4 selector;
                assembly { selector := mload(add(reason, 32)) }
                assertNotEq(
                    selector,
                    MIXED_SENDERS,
                    "MIX-1: single-action sibling call must not revert MixedSenders"
                );
            }
        }
    }
}
