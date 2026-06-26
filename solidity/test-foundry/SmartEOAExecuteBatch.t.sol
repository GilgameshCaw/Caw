// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/SmartEOA.sol";

/// @title SmartEOAExecuteBatchTest
/// @notice Tests for the payable executeBatch function (relayer-fronted ETH model).
///
/// @dev All sigs use the secp256k1 ecdsaFallback path (65-byte) — no P-256 mock
///      needed, keeping the test file self-contained.
///
///      RELAYER MODEL: a relayer (msg.sender) attaches ETH to executeBatch to fund
///      inner calls (e.g. LayerZero native fees on the L1 withdrawTo path).  After
///      the call loop only the UNSPENT portion of msg.value (msg.value - totalValueForwarded)
///      is returned to msg.sender.  Inbound ETH during the loop (LZ refunds, DeFi
///      redemptions, etc.) stays in the user's account — it is NOT swept to msg.sender.
contract SmartEOAExecuteBatchTest is Test {

    // =========================================================================
    // secp256k1 key used for all execute sigs
    // =========================================================================

    uint256 constant ECDSA_PK   = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    address internal ecdsaAddr;

    // =========================================================================
    // Actors
    // =========================================================================

    address internal relayer = makeAddr("relayer");
    address internal user    = makeAddr("user");

    // =========================================================================
    // Contract under test
    // =========================================================================

    SmartEOA internal account;

    // =========================================================================
    // Dummy passkey (needed by initialize; not used for execute sigs here)
    // =========================================================================

    bytes32 constant DUMMY_PK_X = bytes32(uint256(0xd0d0d0d0d0d0));
    bytes32 constant DUMMY_PK_Y = bytes32(uint256(0xe0e0e0e0e0e0));

    // =========================================================================
    // Setup
    // =========================================================================

    function setUp() public {
        ecdsaAddr = vm.addr(ECDSA_PK);

        // Install a stub P-256 precompile (always returns empty = fail) so that
        // the WebAuthn path in isValidSignature doesn't revert on missing precompile.
        // We only use the 65-byte ECDSA path in these tests so it never matters.
        _installStubP256();

        account = new SmartEOA();
        account.initialize{value: 0}(
            DUMMY_PK_X, DUMMY_PK_Y, ecdsaAddr,
            payable(address(0)), new bytes(0)
        );

        // Fund the relayer with 10 ETH for value attachment.
        vm.deal(relayer, 10 ether);
    }

    // =========================================================================
    // Helper: build the execute digest (mirrors SmartEOA._executeDigest)
    // =========================================================================

    function _executeDigest(SmartEOA.Call[] memory calls, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSep = keccak256(abi.encode(
            keccak256("SmartEOA"),
            block.chainid,
            address(account)
        ));
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            callHashes[i] = keccak256(abi.encode(
                calls[i].to,
                calls[i].value,
                keccak256(calls[i].data)
            ));
        }
        bytes32 structHash = keccak256(abi.encode(
            keccak256(bytes("executeBatch")),
            keccak256(abi.encodePacked(callHashes)),
            nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    /// @dev Sign a digest with the ecdsaFallback private key → 65-byte sig.
    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ECDSA_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    // =========================================================================
    // Test helpers: targets that require/accept ETH
    // =========================================================================

    /// @dev Install a stub P-256 precompile (always fails) so SmartEOA doesn't
    ///      revert on the staticcall to 0x0100 in _verifyWebAuthnSafe.
    function _installStubP256() internal {
        // Deploy a contract that always returns empty (= P-256 fail).
        // The ECDSA path never calls the precompile, so this is fine.
        vm.etch(address(0x0100), type(StubP256).runtimeCode);
    }

    // =========================================================================
    // Test 1: msg.value funds an inner call that requires value
    // =========================================================================

    /// @notice A relayer attaches msg.value; the inner call consumes it.
    ///         Before the payable change this would revert at the ABI level.
    function test_executeBatch_payable_funds_inner_call() public {
        // Deploy a target that requires msg.value > 0.
        ValueRequiringTarget target = new ValueRequiringTarget();

        SmartEOA.Call[] memory calls = new SmartEOA.Call[](1);
        calls[0] = SmartEOA.Call({
            to:    address(target),
            value: 0.5 ether,
            data:  new bytes(0)
        });

        uint256 nonce = account.executeNonceOf();
        bytes32 digest = _executeDigest(calls, nonce);
        bytes memory sig = _sign(digest);

        uint256 relayerBefore = relayer.balance;

        // Relayer attaches exactly 0.5 ether — inner call consumes it fully.
        vm.prank(relayer, relayer);
        account.executeBatch{value: 0.5 ether}(calls, nonce, sig);

        // Target received 0.5 ether.
        assertEq(address(target).balance, 0.5 ether, "target must receive value");
        // Relayer spent exactly 0.5 ether (no surplus).
        assertEq(relayer.balance, relayerBefore - 0.5 ether, "relayer must spend exactly value");
        // Account balance unchanged (no surplus retained, no user ETH disturbed).
        assertEq(address(account).balance, 0, "account balance must be 0 after full consume");
    }

    // =========================================================================
    // Test 2: overpay → surplus refunded to msg.sender; account stays at startBal
    // =========================================================================

    function test_executeBatch_overpay_refunds_surplus_to_relayer() public {
        // Target that accepts but only consumes 0.1 ether.
        ValueRequiringTarget target = new ValueRequiringTarget();

        SmartEOA.Call[] memory calls = new SmartEOA.Call[](1);
        calls[0] = SmartEOA.Call({
            to:    address(target),
            value: 0.1 ether,
            data:  new bytes(0)
        });

        uint256 nonce = account.executeNonceOf();
        bytes32 digest = _executeDigest(calls, nonce);
        bytes memory sig = _sign(digest);

        uint256 relayerBefore = relayer.balance;

        // Relayer attaches 0.3 ether but only 0.1 is consumed.
        vm.prank(relayer, relayer);
        account.executeBatch{value: 0.3 ether}(calls, nonce, sig);

        // Target got 0.1 ether.
        assertEq(address(target).balance, 0.1 ether, "target must receive signed value");
        // Relayer gets back 0.2 ether surplus.
        assertEq(relayer.balance, relayerBefore - 0.1 ether, "relayer must be refunded surplus");
        // Account has zero (no pre-existing balance, no surplus retained).
        assertEq(address(account).balance, 0, "account must not retain surplus");
    }

    // =========================================================================
    // Test 3: pre-existing user balance is NOT refunded away
    // =========================================================================

    function test_executeBatch_preexisting_balance_not_refunded() public {
        // Give the account 1 ether of pre-existing user funds.
        vm.deal(address(account), 1 ether);

        // A no-value batch (relayer attaches 0 ETH).
        SimpleTarget target = new SimpleTarget();

        SmartEOA.Call[] memory calls = new SmartEOA.Call[](1);
        calls[0] = SmartEOA.Call({
            to:    address(target),
            value: 0,
            data:  abi.encodeWithSignature("ping()")
        });

        uint256 nonce = account.executeNonceOf();
        bytes32 digest = _executeDigest(calls, nonce);
        bytes memory sig = _sign(digest);

        uint256 relayerBefore = relayer.balance;

        // No ETH attached by relayer.
        vm.prank(relayer, relayer);
        account.executeBatch{value: 0}(calls, nonce, sig);

        // The account's pre-existing 1 ether is untouched.
        assertEq(address(account).balance, 1 ether, "account pre-existing balance must be untouched");
        // Relayer balance unchanged (no value sent, no refund expected).
        assertEq(relayer.balance, relayerBefore, "relayer balance must be unchanged");
    }

    // =========================================================================
    // Test 4: pre-existing balance + value-consuming inner call
    //         Only msg.value delta is refunded; user ETH is not touched
    // =========================================================================

    function test_executeBatch_preexisting_balance_plus_relayer_value() public {
        // Account has 2 ether of user funds pre-deposited.
        vm.deal(address(account), 2 ether);

        ValueRequiringTarget target = new ValueRequiringTarget();

        // Inner call spends 0.3 ether (from relayer's msg.value).
        SmartEOA.Call[] memory calls = new SmartEOA.Call[](1);
        calls[0] = SmartEOA.Call({
            to:    address(target),
            value: 0.3 ether,
            data:  new bytes(0)
        });

        uint256 nonce = account.executeNonceOf();
        bytes32 digest = _executeDigest(calls, nonce);
        bytes memory sig = _sign(digest);

        uint256 relayerBefore = relayer.balance;

        // Relayer attaches 0.5 ether; inner call consumes 0.3 ether.
        // surplus = 0.5 - 0.3 = 0.2 ether refunded to relayer.
        vm.prank(relayer, relayer);
        account.executeBatch{value: 0.5 ether}(calls, nonce, sig);

        // User's 2 ether is untouched.
        assertEq(address(account).balance, 2 ether, "user pre-existing ETH must not be touched");
        // Relayer net cost is 0.3 ether.
        assertEq(relayer.balance, relayerBefore - 0.3 ether, "relayer net cost = value consumed");
        // Target got 0.3 ether.
        assertEq(address(target).balance, 0.3 ether, "target must receive the inner value");
    }

    // =========================================================================
    // Test 5: reentrancy — re-entering executeBatch replays the nonce check
    // =========================================================================

    function test_executeBatch_reentrant_call_fails_nonce_check() public {
        // Deploy a reentering target that calls executeBatch again with the same nonce.
        ReentrantTarget reTarget = new ReentrantTarget(account, ecdsaAddr);

        // Build the OUTER batch: calls into reTarget (which tries to replay).
        SmartEOA.Call[] memory outerCalls = new SmartEOA.Call[](1);
        outerCalls[0] = SmartEOA.Call({
            to:    address(reTarget),
            value: 0,
            data:  abi.encodeWithSignature("attack()")
        });

        uint256 nonce = account.executeNonceOf(); // = 0

        // Build the INNER batch the reentrant attack will try to submit (same nonce=0).
        SmartEOA.Call[] memory innerCalls = new SmartEOA.Call[](1);
        innerCalls[0] = SmartEOA.Call({
            to:    address(this),
            value: 0,
            data:  new bytes(0)
        });
        bytes32 innerDigest = _executeDigest(innerCalls, 0);
        bytes memory innerSig = _sign(innerDigest);

        // Arm the reentrant target with the replay payload.
        reTarget.arm(innerCalls, 0, innerSig);

        // Build and sign the outer digest.
        bytes32 outerDigest = _executeDigest(outerCalls, nonce);
        bytes memory outerSig = _sign(outerDigest);

        // The outer call succeeds (reentrant target attack() call reverts internally
        // due to NotPermitted, but that bubbles up to ExecuteFailed at index 0).
        vm.prank(relayer, relayer);
        vm.expectRevert(abi.encodeWithSelector(SmartEOA.ExecuteFailed.selector, uint256(0)));
        account.executeBatch{value: 0}(outerCalls, nonce, outerSig);

        // Nonce is NOT incremented because the outer call reverted.
        assertEq(account.executeNonceOf(), 0, "nonce must not advance on revert");
    }

    // =========================================================================
    // Test 6: non-payable was reverted, payable now succeeds
    //         (confirm the L-3 hardening has been reversed)
    // =========================================================================

    function test_executeBatch_with_value_succeeds_not_reverts() public {
        // This test proves the specific regression fixed: before this change,
        // executeBatch was non-payable so any attached msg.value caused a revert.
        // Now it must succeed.
        SimpleTarget target = new SimpleTarget();

        SmartEOA.Call[] memory calls = new SmartEOA.Call[](1);
        calls[0] = SmartEOA.Call({
            to:    address(target),
            value: 0,
            data:  abi.encodeWithSignature("ping()")
        });

        uint256 nonce = account.executeNonceOf();
        bytes32 digest = _executeDigest(calls, nonce);
        bytes memory sig = _sign(digest);

        // Attaching any ETH to a non-payable function triggers EVMC_REVERT.
        // This must NOT revert.
        vm.prank(relayer, relayer);
        account.executeBatch{value: 1 ether}(calls, nonce, sig);

        // Relayer gets back the full 1 ether (inner call consumed 0).
        assertEq(relayer.balance, 10 ether, "relayer must get back full overpay (inner value=0)");
    }

    // =========================================================================
    // Test 7: LZ refund landing mid-execution STAYS in account (not swept to relayer)
    //
    // Under the inflow-theft-safe refund model, inbound ETH during the loop is
    // NOT swept to msg.sender.  Only the unspent portion of msg.value is refunded
    // (msg.value - totalValueForwarded).  An LZ refund that lands back at the account
    // stays there — it is the user's ETH, not the relayer's.
    // =========================================================================

    function test_executeBatch_lz_refund_stays_in_account_not_swept_to_relayer() public {
        // Simulate a target that receives ETH and sends half back to the account
        // (mimics LayerZero's native fee refund path).
        LzRefundSimulator lzSim = new LzRefundSimulator(address(account));
        vm.deal(address(lzSim), 0.05 ether); // pre-fund the simulator for its refund

        SmartEOA.Call[] memory calls = new SmartEOA.Call[](1);
        calls[0] = SmartEOA.Call({
            to:    address(lzSim),
            value: 0.1 ether, // relayer sends 0.1 ether; lzSim sends 0.05 back to account
            data:  new bytes(0)
        });

        uint256 nonce = account.executeNonceOf();
        bytes32 digest = _executeDigest(calls, nonce);
        bytes memory sig = _sign(digest);

        uint256 relayerBefore = relayer.balance;

        vm.prank(relayer, relayer);
        account.executeBatch{value: 0.1 ether}(calls, nonce, sig);

        // calls[0].value = 0.1 ether; msg.value = 0.1 ether → refundable = 0.
        // Relayer net cost is exactly 0.1 ether (all of msg.value was forwarded).
        assertEq(relayer.balance, relayerBefore - 0.1 ether, "relayer bears full msg.value cost");
        // The 0.05 ether LZ refund stays in the account — not swept to relayer.
        assertEq(address(account).balance, 0.05 ether, "LZ refund stays in account");
    }

    // =========================================================================
    // Test 8: REGRESSION — inflow-theft attack: pre-existing user ETH is NOT
    //         refunded to msg.sender when an inner call causes ETH to flow INTO
    //         the account.
    //
    // Attack scenario: SmartEOA holds user's own ETH.  A signed batch's inner
    // call causes ETH to flow into the account (e.g. attacker-controlled callee).
    // With the old startBal/surplus model this would sweep the user's ETH to
    // msg.sender.  With the new model (refundable = msg.value - totalValueForwarded)
    // the relayer's budget is zero so refundable = 0; the user's ETH is safe.
    // =========================================================================

    function test_executeBatch_inflow_during_loop_does_not_steal_user_eth() public {
        // Give the account 0.05 ether of the user's own pre-existing funds.
        vm.deal(address(account), 0.05 ether);

        // Deploy a callee that — upon being called — sends ETH into the account.
        // This simulates an attacker-controlled contract or any contract that sends
        // ETH back to the EOA during the batch.
        InflowCallee inflow = new InflowCallee(address(account));
        vm.deal(address(inflow), 0.05 ether); // give it ETH to send into account

        // Batch: call the inflow callee with value=0 and msg.value=0 (relayer sends nothing).
        SmartEOA.Call[] memory calls = new SmartEOA.Call[](1);
        calls[0] = SmartEOA.Call({
            to:    address(inflow),
            value: 0,
            data:  abi.encodeWithSignature("sendEthToAccount()")
        });

        uint256 nonce = account.executeNonceOf();
        bytes32 digest = _executeDigest(calls, nonce);
        bytes memory sig = _sign(digest);

        uint256 relayerBefore = relayer.balance;

        // Relayer attaches zero ETH.
        vm.prank(relayer, relayer);
        account.executeBatch{value: 0}(calls, nonce, sig);

        // The inflow callee sent 0.05 ether into the account.
        // Under the old model: surplus = finalBalance - startBal = 0.1 - 0.05 = 0.05
        //   → 0.05 ether swept to relayer (theft of user's ETH).
        // Under the new model: refundable = msg.value - totalValueForwarded = 0 - 0 = 0
        //   → nothing refunded to relayer.

        // Relayer balance must be UNCHANGED (no ETH was refunded to them).
        assertEq(relayer.balance, relayerBefore, "relayer must not receive user's pre-existing ETH");
        // Account holds the original 0.05 (user's) + 0.05 (inflow) = 0.10 ether.
        assertEq(address(account).balance, 0.10 ether, "account must retain pre-existing + inflow ETH");
    }

    receive() external payable {}
}

// =============================================================================
// Stub P-256 precompile (always returns empty → fail)
// =============================================================================

contract StubP256 {
    fallback(bytes calldata) external returns (bytes memory) {
        return new bytes(0);
    }
}

// =============================================================================
// Test target contracts
// =============================================================================

/// @dev Accepts ETH with no restriction; just holds it.
contract ValueRequiringTarget {
    receive() external payable {}
}

/// @dev Simple target with a ping() function.
contract SimpleTarget {
    bool public pinged;
    function ping() external { pinged = true; }
    receive() external payable {}
}

/// @dev Simulates a LayerZero endpoint: receives ETH and refunds half back.
contract LzRefundSimulator {
    address public refundTarget;

    constructor(address _refundTarget) {
        refundTarget = _refundTarget;
    }

    receive() external payable {
        // Send half back to simulate LZ native-fee refund.
        uint256 refund = msg.value / 2;
        if (refund > 0 && address(this).balance >= refund) {
            (bool ok, ) = refundTarget.call{value: refund}("");
            require(ok, "refund failed");
        }
    }
}

/// @dev Callee that sends ETH into the target account when invoked.
///      Used to simulate inbound ETH during a batch (LZ refund, attacker callee, etc.).
contract InflowCallee {
    address public target;

    constructor(address _target) {
        target = _target;
    }

    function sendEthToAccount() external {
        uint256 amt = address(this).balance;
        require(amt > 0, "InflowCallee: no ETH to send");
        (bool ok, ) = target.call{value: amt}("");
        require(ok, "InflowCallee: send failed");
    }

    receive() external payable {}
}

/// @dev Attempts to re-enter executeBatch with the same nonce.
///      The attack() function will try to submit the armed inner batch.
///      Because the outer executeBatch increments nonce BEFORE running calls,
///      the inner call will hit NotPermitted and revert.
contract ReentrantTarget {
    SmartEOA public account;
    address  public signer;

    SmartEOA.Call[] internal _innerCalls;
    uint256 internal _innerNonce;
    bytes   internal _innerSig;
    bool    internal _armed;

    constructor(SmartEOA _account, address _signer) {
        account = _account;
        signer  = _signer;
    }

    function arm(SmartEOA.Call[] calldata calls, uint256 nonce, bytes calldata sig) external {
        delete _innerCalls;
        for (uint256 i = 0; i < calls.length; i++) {
            _innerCalls.push(calls[i]);
        }
        _innerNonce = nonce;
        _innerSig   = sig;
        _armed      = true;
    }

    function attack() external {
        if (!_armed) return;
        _armed = false;
        // This will revert with NotPermitted because the outer call already bumped the nonce.
        account.executeBatch(_innerCalls, _innerNonce, _innerSig);
    }

    receive() external payable {}
}
