// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/SmartEOA.sol";
import "./helpers/SmartEOAInit.sol";

/// @title SmartEOAInitializeTest
/// @notice initialize must be authorized by the EOA's own key.
///
///         A 7702 delegation survives a reverted tx body, and an auth tuple
///         can be copied out of a pending tx into another one.  Either way the
///         EOA can end up delegated to SmartEOA but not initialized, and
///         before initSig anyone could then call initialize with their own
///         passkey and fallback and control the account.
contract SmartEOAInitializeTest is SmartEOAInit {
    uint256 internal constant USER_PK     = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 internal constant ATTACKER_PK = 0x2222222222222222222222222222222222222222222222222222222222222222;

    bytes32 internal constant USER_X = bytes32(uint256(0xa1));
    bytes32 internal constant USER_Y = bytes32(uint256(0xa2));
    bytes32 internal constant ATTACKER_X = bytes32(uint256(0xb1));
    bytes32 internal constant ATTACKER_Y = bytes32(uint256(0xb2));

    /// @dev secp256k1 group order.
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    SmartEOA internal account;
    address internal user;
    address internal attacker;
    MintTarget internal minter;

    function setUp() public {
        account = _delegatedAccount(USER_PK);
        user = vm.addr(USER_PK);
        attacker = vm.addr(ATTACKER_PK);
        minter = new MintTarget();
    }

    function _userSig(
        bytes32 x,
        bytes32 y,
        address fallback_,
        address minterContract,
        bytes memory mintCalldata
    ) internal view returns (bytes memory) {
        return _initSig(USER_PK, x, y, fallback_, minterContract, mintCalldata);
    }

    /// @dev The account accepts its first passkey and fallback only from itself.
    function test_initialize_withOwnKey_succeeds() public {
        bytes memory sig = _userSig(USER_X, USER_Y, user, address(0), "");
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", sig);

        // The fallback is live: a 65-byte sig from the user's key is accepted.
        bytes32 digest = keccak256("probe");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
        assertEq(account.isValidSignature(digest, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
    }

    /// @dev Delegated but not yet initialized: someone else cannot take it over.
    function test_initialize_bySomeoneElse_reverts() public {
        bytes memory attackerSig = _initSig(ATTACKER_PK, ATTACKER_X, ATTACKER_Y, attacker, address(0), "");
        vm.prank(attacker, attacker);
        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(ATTACKER_X, ATTACKER_Y, attacker, payable(address(0)), "", attackerSig);

        // The user can still initialize afterwards.
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", _userSig(USER_X, USER_Y, user, address(0), ""));
    }

    /// @dev A copied initSig cannot be reused with a different passkey.
    function test_copiedSig_otherPasskey_reverts() public {
        bytes memory sig = _userSig(USER_X, USER_Y, user, address(0), "");
        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(ATTACKER_X, ATTACKER_Y, user, payable(address(0)), "", sig);
    }

    /// @dev A copied initSig cannot be reused with a different fallback.
    function test_copiedSig_otherFallback_reverts() public {
        bytes memory sig = _userSig(USER_X, USER_Y, user, address(0), "");
        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, attacker, payable(address(0)), "", sig);
    }

    /// @dev A copied bootstrap initSig cannot be replayed without its Minter call
    ///      (which would leave the user initialized but unminted) or with other calldata.
    function test_copiedSig_otherMinterOrCalldata_reverts() public {
        bytes memory mintCalldata = abi.encodeWithSelector(MintTarget.mint.selector, uint256(7));
        bytes memory sig = _userSig(USER_X, USER_Y, user, address(minter), mintCalldata);

        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", sig);

        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(
            USER_X, USER_Y, user, payable(address(minter)),
            abi.encodeWithSelector(MintTarget.mint.selector, uint256(8)), sig
        );

        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, user, payable(attacker), mintCalldata, sig);
    }

    /// @dev Whoever submits the user's exact initSig gets exactly the user's call.
    function test_copiedSig_sameArgs_onlyDoesWhatUserSigned() public {
        bytes memory mintCalldata = abi.encodeWithSelector(MintTarget.mint.selector, uint256(7));
        bytes memory sig = _userSig(USER_X, USER_Y, user, address(minter), mintCalldata);

        vm.prank(attacker, attacker);
        account.initialize(USER_X, USER_Y, user, payable(address(minter)), mintCalldata, sig);

        assertEq(minter.lastCaller(), user, "Minter called by the user's account");
        assertEq(minter.lastAmount(), 7, "with the calldata the user signed");

        // The user's fallback key controls the account; the attacker's does not.
        bytes32 digest = keccak256("probe");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
        assertEq(account.isValidSignature(digest, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        (v, r, s) = vm.sign(ATTACKER_PK, digest);
        assertEq(account.isValidSignature(digest, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }

    /// @dev The sig is bound to the chain (L1 and L2 each need their own).
    function test_sigFromOtherChain_reverts() public {
        bytes memory sig = _userSig(USER_X, USER_Y, user, address(0), "");
        vm.chainId(block.chainid + 1);
        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", sig);
    }

    /// @dev The sig is bound to the account: another EOA's initSig does not apply.
    function test_sigForOtherAccount_reverts() public {
        SmartEOA other = _delegatedAccount(ATTACKER_PK);
        bytes memory sigForOther = _initSig(ATTACKER_PK, USER_X, USER_Y, user, address(0), "");
        other.initialize(USER_X, USER_Y, user, payable(address(0)), "", sigForOther);

        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", sigForOther);
    }

    /// @dev Malformed sigs are rejected (no ecrecover-to-zero or malleability path).
    function test_malformedSig_reverts() public {
        bytes memory good = _userSig(USER_X, USER_Y, user, address(0), "");
        (bytes32 r, bytes32 s, uint8 v) = _split(good);

        // Empty and wrong-length sigs.
        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", "");
        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", abi.encodePacked(r, s));

        // v outside {27, 28}.
        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", abi.encodePacked(r, s, v - 27));

        // High-s twin of a valid sig (same signer, malleated).
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.expectRevert(SmartEOA.InvalidInitSig.selector);
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", abi.encodePacked(r, highS, flippedV));

        // The untouched sig still works.
        account.initialize(USER_X, USER_Y, user, payable(address(0)), "", good);
    }

    // -------------------------------------------------------------------------
    // Client vectors: the digests below are computed by the sponsor server's
    // smartEoaInitDigest (client/src/services/SponsorService/smartEoaInit.ts)
    // and pinned in its tests and in the FE's viem copy. Signing them with the
    // EOA key and calling initialize proves the contract computes the same.
    // -------------------------------------------------------------------------

    uint256 internal constant VECTOR_PK = 0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 internal constant VECTOR_X = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
    bytes32 internal constant VECTOR_Y = 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;

    function _signDigest(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_clientVectors_standaloneL2() public {
        bytes32 clientDigest = 0x8080ee3c40d30fd736595d2e6ef66fcc83a055c72108abba5a7b11c904f60d47;
        vm.chainId(84532);
        SmartEOA acct = _delegatedAccount(VECTOR_PK);
        address a = address(acct);
        assertEq(a, 0x1563915e194D8CfBA1943570603F7606A3115508);
        assertEq(_initDigest(a, VECTOR_X, VECTOR_Y, a, address(0), ""), clientDigest, "helper == client");

        acct.initialize(VECTOR_X, VECTOR_Y, a, payable(address(0)), "", _signDigest(VECTOR_PK, clientDigest));
    }

    function test_clientVectors_bootstrapWithMinter() public {
        bytes32 clientDigest = 0xb45c2e9ab761a654bdfdc63c3c254091078b35f9a17cf69ec1c400a6eca37298;
        vm.chainId(11155111);
        address fixedMinter = address(0xaaaa);
        vm.etch(fixedMinter, address(new MintTarget()).code);
        bytes memory mintCalldata = abi.encodeWithSelector(MintTarget.mint.selector, uint256(7));
        assertEq(mintCalldata, hex"a0712d680000000000000000000000000000000000000000000000000000000000000007");

        SmartEOA acct = _delegatedAccount(VECTOR_PK);
        address a = address(acct);
        assertEq(_initDigest(a, VECTOR_X, VECTOR_Y, a, fixedMinter, mintCalldata), clientDigest, "helper == client");

        acct.initialize(
            VECTOR_X, VECTOR_Y, a, payable(fixedMinter), mintCalldata, _signDigest(VECTOR_PK, clientDigest)
        );
        assertEq(MintTarget(fixedMinter).lastAmount(), 7);
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }
}

/// @dev Stand-in for the Minter: records who called it and with what.
contract MintTarget {
    address public lastCaller;
    uint256 public lastAmount;

    function mint(uint256 amount) external payable {
        lastCaller = msg.sender;
        lastAmount = amount;
    }
}
