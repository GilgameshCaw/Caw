// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "./mocks/MockSmartEOA.sol";
import "./mocks/MockMinter.sol";

/// @title EIP7702BootstrapTest
/// @notice Pre-implementation gate test for §7 Test 0 of
///         plan-smart-eoa-passkey-sponsorship.md (v3).
///
///         PURPOSE: prove that the §5 single-tx bundling design is sound before
///         any production SmartEOA code is written.  Specifically, a single
///         type-0x04 transaction can atomically:
///           (a) process an EIP-7702 authorization-list entry (delegation),
///           (b) call initialize(...) on the now-delegated EOA, and
///           (c) have initialize() call out to a separately-deployed Minter that
///               staticcalls the EOA's isValidSignature() — all inside one tx.
///
///         If this test PASSES the orchestrator locks in the single-tx design.
///         If it FAILS the §5 design must fall back to two transactions.
///
/// @dev Test environment: forge-std nightly (commit 7825a06, April 2025).
///      EIP-7702 is supported natively in foundry's local EVM via
///      vm.signAndAttachDelegation / vm.attachDelegation — no fork required.
///      The local EVM correctly implements the type-0x04 tx semantics:
///        - Auth list is processed FIRST, writing 0xef0100||impl to the EOA's
///          code slot BEFORE the tx body executes.
///        - code.length of the delegated EOA is 23 bytes (0xef0100 + 20 addr).
///        - Delegated storage is per-EOA: each delegated account has its own
///          storage even though all point at the same implementation address.
///
///      No mainnet fork is used: foundry's built-in EVM supports EIP-7702 in
///      isolation (Pectra EIP). A fork would add network latency without adding
///      test coverage for this specific flow.
///
/// @dev Chain-ID note (per §4 of the plan):
///      vm.signAndAttachDelegation uses the test EVM's block.chainid, which is
///      foundry's default (31337).  The plan explicitly requires using the
///      current network's chainId at runtime — never hardcoding 1. This test
///      honours that by relying entirely on foundry's helper (not manually
///      encoding chainId=1 anywhere).
contract EIP7702BootstrapTest is Test {
    // ---------------------------------------------------------------
    // Test fixtures
    // ---------------------------------------------------------------

    MockSmartEOA internal delegateImpl;
    MockMinter   internal minter;

    /// @dev Fresh secp256k1 keypair for the test EOA.
    ///      Using a well-known test private key — NOT one that holds real value.
    uint256 internal constant USER_EOA_PK =
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    address internal userEOA;

    // Dummy passkey coordinates (test vector — not real P-256 pubkey math).
    bytes32 internal constant PASSKEY_X =
        0xaabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb;
    bytes32 internal constant PASSKEY_Y =
        0x1122334455667788990011223344556677889900112233445566778899001122;

    // Dummy ECDSA fallback address (Population B's secp256k1 address from backup).
    address internal constant ECDSA_FALLBACK =
        address(0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF);

    // ETH value the sponsor bundles through initialize to the minter.
    uint256 internal constant SPONSOR_VALUE = 0.01 ether;

    // ---------------------------------------------------------------
    // setUp
    // ---------------------------------------------------------------

    function setUp() public {
        // Derive the user's EOA address from the test private key.
        userEOA = vm.addr(USER_EOA_PK);

        // Deploy the delegate implementation.  All 7702-delegated EOAs point
        // at this single address; each has its own storage.
        delegateImpl = new MockSmartEOA();

        // Deploy the minter.  In production this is CawProfileMinter; here
        // it's a minimal stand-in that checks code.length + ERC-1271 magic.
        minter = new MockMinter();

        // Fund the test contract so it can provide the sponsor ETH value.
        vm.deal(address(this), 1 ether);
    }

    // ---------------------------------------------------------------
    // Main bootstrap test
    // ---------------------------------------------------------------

    /// @notice The gate test.
    ///
    ///         Sequence:
    ///           1. Sign a 7702 auth tuple (chainId = current block.chainid,
    ///              delegate = MockSmartEOA, nonce = 0) and attach it.
    ///           2. Send a type-0x04 tx to the user's EOA with calldata
    ///              encoding initialize(pkX, pkY, fallback, minter).
    ///           3. Inside initialize:
    ///              - storage guard fires (one-shot), state is written.
    ///              - IMockMinter.mintAndDepositSponsored is called, forwarding
    ///                msg.value.
    ///           4. Inside mintAndDepositSponsored:
    ///              - recipient.code.length > 0 is checked.
    ///              - recipient.isValidSignature(bytes32(0), sig) is staticcalled.
    ///              - Magic value 0x1626ba7e is verified.
    ///              - Minted(recipient) is emitted.
    ///           5. After the tx: asserts run.
    function test_singleTx_7702_bundle_initialise_and_mock_mint() public {
        // ------------------------------------------------------------------
        // Step 1: sign the 7702 auth tuple and mark the next call as 7702.
        // ------------------------------------------------------------------
        // vm.signAndAttachDelegation:
        //   - Signs [chainId, delegateImpl, nonce=0] with USER_EOA_PK.
        //   - Marks the NEXT call in this test as a type-0x04 tx.
        //   - The auth list is processed first by the EVM: userEOA.code is set
        //     to 0xef0100 || address(delegateImpl) before tx body runs.
        vm.signAndAttachDelegation(address(delegateImpl), USER_EOA_PK);

        // ------------------------------------------------------------------
        // Step 2: build the initialize calldata.
        // ------------------------------------------------------------------
        bytes memory initCalldata = abi.encodeWithSelector(
            MockSmartEOA.initialize.selector,
            PASSKEY_X,
            PASSKEY_Y,
            ECDSA_FALLBACK,
            address(minter)
        );

        // ------------------------------------------------------------------
        // Step 3: expect the Minted event.
        // ------------------------------------------------------------------
        vm.expectEmit(true, false, false, false, address(minter));
        emit MockMinter.Minted(userEOA);

        // ------------------------------------------------------------------
        // Step 4: execute the single type-0x04 tx.
        //
        // The tx body calls initialize on the EOA (which now delegates to
        // MockSmartEOA).  We pass SPONSOR_VALUE to exercise the payable path.
        // vm.prank sets msg.sender to address(this) (the sponsor).
        // ------------------------------------------------------------------
        vm.prank(address(this));
        (bool ok, bytes memory revertData) = userEOA.call{value: SPONSOR_VALUE}(initCalldata);

        // ------------------------------------------------------------------
        // Step 5: assert — no revert.
        // ------------------------------------------------------------------
        if (!ok) {
            // Decode and surface the revert reason so the orchestrator can read
            // exactly which part of the single-tx chain failed.
            if (revertData.length > 0) {
                assembly { revert(add(revertData, 32), mload(revertData)) }
            }
            revert("initialize call reverted with no reason");
        }

        // ------------------------------------------------------------------
        // Step 6: assert — 7702 delegation is visible post-tx.
        //
        // EIP-7702 spec: delegated EOA has code = 0xef0100 || implementationAddr
        // (23 bytes total).  The plan (§2 and §7 Test 0) requires verifying this.
        // ------------------------------------------------------------------
        assertEq(
            userEOA.code.length,
            23,
            "EIP7702: delegated EOA must have 23 bytes of code"
        );

        // Verify the 0xef0100 magic prefix.
        bytes memory code = userEOA.code;
        assertEq(uint8(code[0]), 0xef, "EIP7702: code[0] must be 0xef");
        assertEq(uint8(code[1]), 0x01, "EIP7702: code[1] must be 0x01");
        assertEq(uint8(code[2]), 0x00, "EIP7702: code[2] must be 0x00");

        // Verify the remaining 20 bytes encode the delegate implementation address.
        address encodedImpl;
        assembly {
            // code is a bytes memory: first 32 bytes = length, then data.
            // Bytes 3..22 (0-indexed) are the address. Shift right by 96 bits.
            encodedImpl := shr(96, mload(add(add(code, 32), 3)))
        }
        assertEq(
            encodedImpl,
            address(delegateImpl),
            "EIP7702: encoded implementation address mismatch"
        );

        // ------------------------------------------------------------------
        // Step 7: assert — minter recorded the mint.
        // ------------------------------------------------------------------
        assertEq(
            minter.lastMinted(),
            userEOA,
            "MockMinter: lastMinted should be userEOA"
        );

        // ------------------------------------------------------------------
        // Step 8: assert — isValidSignature still works after init
        //         (proves the delegation persists for subsequent calls).
        // ------------------------------------------------------------------
        (bool sigOk, bytes memory sigRet) = userEOA.staticcall(
            abi.encodeWithSelector(
                bytes4(keccak256("isValidSignature(bytes32,bytes)")),
                bytes32(uint256(0x1234)),
                abi.encode(bytes32(0))
            )
        );
        assertTrue(sigOk, "isValidSignature staticcall failed");
        require(sigRet.length >= 32, "isValidSignature: ret too short");
        bytes4 magic = abi.decode(sigRet, (bytes4));
        assertEq(
            magic,
            bytes4(0x1626ba7e),
            "isValidSignature: wrong magic value"
        );
    }

    // ---------------------------------------------------------------
    // Negative: calling initialize a second time must revert.
    // ---------------------------------------------------------------

    /// @notice Proves the one-shot guard in initialize works.
    ///         A re-initialization attempt on an already-bootstrapped account
    ///         must revert, preventing hijacking by a malicious second call.
    function test_initialize_revert_if_already_initialized() public {
        // First bootstrap.
        vm.signAndAttachDelegation(address(delegateImpl), USER_EOA_PK);
        bytes memory initCalldata = abi.encodeWithSelector(
            MockSmartEOA.initialize.selector,
            PASSKEY_X,
            PASSKEY_Y,
            ECDSA_FALLBACK,
            address(minter)
        );
        vm.prank(address(this));
        (bool ok, ) = userEOA.call{value: SPONSOR_VALUE}(initCalldata);
        assertTrue(ok, "first initialize must succeed");

        // Second call — must revert.
        // No need to attach a new delegation; the EOA is already delegated.
        vm.prank(address(this));
        (bool ok2, bytes memory ret2) = userEOA.call(initCalldata);
        assertFalse(ok2, "second initialize must revert");

        // Optionally decode and check the revert message.
        // ABI-encoded Error(string) selector = 0x08c379a0
        if (ret2.length >= 4) {
            bytes4 sel = bytes4(ret2);
            if (sel == bytes4(0x08c379a0)) {
                // Standard string revert — decode and assert content.
                bytes memory msgBytes = new bytes(ret2.length - 4);
                for (uint256 i = 0; i < msgBytes.length; i++) {
                    msgBytes[i] = ret2[i + 4];
                }
                // We just assert it's a non-empty revert — the exact string
                // "MockSmartEOA: already initialized" is an implementation detail.
                assertGt(msgBytes.length, 0, "revert message must not be empty");
            }
        }
    }

    // ---------------------------------------------------------------
    // Negative: EOA recipient that is NOT delegated must fail the
    // code.length check in MockMinter.
    // ---------------------------------------------------------------

    /// @notice Proves the Minter's code.length guard blocks plain EOAs.
    ///         An EOA-only (not 7702-delegated) address calls mintAndDepositSponsored
    ///         directly — Minter should revert with "recipient not a smart account".
    function test_minter_rejects_plain_eoa() public {
        address plainEOA = vm.addr(0xdeadbeef);
        vm.deal(plainEOA, 1 ether);

        // plainEOA is NOT delegated — code.length == 0.
        assertEq(plainEOA.code.length, 0, "pre-condition: plain EOA has no code");

        vm.prank(plainEOA);
        vm.expectRevert("MockMinter: recipient not a smart account");
        minter.mintAndDepositSponsored{value: 0}(plainEOA, abi.encode(bytes32(0)));
    }

    // ---------------------------------------------------------------
    // Required by payable call in test
    // ---------------------------------------------------------------
    receive() external payable {}
}
