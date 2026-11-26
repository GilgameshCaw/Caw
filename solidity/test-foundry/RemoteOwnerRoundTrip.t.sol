// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AuditRegressionBase} from "./AuditRegressions2026_06_10.t.sol";
import {CawProfileLedger} from "../contracts/CawProfileLedger.sol";
import {MockLayerZeroEndpoint} from "../contracts/MockLayerZeroEndpoint.sol";
import {Origin, MessagingParams, MessagingReceipt} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

contract OwnershipPacketRecorder {
    bytes public message;
    function send(MessagingParams calldata params, address) external payable returns (MessagingReceipt memory receipt) {
        message = params.message;
        return receipt;
    }
}

contract RemoteOwnerRoundTripTest is AuditRegressionBase {
    OwnershipPacketRecorder recorder;
    CawProfileLedger remote;
    MockLayerZeroEndpoint destination;
    address constant WALLET_KEY = address(0x1234);
    address constant TOKEN_KEY = address(0x5678);

    function setUp() public override {
        super.setUp();
        destination = new MockLayerZeroEndpoint(2);
        remote = new CawProfileLedger(1, address(destination), address(0), address(cawProfile),
            address(cawActions), ERC1271_SIBLING, false, address(this));
        address sourceEndpoint = address(cawProfile.endpoint());
        vm.etch(sourceEndpoint, type(OwnershipPacketRecorder).runtimeCode);
        // The recorder stores its latest packet in slot zero of the mock endpoint.
        vm.store(sourceEndpoint, bytes32(0), bytes32(0));
        recorder = OwnershipPacketRecorder(sourceEndpoint);
        vm.prank(cawProfile.owner());
        cawProfile.setPeer(2, bytes32(uint256(uint160(address(remote)))));
        _mintAndDeposit(USER, TOKEN_ID, 100 ether);
        vm.prank(USER);
        cawProfile.authenticate(NETWORK_ID, TOKEN_ID, 2, 0);
    }

    function deliver(bytes memory packet, uint64 nonce) internal {
        vm.prank(address(destination));
        remote.lzReceive(Origin(1, bytes32(uint256(uint160(address(cawProfile)))), nonce),
            bytes32(uint256(nonce)), packet, address(this), "");
    }

    function registerKeys() internal {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(address(cawActions));
        remote.registerSessionFromActions(USER, WALLET_KEY, expiry, 0, 0);
        bytes32 typeHash = keccak256("TokenSessionDelegation(uint32 profileId,address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)");
        uint256 nonce = remote.tokenSessionNonce(TOKEN_ID);
        bytes32 message = keccak256(abi.encode(typeHash, TOKEN_ID, TOKEN_KEY, expiry, uint8(1), uint256(0), uint64(0), nonce));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", remote.eip712DomainHash(), message));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xA1, digest);
        remote.registerTokenScopedSession(TOKEN_ID, TOKEN_KEY, expiry, 1, 0, 0, nonce, v, r, s);
    }

    function testCoalescedRoundTripInvalidatesBothKindsOfSessionOnce() public {
        bytes memory initial = recorder.message();
        deliver(initial, 1);
        registerKeys();
        assertGt(remote.validSession(USER, WALLET_KEY).expiry, 0);
        assertGt(remote.validSession(USER, TOKEN_KEY).expiry, 0);
        vm.prank(USER);
        cawProfile.transferFrom(USER, USER2, TOKEN_ID);
        vm.prank(USER2);
        cawProfile.transferFrom(USER2, USER, TOKEN_ID);
        (uint32[] memory ids, address[] memory owners, uint128[] memory stamps) =
            cawProfile.pendingTransferUpdates(2, address(0), 0);
        assertEq(ids.length, 2);
        assertEq(owners[0], USER);
        assertEq(owners[1], USER);
        assertEq(uint64(stamps[0]), 3);
        assertEq(stamps[0], stamps[1]);
        cawProfile.syncTransfer(2, 0);
        bytes memory returned = recorder.message();
        deliver(returned, 2);
        assertEq(remote.ownerOf(TOKEN_ID), cawProfile.ownerOf(TOKEN_ID));
        assertEq(remote.validSession(USER, WALLET_KEY).expiry, 0);
        assertEq(remote.validSession(USER, TOKEN_KEY).expiry, 0);
        assertEq(remote.ownerSessionEpoch(USER), 1);
        registerKeys();
        vm.prank(USER);
        cawProfile.transferFrom(USER, USER, TOKEN_ID);
        cawProfile.syncTransfer(2, 0);
        deliver(recorder.message(), 3);
        deliver(initial, 1);
        deliver(returned, 2);
        assertEq(remote.ownerSessionEpoch(USER), 1);
        assertGt(remote.validSession(USER, WALLET_KEY).expiry, 0);
        assertGt(remote.validSession(USER, TOKEN_KEY).expiry, 0);
    }
}
