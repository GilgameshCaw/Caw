// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// =============================================================================
// ZkActionsPath.t.sol
// =============================================================================
//
// Foundry port of the scenarios in test/zk-actions-test.js. That Truffle file
// does not reach its first test on master (its fullSetup predicts CawProfile /
// CawActions addresses from a nonce read after nine deploys, passes CawActions
// five constructor args instead of seven, and never links SessionMessageParser
// into CawProfileLedger), so none of these processActionsWithZkSigs scenarios
// were running anywhere.
//
//   test_happyPath_allExecute               3 actions → bitmap 0b111, count +3
//   test_verifierRejects_reverts            mock rejects → revert, cawonce unused
//   test_verifierReceivesExpectedInputs     verifyProof gets the key, public values, proof
//   test_signersLengthMismatch_reverts      2 actions, 1 signer → ZkSignersMismatch
//   test_usedCawonce_skippedNotReverted     pre-used slot → bitmap 0b101, count +2
//   test_signerMismatchInGroup_reverts      group of 2, two signers → SignerMismatch
//   test_noVerifier_reverts                 zkVerifier = 0 → ZkNotConfigured
//   test_skippedWithdraw_notCreditedOnL1    skipped WITHDRAW → no L1 credit, no L2 debit
//   test_executedWithdraw_creditedOnL1      control for the above: one credit, one debit
//   test_expiredSession_reverts             live session executes, expired → SessionExpired
//
// Setup strategy
// ─────────────
// • Same as SessionProfileScoping.t.sol (bypassLZ ledger, this contract as the
//   L1 CawProfile), plus a MockSP1Verifier wired into CawActions.
// • Because this contract is the ledger's cawProfile, the ledger's bypassLZ
//   setWithdrawable lands in setWithdrawable() below, which records the L1
//   credits the withdraw scenarios assert on.
// • The ZK path takes signers from the `signers` blob and never runs
//   ecrecover, so the (v, r, s) in packedSigs only have to parse. r is still
//   the hash-chain anchor, so each group gets its own.
// • UNFOLLOW stands in for the JS file's CAW / LIKE actions: it costs nothing,
//   so no balance setup is needed outside the withdraw scenarios.
// =============================================================================

import "forge-std/Test.sol";
import "../contracts/CawActions.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/MockLayerZeroEndpoint.sol";
import "../contracts/test-helpers/MockSP1Verifier.sol";

