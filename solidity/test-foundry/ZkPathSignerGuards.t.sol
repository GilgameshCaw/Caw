// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// =============================================================================
// ZkPathSignerGuards.t.sol
// =============================================================================
//
// processActionsWithZkSigs trusts the prover's signers[] instead of running
// ecrecover. Two checks the sig path makes on-chain were left to the circuit
// alone on the ZK path:
//
//   1. signer != address(0). The sig path only treats the recovered signer as
//      the owner when it is non-zero (_verifySignatureMem). CawProfileLedger's
//      ownerOf returns address(0) for a token that is authenticated but whose
//      owner was never synced, so a zero signer on the ZK path would be taken
//      as that token's owner.
//   2. Contiguous cawonces inside a batch-sig group. The sig path reverts with
//      NonContiguousCawonces (_unpackBatchGroup); the ZK path only checked the
//      sender.
//
// The honest SP1 program never emits either (it panics on a bad signature and
// asserts contiguity), so these are defence-in-depth guards against a faulty
// circuit. The tests drive the on-chain side directly with MockSP1Verifier.
//
// Actions: UNFOLLOW (ActionType 5) — zero protocol cost, no balance needed.
// Setup mirrors SessionProfileScoping.t.sol.
// =============================================================================

import "forge-std/Test.sol";
import "../contracts/CawActions.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/MockLayerZeroEndpoint.sol";
import "../contracts/test-helpers/MockSP1Verifier.sol";

contract ZkPathSignerGuardsTest is Test {
    uint32 constant NETWORK_ID   = 1;
    uint32 constant TOKEN_A      = 10;
    uint32 constant TOKEN_B      = 20;
    uint32 constant TOKEN_NO_OWNER = 30; // authenticated, ownerOf never set
    uint32 constant VALIDATOR_ID = 99;

    uint256 constant OWNER_PK = 0xA11CE1;

    uint8 constant ACTION_UNFOLLOW = 5;

    MockLayerZeroEndpoint lzEndpoint;
    CawProfileLedger      ledger;
    CawActions            actions;
    MockSP1Verifier       verifier;

    address owner;

    function setUp() public {
        owner = vm.addr(OWNER_PK);

        lzEndpoint = new MockLayerZeroEndpoint(40245);
        verifier = new MockSP1Verifier();

        address predictedLedger  = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address predictedActions = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);

        ledger = new CawProfileLedger(
            30101,
            address(lzEndpoint),
            address(0),
            address(this),
            predictedActions,
            address(0xbeef),
            true,
            address(this)
        );
        require(address(ledger) == predictedLedger, "ledger addr mismatch");

        actions = new CawActions(
            address(ledger),
            address(verifier), // _zkVerifier — ZK path enabled
            bytes32(uint256(1)),
            address(0),
            address(0),
            0,
            0
        );
        require(address(actions) == predictedActions, "actions addr mismatch");

        ledger.mint(TOKEN_A, owner, "tokenA", uint64(block.number));
        ledger.mint(TOKEN_B, owner, "tokenB", uint64(block.number));
        ledger.auth(NETWORK_ID, TOKEN_A, address(0));
        ledger.auth(NETWORK_ID, TOKEN_B, address(0));

        // Authenticated but never minted on the ledger: ownerOf stays address(0)
        // (the "plain mint then authenticate, no deposit" state the ledger's
        // _setOwnerOf comment describes).
        ledger.auth(NETWORK_ID, TOKEN_NO_OWNER, address(0));

        ledger.mint(VALIDATOR_ID, address(this), "validator", uint64(block.number));
        ledger.auth(NETWORK_ID, VALIDATOR_ID, address(0));
    }

    // -----------------------------------------------------------------------
    // Packing helpers (layout: CawActions.sol packed format)
    // -----------------------------------------------------------------------

    function _unfollowSlice(uint32 senderId, uint32 receiverId, uint32 cawonce)
        internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            ACTION_UNFOLLOW,
            senderId,
            receiverId,
            uint32(0),   // receiverCawonce
            NETWORK_ID,
            cawonce,
            uint8(0),    // recipientCount
            uint8(0),    // amountCount
            uint16(0)    // textLength
        );
    }

    /// One sig group covering every action. With the mock verifier only r is
    /// read (the hash-chain anchor); v and s are ignored on the ZK path.
    function _oneGroupSigs(uint16 groupSize) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(1), groupSize, uint8(27), keccak256("r"), bytes32(0));
    }

    function _signers(address signer, uint256 n) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < n; i++) out = abi.encodePacked(out, signer);
    }

    function _submit(bytes memory packed, uint16 n, address signer) internal {
        actions.processActionsWithZkSigs(
            VALIDATOR_ID, packed, _oneGroupSigs(n), _signers(signer, n), hex"", 0, 0
        );
    }

    // -----------------------------------------------------------------------
    // Contiguous cawonces in a batch-sig group
    // -----------------------------------------------------------------------

    function test_batchGroup_contiguousCawonces_execute() public {
        bytes memory packed = abi.encodePacked(
            uint16(2),
            _unfollowSlice(TOKEN_A, TOKEN_B, 5),
            _unfollowSlice(TOKEN_A, TOKEN_B, 6)
        );
        _submit(packed, 2, owner);
        assertTrue(actions.isCawonceUsed(TOKEN_A, 5), "cawonce 5 used");
        assertTrue(actions.isCawonceUsed(TOKEN_A, 6), "cawonce 6 used");
    }

    function test_batchGroup_nonContiguousCawonces_revert() public {
        bytes memory packed = abi.encodePacked(
            uint16(2),
            _unfollowSlice(TOKEN_A, TOKEN_B, 5),
            _unfollowSlice(TOKEN_A, TOKEN_B, 7)
        );
        vm.expectRevert(CawActions.NonContiguousCawonces.selector);
        _submit(packed, 2, owner);
    }

    // -----------------------------------------------------------------------
    // Zero signer
    // -----------------------------------------------------------------------

    function test_ownerSigner_executes() public {
        bytes memory packed = abi.encodePacked(uint16(1), _unfollowSlice(TOKEN_A, TOKEN_B, 3));
        _submit(packed, 1, owner);
        assertTrue(actions.isCawonceUsed(TOKEN_A, 3), "cawonce 3 used");
    }

    function test_zeroSigner_onOwnerlessToken_reverts() public {
        assertEq(ledger.ownerOf(TOKEN_NO_OWNER), address(0), "precondition: no owner");
        bytes memory packed = abi.encodePacked(uint16(1), _unfollowSlice(TOKEN_NO_OWNER, TOKEN_B, 1));
        vm.expectRevert(CawActions.InvalidSig.selector);
        _submit(packed, 1, address(0));
        assertFalse(actions.isCawonceUsed(TOKEN_NO_OWNER, 1), "cawonce 1 untouched");
    }
}
