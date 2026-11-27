// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// ActionsProcessed carries ONE networkId for the whole batch ("all actions in a batch share it").
// processActions enforces that across all signature groups (MixedNetworks, via
// _trackNetworkAndWithdraw). safeProcessActions captured the networkId of the first action only,
// and each group goes through processGroupSingle, which checks the network inside its own group.
// A batch with groups on different networks was therefore accepted: every group's state was
// updated under its own network, but the single event was labelled with the first network.
//
// Per-network consumers read ActionsProcessed by its indexed networkId (the validator service's
// replication reconstruction, and the live poll in RawEventsGatherer), so the actions of the
// other network are missing from that network's reconstruction.
//
// Harness: the same shape as SessionProfileScoping.t.sol (real CawProfileLedger in bypassLZ mode
// with this contract as CawProfile, real CawActions), with two networks.

import "forge-std/Test.sol";
import "../contracts/CawActions.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

abstract contract SafeMixedBase is Test {
    uint32 constant NET_1 = 1;
    uint32 constant NET_2 = 2;
    uint32 constant TOKEN_A = 10;
    uint32 constant TOKEN_B = 20;
    uint32 constant VALIDATOR_ID = 99;
    uint256 constant OWNER_PK = 0xA11CE1;
    uint8 constant ACTION_UNFOLLOW = 5;     // zero protocol cost

    CawProfileLedger ledger;
    CawActions actions;
    address owner;

    function setUp() public virtual {
        owner = vm.addr(OWNER_PK);
        MockLayerZeroEndpoint lz = new MockLayerZeroEndpoint(40245);
        address predictedLedger  = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address predictedActions = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        ledger = new CawProfileLedger(30101, address(lz), address(0), address(this), predictedActions,
            address(0xbeef), true, address(this));
        require(address(ledger) == predictedLedger, "ledger addr mismatch");
        actions = new CawActions(address(ledger), address(0), bytes32(0), address(0), address(0), 0, 0);
        require(address(actions) == predictedActions, "actions addr mismatch");

        ledger.mint(TOKEN_A, owner, "tokenA", uint64(block.number));
        ledger.mint(TOKEN_B, owner, "tokenB", uint64(block.number));
        ledger.auth(NET_1, TOKEN_A, address(0));
        ledger.auth(NET_2, TOKEN_B, address(0));
        ledger.mint(VALIDATOR_ID, address(this), "validator", uint64(block.number));
        ledger.auth(NET_1, VALIDATOR_ID, address(0));
        ledger.auth(NET_2, VALIDATOR_ID, address(0));
    }

    // One action (25 bytes, no header): UNFOLLOW sender -> receiver on `networkId`.
    function _act(uint32 senderId, uint32 receiverId, uint32 networkId, uint32 cawonce) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_UNFOLLOW, senderId, receiverId, uint32(0), networkId, cawonce, uint8(0), uint8(0), uint16(0));
    }

    function _sigGroup(uint32 senderId, uint32 receiverId, uint32 networkId, uint32 cawonce) internal view returns (bytes memory) {
        return _sigGroupWithKey(OWNER_PK, senderId, receiverId, networkId, cawonce);
    }

    /// @dev Same as _sigGroup, signed with an arbitrary key (a wrong key makes the group fail verification).
    function _sigGroupWithKey(uint256 pk, uint32 senderId, uint32 receiverId, uint32 networkId, uint32 cawonce) internal view returns (bytes memory) {
        bytes32 th = keccak256("ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 networkId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)");
        bytes32 structHash = keccak256(abi.encode(
            th, uint256(ACTION_UNFOLLOW), uint256(senderId), uint256(receiverId), uint256(0), uint256(networkId), uint256(cawonce),
            keccak256(abi.encodePacked(new uint32[](0))), keccak256(abi.encodePacked(new uint64[](0))), keccak256(new bytes(0))
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", actions.eip712DomainHash(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(uint16(1), v, r, s);   // groupSize 1, v, r, s
    }

    /// @dev Two single-action groups: token A on `net1`, token B on `net2`.
    function _twoGroupBatch(uint32 net1, uint32 net2) internal view returns (bytes memory packed, bytes memory sigs) {
        packed = abi.encodePacked(uint16(2), _act(TOKEN_A, TOKEN_B, net1, 1), _act(TOKEN_B, TOKEN_A, net2, 1));
        sigs = abi.encodePacked(uint16(2), _sigGroup(TOKEN_A, TOKEN_B, net1, 1), _sigGroup(TOKEN_B, TOKEN_A, net2, 1));
    }
}

contract SafeProcessMixedNetworksTest is SafeMixedBase {
    bytes32 constant ACTIONS_PROCESSED = keccak256("ActionsProcessed(uint32,uint32,uint16,bytes32)");

    function _processedTopics() internal returns (uint256 n, uint32 firstNetwork) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(actions) && logs[i].topics[0] == ACTIONS_PROCESSED) {
                if (n == 0) firstNetwork = uint32(uint256(logs[i].topics[1]));
                n++;
            }
        }
    }

    /// @dev The existing behaviour of processActions (control).
    function test_processActions_rejectsMixedNetworks() public {
        (bytes memory packed, bytes memory sigs) = _twoGroupBatch(NET_1, NET_2);
        vm.expectRevert(CawActions.MixedNetworks.selector);
        actions.processActions(VALIDATOR_ID, packed, sigs, 0, 0);
    }

    /// @dev The fix: safeProcessActions refuses the same batch.
    function test_safeProcessActions_rejectsMixedNetworks() public {
        (bytes memory packed, bytes memory sigs) = _twoGroupBatch(NET_1, NET_2);
        vm.expectRevert(CawActions.MixedNetworks.selector);
        actions.safeProcessActions(VALIDATOR_ID, packed, sigs, 0, 0);
        assertEq(actions.networkActionCount(NET_2), 0, "nothing was applied on the second network");
    }

    /// @dev Control: a batch on one network, in several groups, still goes through; one event, that network.
    function test_safeProcessActions_sameNetwork_stillWorks() public {
        // both tokens must be authenticated on network 1
        ledger.auth(NET_1, TOKEN_B, address(0));
        (bytes memory packed, bytes memory sigs) = _twoGroupBatch(NET_1, NET_1);
        vm.recordLogs();
        (uint256 ok, ) = actions.safeProcessActions(VALIDATOR_ID, packed, sigs, 0, 0);
        (uint256 n, uint32 net) = _processedTopics();
        assertEq(ok, 2, "both groups applied");
        assertEq(n, 1, "one ActionsProcessed event");
        assertEq(net, NET_1, "labelled with the batch's network");
        assertEq(actions.networkActionCount(NET_1), 2);
    }

    /// @dev Control: a batch whose actions are all on the second network is labelled with the second network.
    function test_safeProcessActions_singleNetwork_secondNetwork() public {
        ledger.auth(NET_2, TOKEN_A, address(0));
        (bytes memory packed, bytes memory sigs) = _twoGroupBatch(NET_2, NET_2);
        vm.recordLogs();
        (uint256 ok, ) = actions.safeProcessActions(VALIDATOR_ID, packed, sigs, 0, 0);
        (, uint32 net) = _processedTopics();
        assertEq(ok, 2);
        assertEq(net, NET_2);
    }

    uint256 constant WRONG_PK = 0xBAD1;

    /// @dev The first group is rejected (wrong signer) and the second is on another network. The batch is a
    ///      framing error, not one user's bad signature, so the whole call reverts, as processActions does.
    ///      On master the second group was applied, and the event carried the network of the rejected action.
    function test_safeProcessActions_firstGroupRejected_thenOtherNetwork_revertsWhole() public {
        bytes memory packed = abi.encodePacked(uint16(2), _act(TOKEN_A, TOKEN_B, NET_1, 1), _act(TOKEN_B, TOKEN_A, NET_2, 1));
        bytes memory sigs = abi.encodePacked(uint16(2),
            _sigGroupWithKey(WRONG_PK, TOKEN_A, TOKEN_B, NET_1, 1), _sigGroup(TOKEN_B, TOKEN_A, NET_2, 1));
        vm.expectRevert(CawActions.MixedNetworks.selector);
        actions.safeProcessActions(VALIDATOR_ID, packed, sigs, 0, 0);
        assertEq(actions.networkActionCount(NET_2), 0, "nothing was applied on the second network");
    }

    /// @dev Control: partial success on ONE network is kept. The first group is rejected (wrong signer), the
    ///      second goes through; one event, labelled with that network, counting the whole batch.
    function test_safeProcessActions_firstGroupRejected_sameNetwork_stillPartiallySucceeds() public {
        ledger.auth(NET_1, TOKEN_B, address(0));
        bytes memory packed = abi.encodePacked(uint16(2), _act(TOKEN_A, TOKEN_B, NET_1, 1), _act(TOKEN_B, TOKEN_A, NET_1, 1));
        bytes memory sigs = abi.encodePacked(uint16(2),
            _sigGroupWithKey(WRONG_PK, TOKEN_A, TOKEN_B, NET_1, 1), _sigGroup(TOKEN_B, TOKEN_A, NET_1, 1));
        vm.recordLogs();
        (uint256 ok, bytes[] memory rejections) = actions.safeProcessActions(VALIDATOR_ID, packed, sigs, 0, 0);
        (uint256 n, uint32 net) = _processedTopics();
        assertEq(ok, 1, "only the second group succeeded");
        assertGt(rejections[0].length, 0, "the first group was rejected");
        assertEq(rejections[1].length, 0, "the second group was not");
        assertEq(n, 1);
        assertEq(net, NET_1);
        assertEq(actions.networkActionCount(NET_1), 1);
    }
}