contract ZkActionsPathTest is Test {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint32 constant NETWORK_ID   = 1;
    uint32 constant TOKEN_A      = 10;
    uint32 constant TOKEN_B      = 20;
    uint32 constant VALIDATOR_ID = 99;

    uint256 constant OWNER_PK   = 0xA11CE1;  // owns TOKEN_A
    uint256 constant OWNER2_PK  = 0xB0B2;    // owns TOKEN_B
    uint256 constant SESSION_PK = 0x5E55101; // wallet-scoped session key of OWNER_PK

    // ActionType enum mirrors CawActions.sol:83
    uint8 constant ACTION_UNFOLLOW = 5;
    uint8 constant ACTION_WITHDRAW = 6;

    bytes32 constant DELEGATION_TYPEHASH = keccak256(
        "SessionDelegation(address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)"
    );
    bytes32 constant ACTIONDATA_TYPEHASH = keccak256(
        "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 networkId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)"
    );

    bytes constant PROOF = hex"abab"; // ignored by the mock

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    MockLayerZeroEndpoint lzEndpoint;
    MockSP1Verifier       verifier;
    CawProfileLedger      ledger;
    CawActions            actions;

    address owner;
    address owner2;
    address sessionKey;

    // L1 credits forwarded by the ledger in bypassLZ mode.
    uint256 setWithdrawableCalls;
    mapping(uint32 => uint256) l1Withdrawable;

    // -----------------------------------------------------------------------
    // setUp
    // -----------------------------------------------------------------------

    function setUp() public {
        owner      = vm.addr(OWNER_PK);
        owner2     = vm.addr(OWNER2_PK);
        sessionKey = vm.addr(SESSION_PK);

        lzEndpoint = new MockLayerZeroEndpoint(40245);
        verifier   = new MockSP1Verifier();

        //   nonce(this)+0 = ledger (next)
        //   nonce(this)+1 = actions (after that)
        address predictedActions = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);

        ledger = new CawProfileLedger(
            30101,                  // _endpointId (L1 EID)
            address(lzEndpoint),    // _endpoint
            address(0),             // _capOracle (dormant)
            address(this),          // _cawProfile  ← test contract acts as L1 CawProfile
            predictedActions,       // _cawActions
            address(0xbeef),        // _erc1271Sibling (dummy non-zero)
            true,                   // _bypassLZ
            address(this)           // _pathwayExpander
        );

        actions = new CawActions(
            address(ledger),
            address(verifier),      // _zkVerifier
            bytes32(uint256(0x11)), // _zkProgramVKey (the mock ignores it; test_verifierReceivesExpectedInputs pins it)
            address(0),             // _erc1271Sibling
            address(0),             // _capOracle
            0,                      // _bootstrapRatio
            0                       // _bootstrapExpiry
        );
        require(address(actions) == predictedActions, "actions addr mismatch");

        ledger.mint(TOKEN_A, owner, "tokenA", uint64(block.number));
        ledger.mint(TOKEN_B, owner2, "tokenB", uint64(block.number));
        ledger.auth(NETWORK_ID, TOKEN_A, address(0));
        ledger.auth(NETWORK_ID, TOKEN_B, address(0));

        ledger.mint(VALIDATOR_ID, address(this), "validator", uint64(block.number));
        ledger.auth(NETWORK_ID, VALIDATOR_ID, address(0));
    }

    /// @dev L1 CawProfile hook. CawProfileLedger.setWithdrawable calls this
    ///      directly in bypassLZ mode.
    function setWithdrawable(uint32[] memory tokenIds, uint256[] memory amounts) external {
        require(msg.sender == address(ledger), "not ledger");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            l1Withdrawable[tokenIds[i]] += amounts[i];
        }
        setWithdrawableCalls++;
    }

    // -----------------------------------------------------------------------
    // Packed-calldata helpers (layout in CawActions.sol:290)
    // -----------------------------------------------------------------------

    /// @dev One action slice, without the actionCount header. Empty text.
    function _slice(
        uint8 actionType,
        uint32 senderId,
        uint32 receiverId,
        uint32 cawonce,
        uint32[] memory recipients,
        uint64[] memory amounts
    ) internal pure returns (bytes memory s) {
        s = abi.encodePacked(
            actionType,
            senderId,
            receiverId,
            uint32(0),               // receiverCawonce
            NETWORK_ID,
            cawonce,
            uint8(recipients.length),
            uint8(amounts.length)
        );
        for (uint256 i = 0; i < recipients.length; i++) s = abi.encodePacked(s, recipients[i]);
        for (uint256 i = 0; i < amounts.length; i++) s = abi.encodePacked(s, amounts[i]);
        s = abi.encodePacked(s, uint16(0)); // textLength
    }

    function _unfollow(uint32 cawonce) internal pure returns (bytes memory) {
        return _slice(ACTION_UNFOLLOW, TOKEN_A, TOKEN_B, cawonce, new uint32[](0), new uint64[](0));
    }

    /// @dev Canonical WITHDRAW shape: recipients=[senderId], amounts=[whole CAW].
    function _withdraw(uint32 cawonce, uint64 amount) internal pure returns (bytes memory) {
        return _slice(ACTION_WITHDRAW, TOKEN_A, 0, cawonce, _ids(TOKEN_A), _amts(amount));
    }

    function _ids(uint32 a) internal pure returns (uint32[] memory r) {
        r = new uint32[](1);
        r[0] = a;
    }

    function _amts(uint64 a) internal pure returns (uint64[] memory r) {
        r = new uint64[](1);
        r[0] = a;
    }

    function _pack(bytes memory a) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(1), a);
    }

    function _pack(bytes memory a, bytes memory b) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(2), a, b);
    }

    function _pack(bytes memory a, bytes memory b, bytes memory c) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(3), a, b, c);
    }

    /// @dev n single-action groups with placeholder (v, r, s); r differs per group.
    function _singleSigs(uint256 n) internal pure returns (bytes memory sigs) {
        sigs = abi.encodePacked(uint16(n));
        for (uint256 i = 0; i < n; i++) {
            sigs = abi.encodePacked(sigs, uint16(1), uint8(27), bytes32(i + 1), bytes32(uint256(1)));
        }
    }

    /// @dev `signer` repeated n times, 20 bytes each.
    function _signers(address signer, uint256 n) internal pure returns (bytes memory s) {
        for (uint256 i = 0; i < n; i++) s = abi.encodePacked(s, signer);
    }

    function _zk(bytes memory packed, bytes memory sigs, bytes memory signers) internal {
        actions.processActionsWithZkSigs(VALIDATOR_ID, packed, sigs, signers, PROOF, 0, 0);
    }

    // -----------------------------------------------------------------------
    // EIP-712 helpers (sig-path pre-steps and session registration)
    // -----------------------------------------------------------------------

    function _actionDigest(
        uint8 actionType,
        uint32 senderId,
        uint32 receiverId,
        uint32 cawonce,
        uint32[] memory recipients,
        uint64[] memory amounts
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            ACTIONDATA_TYPEHASH,
            uint256(actionType),
            uint256(senderId),
            uint256(receiverId),
            uint256(0),              // receiverCawonce
            uint256(NETWORK_ID),
            uint256(cawonce),
            keccak256(abi.encodePacked(recipients)),
            keccak256(abi.encodePacked(amounts)),
            keccak256(new bytes(0))  // text
        ));
        return keccak256(abi.encodePacked("\x19\x01", actions.eip712DomainHash(), structHash));
    }

    /// @dev Single-group sigs blob carrying a real owner signature.
    function _ownerSig(bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);
        return abi.encodePacked(uint16(1), uint16(1), v, r, s);
    }

    function _registerWalletSession(uint64 expiry) internal {
        uint8 scope = 0xBF; // all bits except WITHDRAW (bit 6)
        uint256 nonce = ledger.sessionNonce(owner);
        bytes32 structHash = keccak256(abi.encode(
            DELEGATION_TYPEHASH, sessionKey, expiry, scope, uint256(0), uint64(0), nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ledger.eip712DomainHash(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);
        ledger.registerSession(owner, sessionKey, expiry, scope, 0, 0, nonce, abi.encodePacked(r, s, v));
    }

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    function test_happyPath_allExecute() public {
        uint32 start = uint32(actions.nextCawonce(TOKEN_A));
        bytes memory packed = _pack(_unfollow(start), _unfollow(start + 1), _unfollow(start + 2));
        uint256 countBefore = actions.networkActionCount(NETWORK_ID);

        vm.expectEmit(true, true, false, true, address(actions));
        emit CawActions.ActionsProcessedZk(NETWORK_ID, VALIDATOR_ID, 3, 0x7, keccak256(packed));
        _zk(packed, _singleSigs(3), _signers(owner, 3));

        for (uint32 i = 0; i < 3; i++) {
            assertTrue(actions.isCawonceUsed(TOKEN_A, start + i), "cawonce not used");
        }
        assertEq(actions.networkActionCount(NETWORK_ID) - countBefore, 3, "hash chain must advance by 3");
    }

    function test_verifierRejects_reverts() public {
        verifier.setShouldAccept(false);
        uint32 start = uint32(actions.nextCawonce(TOKEN_A));
        bytes memory packed = _pack(_unfollow(start));

        vm.expectRevert(bytes("Mock verifier: rejected"));
        _zk(packed, _singleSigs(1), _signers(owner, 1));

        assertFalse(actions.isCawonceUsed(TOKEN_A, start), "cawonce consumed despite revert");
    }

    // The mock ignores its arguments, so the other tests pass whatever
    // CawActions hands it. Pin the call itself: the constructor's key, the four
    // public-value words and the proof bytes. This checks the wiring only, not
    // anything about real SP1 proofs.
    function test_verifierReceivesExpectedInputs() public {
        uint32 start = uint32(actions.nextCawonce(TOKEN_A));
        bytes memory packed  = _pack(_unfollow(start), _unfollow(start + 1));
        bytes memory sigs    = _singleSigs(2);
        bytes memory signers = _signers(owner, 2);

        bytes memory publicValues = abi.encode(
            keccak256(packed),
            keccak256(sigs),
            keccak256(signers),
            actions.eip712DomainHash()
        );
        vm.expectCall(
            address(verifier),
            abi.encodeCall(ISP1Verifier.verifyProof, (bytes32(uint256(0x11)), publicValues, PROOF)),
            1
        );
        _zk(packed, sigs, signers);
    }

    function test_signersLengthMismatch_reverts() public {
        uint32 start = uint32(actions.nextCawonce(TOKEN_A));
        bytes memory packed = _pack(_unfollow(start), _unfollow(start + 1));

        // One signer for two actions.
        vm.expectRevert(CawActions.ZkSignersMismatch.selector);
        _zk(packed, _singleSigs(2), _signers(owner, 1));
    }

    function test_usedCawonce_skippedNotReverted() public {
        uint32 start = uint32(actions.nextCawonce(TOKEN_A));
        uint32 used = start + 1;

        // Consume `used` through the sig path first.
        bytes memory sigs = _ownerSig(
            _actionDigest(ACTION_UNFOLLOW, TOKEN_A, TOKEN_B, used, new uint32[](0), new uint64[](0))
        );
        actions.processActions(VALIDATOR_ID, _pack(_unfollow(used)), sigs, 0, 0);
        assertTrue(actions.isCawonceUsed(TOKEN_A, used), "pre-step did not consume cawonce");

        bytes memory packed = _pack(_unfollow(start), _unfollow(used), _unfollow(start + 2));
        uint256 countBefore = actions.networkActionCount(NETWORK_ID);

        // Bit 1 clear: the middle slot was skipped, the batch did not revert.
        vm.expectEmit(true, true, false, true, address(actions));
        emit CawActions.ActionsProcessedZk(NETWORK_ID, VALIDATOR_ID, 3, 0x5, keccak256(packed));
        _zk(packed, _singleSigs(3), _signers(owner, 3));

        assertTrue(actions.isCawonceUsed(TOKEN_A, start), "slot 0 not executed");
        assertTrue(actions.isCawonceUsed(TOKEN_A, start + 2), "slot 2 not executed");
        assertEq(actions.networkActionCount(NETWORK_ID) - countBefore, 2, "hash chain must advance by 2");
    }

    function test_signerMismatchInGroup_reverts() public {
        uint32 start = uint32(actions.nextCawonce(TOKEN_A));
        bytes memory packed = _pack(_unfollow(start), _unfollow(start + 1));
        // One batch-sig group of size 2.
        bytes memory sigs = abi.encodePacked(uint16(1), uint16(2), uint8(27), bytes32(uint256(1)), bytes32(uint256(1)));

        // A malicious prover slipping a second signer into the group.
        vm.expectRevert(CawActions.SignerMismatch.selector);
        _zk(packed, sigs, abi.encodePacked(owner, owner2));
    }

    function test_noVerifier_reverts() public {
        CawActions noVerifier = new CawActions(address(ledger), address(0), bytes32(0), address(0), address(0), 0, 0);
        bytes memory packed = _pack(_unfollow(0));

        vm.expectRevert(CawActions.ZkNotConfigured.selector);
        noVerifier.processActionsWithZkSigs(VALIDATOR_ID, packed, _singleSigs(1), _signers(owner, 1), "", 0, 0);
    }

    /// @notice A WITHDRAW whose cawonce was already used by the sig path must
    ///         be skipped without a second L2 debit or a second L1 credit.
    function test_skippedWithdraw_notCreditedOnL1() public {
        ledger.deposit(NETWORK_ID, TOKEN_A, 1_000 ether, address(0));
        uint32 k = uint32(actions.nextCawonce(TOKEN_A));

        // Sig path executes the WITHDRAW at k: one L1 credit of 100 CAW.
        bytes memory sigs = _ownerSig(_actionDigest(ACTION_WITHDRAW, TOKEN_A, 0, k, _ids(TOKEN_A), _amts(100)));
        actions.processActions(VALIDATOR_ID, _pack(_withdraw(k, 100)), sigs, 0, 0);
        assertEq(setWithdrawableCalls, 1, "sig-path WITHDRAW did not reach L1");
        assertEq(l1Withdrawable[TOKEN_A], 100 ether, "sig-path L1 credit");
        uint256 balanceBefore = ledger.cawBalanceOf(TOKEN_A);

        // ZK batch replays the same WITHDRAW between two fresh UNFOLLOWs.
        bytes memory packed = _pack(_unfollow(k + 1), _withdraw(k, 100), _unfollow(k + 2));
        vm.expectEmit(true, true, false, true, address(actions));
        emit CawActions.ActionsProcessedZk(NETWORK_ID, VALIDATOR_ID, 3, 0x5, keccak256(packed));
        _zk(packed, _singleSigs(3), _signers(owner, 3));

        assertEq(setWithdrawableCalls, 1, "skipped WITHDRAW reached L1");
        assertEq(l1Withdrawable[TOKEN_A], 100 ether, "L1 credited twice");
        assertEq(ledger.cawBalanceOf(TOKEN_A), balanceBefore, "L2 debited twice");
    }

    /// @notice Control for the test above: an executed ZK-path WITHDRAW does
    ///         reach setWithdrawable, so a zero there is not a dead hook.
    function test_executedWithdraw_creditedOnL1() public {
        ledger.deposit(NETWORK_ID, TOKEN_A, 1_000 ether, address(0));
        uint32 k = uint32(actions.nextCawonce(TOKEN_A));
        uint256 balanceBefore = ledger.cawBalanceOf(TOKEN_A);

        _zk(_pack(_withdraw(k, 100)), _singleSigs(1), _signers(owner, 1));

        assertEq(setWithdrawableCalls, 1, "ZK-path WITHDRAW did not reach L1");
        assertEq(l1Withdrawable[TOKEN_A], 100 ether, "ZK-path L1 credit");
        assertEq(balanceBefore - ledger.cawBalanceOf(TOKEN_A), 100 ether, "ZK-path L2 debit");
    }

    function test_expiredSession_reverts() public {
        _registerWalletSession(uint64(block.timestamp + 60));
        uint32 start = uint32(actions.nextCawonce(TOKEN_A));

        // Control: while the session is live, the session key executes.
        _zk(_pack(_unfollow(start)), _singleSigs(1), _signers(sessionKey, 1));
        assertTrue(actions.isCawonceUsed(TOKEN_A, start), "live session did not execute");

        vm.warp(block.timestamp + 3600);
        bytes memory packed = _pack(_unfollow(start + 1));

        vm.expectRevert(CawActions.SessionExpired.selector);
        _zk(packed, _singleSigs(1), _signers(sessionKey, 1));
    }
}
