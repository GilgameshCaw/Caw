// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// ARC-FUTURE-1 v2 (audit 2026-06-14): proof-of-non-existence challenge. The
// bounded-lookahead alone doesn't protect a LOW-volume network — an attacker can
// submit a full 256-checkpoint range (8k actions) that the slow source won't
// produce within the 2-day window, so it's un-challengeable until finalize. The
// relay now reads the source's live networkActionCount and relays the highest
// REAL checkpoint; the archive slashes any PENDING submission whose endCheckpointId
// exceeds it. These tests drive _processNonExistence (the archive's resolve path)
// through a harness that exposes the self-gated call + a submission injector.

import "forge-std/Test.sol";
import "../contracts/CawActionsArchive.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

/// @dev Harness exposing the self-gated _processNonExistence and a way to inject
///      a PENDING submission without building a full valid action blob.
contract ArchiveHarness is CawActionsArchive {
    constructor(address ep, address pe) CawActionsArchive(ep, pe) {}

    function harnessInjectSubmission(
        uint256 submissionId,
        address submitter,
        uint32 networkId,
        uint64 startCp,
        uint64 endCp,
        uint32 sourceEid
    ) external {
        submissions[submissionId] = Submission({
            submitter: submitter,
            merkleRoot: bytes32(uint256(1)),
            networkId: networkId,
            startCheckpointId: startCp,
            endCheckpointId: endCp,
            finalizedAt: uint64(block.timestamp + CHALLENGE_PERIOD),
            status: Status.PENDING,
            dataCommitment: bytes32(0)
        });
        // Mirror submitReplication's bookkeeping enough for the slash loop.
        submissionSourceEid[submissionId] = sourceEid;
        for (uint256 cp = startCp; cp <= endCp; cp++) {
            checkpointClaimed[sourceEid][networkId][cp] = submissionId;
        }
        validatorSubmissions[submitter].push(submissionId);
        validatorSubmissionsIndexPlusOne[submissionId] = validatorSubmissions[submitter].length;
        pendingCount[submitter] += 1;
    }

    // Build the MSG_NONEXISTENCE payload and route it through the self-call the
    // same way _lzReceive -> _processChallenge would.
    function harnessDeliverNonExistence(
        uint32 srcEid,
        uint256 submissionId,
        uint32 networkId,
        uint256 sourceMaxCheckpoint,
        address rewardTo
    ) external {
        bytes memory payload = abi.encode(uint8(2), submissionId, networkId, sourceMaxCheckpoint, rewardTo);
        this._processChallenge(srcEid, payload);
    }

    // Same route for a MSG_CHALLENGE payload (checkpoint hashes).
    function harnessDeliverChallenge(
        uint32 srcEid,
        uint256 submissionId,
        uint32 networkId,
        uint256[] calldata cps,
        bytes32[] calldata hashes
    ) external {
        bytes memory payload = abi.encode(uint8(1), submissionId, networkId, cps, hashes);
        this._processChallenge(srcEid, payload);
    }

    // Direct access to the shared slash helper. slashIncoherentRoot now routes
    // through _executeSlash (re-audit 2026-06-14, SIR-PUSH-1), so exercising the
    // helper with a reverting rewardTo proves the incoherent-root slash path can
    // no longer be DoS'd by a non-payable challenger.
    function harnessExecuteSlash(address validator, uint256 submissionId, address rewardTo) external {
        _executeSlash(validator, submissionId, 0, rewardTo);
    }
}

/// @dev A reward recipient that reverts on raw ETH receipt — the kind of
///      contract-wallet challenger that, under the old push-pattern
///      slashIncoherentRoot, would have reverted the entire slash.
contract RevertingReceiver {
    receive() external payable { revert("no ETH"); }

    function claim(CawActionsArchive archive, address to) external {
        archive.claimReward(to);
    }
}

contract ArchiveNonExistenceTest is Test {
    ArchiveHarness archive;
    MockLayerZeroEndpoint lzEp;
    address pathwayExpander = makeAddr("pathwayExpander");
    address attacker = makeAddr("attacker");
    address relayer  = makeAddr("relayer");
    uint32 constant NETWORK_ID = 1;
    uint32 constant L2_EID = 40245;
    uint32 constant OTHER_L2_EID = 40231;

    function setUp() public {
        lzEp = new MockLayerZeroEndpoint(L2_EID);
        archive = new ArchiveHarness(address(lzEp), pathwayExpander);
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        archive.deposit{value: 0.05 ether}();
    }

    // The lethal low-volume case: attacker submits checkpoints 11–266 while the
    // source has only reached checkpoint 16. A non-existence proof slashes them
    // and pays the relayer the stake.
    function test_overReachingSubmission_isSlashed() public {
        archive.harnessInjectSubmission(1, attacker, NETWORK_ID, 11, 266, L2_EID);

        // Source's real height = 16 (only checkpoints 1..16 exist).
        archive.harnessDeliverNonExistence(L2_EID, 1, NETWORK_ID, 16, relayer);

        // Slashed: status SLASHED, stake zeroed, reward CREDITED to relayer (pull).
        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(1);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.SLASHED), "over-reaching submission slashed");
        assertEq(archive.stakes(attacker), 0, "attacker stake zeroed");
        // NONEXIST-1: reward is pull-pattern (credited, not pushed).
        assertEq(archive.pendingReward(relayer), 0.05 ether, "relayer reward credited");

        // Relayer claims to a fresh address.
        uint256 relayerBalBefore = relayer.balance;
        vm.prank(relayer);
        archive.claimReward(relayer);
        assertEq(relayer.balance, relayerBalBefore + 0.05 ether, "relayer claims the slashed stake");
        assertEq(archive.pendingReward(relayer), 0, "reward cleared after claim");
    }

    // ARC-NEX-1: a fraudulent validator self-relaying their own non-existence
    // slash (rewardTo = themselves) is rejected — they can't recover their stake.
    function test_selfSlash_rejected() public {
        archive.harnessInjectSubmission(9, attacker, NETWORK_ID, 11, 266, L2_EID);
        // _executeSlash reverts "Self-slash forbidden"; _processChallenge runs it
        // via this._processNonExistence, so the revert bubbles out of the harness call.
        vm.expectRevert();
        archive.harnessDeliverNonExistence(L2_EID, 9, NETWORK_ID, 16, attacker);
        // Submission untouched, stake intact.
        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(9);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.PENDING), "self-slash did not slash");
        assertEq(archive.stakes(attacker), 0.05 ether, "stake intact after rejected self-slash");
    }

    // An HONEST submission entirely within the source's real height is NOT slashed
    // (a non-existence proof against it is a no-op).
    function test_honestSubmission_notSlashed() public {
        archive.harnessInjectSubmission(2, attacker, NETWORK_ID, 1, 16, L2_EID);

        archive.harnessDeliverNonExistence(L2_EID, 2, NETWORK_ID, 16, relayer);

        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(2);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.PENDING), "in-range submission untouched");
        assertEq(archive.stakes(attacker), 0.05 ether, "honest stake intact");
    }

    // Boundary: endCheckpointId exactly equal to the source height is in-range
    // (the checkpoint exists), so NOT slashed.
    function test_exactHeight_notSlashed() public {
        archive.harnessInjectSubmission(3, attacker, NETWORK_ID, 10, 16, L2_EID);
        archive.harnessDeliverNonExistence(L2_EID, 3, NETWORK_ID, 16, relayer);
        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(3);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.PENDING), "endCp == height is in-range");
    }

    // SIR-PUSH-1 regression (re-audit 2026-06-14): slashIncoherentRoot now routes
    // through _executeSlash, so a challenger that reverts on ETH receipt no longer
    // reverts the slash. The slash lands unconditionally and the reward is credited
    // (pull) for later claim to a payable address — proving the incoherent-root
    // path is no longer DoS-able by a contract-wallet challenger.
    function test_slash_withRevertingRewardTo_stillLands() public {
        RevertingReceiver challenger = new RevertingReceiver();
        archive.harnessInjectSubmission(4, attacker, NETWORK_ID, 11, 266, L2_EID);

        // Slash crediting the reverting challenger. Under the old push pattern this
        // would have reverted; with the pull pattern it must succeed.
        archive.harnessExecuteSlash(attacker, 4, address(challenger));

        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(4);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.SLASHED), "slash lands despite reverting rewardTo");
        assertEq(archive.stakes(attacker), 0, "attacker stake zeroed");
        assertEq(archive.pendingReward(address(challenger)), 0.05 ether, "reward credited to reverting challenger");

        // The challenger reverts on its own address but can claim to a payable EOA.
        challenger.claim(archive, relayer);
        assertEq(relayer.balance, 0.05 ether, "reward claimed to a payable address");
        assertEq(archive.pendingReward(address(challenger)), 0, "reward cleared after claim");
    }

    // A relay on another L2 sees its own stream for the network (often empty),
    // so its height says nothing about this submission. Dropped with reason 5,
    // the submission stays PENDING and the stake is untouched.
    function test_nonExistence_fromOtherL2_isDropped() public {
        archive.harnessInjectSubmission(5, attacker, NETWORK_ID, 1, 16, L2_EID);

        vm.expectEmit(true, false, false, true, address(archive));
        emit CawActionsArchive.ChallengeDropped(5, 5);
        archive.harnessDeliverNonExistence(OTHER_L2_EID, 5, NETWORK_ID, 0, relayer);

        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(5);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.PENDING), "other L2's height ignored");
        assertEq(archive.stakes(attacker), 0.05 ether, "stake intact");
    }

    // Checkpoint hashes from another L2 belong to that L2's stream for the same
    // networkId. They are not recorded against this submission, so they can't
    // be used to slash it.
    function test_challengeHash_fromOtherL2_isDropped() public {
        archive.harnessInjectSubmission(6, attacker, NETWORK_ID, 1, 16, L2_EID);
        uint256[] memory cps = new uint256[](1);
        bytes32[] memory hashes = new bytes32[](1);
        cps[0] = 1;
        hashes[0] = keccak256("other L2 checkpoint 1");

        vm.expectEmit(true, false, false, true, address(archive));
        emit CawActionsArchive.ChallengeDropped(6, 5);
        archive.harnessDeliverChallenge(OTHER_L2_EID, 6, NETWORK_ID, cps, hashes);
        assertFalse(archive.challengeDelivered(6, 1), "not recorded from another L2");

        // The same message from the submission's own L2 is recorded.
        archive.harnessDeliverChallenge(L2_EID, 6, NETWORK_ID, cps, hashes);
        assertTrue(archive.challengeDelivered(6, 1), "recorded from the source L2");
        assertEq(archive.challengeHash(6, 1), hashes[0]);
    }

    // Claims are per (sourceEid, networkId): a stream on another L2 does not
    // occupy this L2's checkpoints, and a slash releases only its own stream.
    function test_claims_arePerStream() public {
        archive.harnessInjectSubmission(7, attacker, NETWORK_ID, 1, 4, OTHER_L2_EID);
        assertEq(archive.checkpointClaimed(OTHER_L2_EID, NETWORK_ID, 1), 7);
        assertEq(archive.checkpointClaimed(L2_EID, NETWORK_ID, 1), 0);
        assertTrue(archive.isRangeAvailable(L2_EID, NETWORK_ID, 1, 4), "this L2's range is free");
        assertFalse(archive.isRangeAvailable(OTHER_L2_EID, NETWORK_ID, 1, 4), "other L2's range is taken");

        // Non-existence from the stream's own L2 slashes it and reopens only that stream.
        archive.harnessDeliverNonExistence(OTHER_L2_EID, 7, NETWORK_ID, 0, relayer);
        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(7);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.SLASHED));
        assertEq(archive.checkpointClaimed(OTHER_L2_EID, NETWORK_ID, 1), 0);
        assertGt(archive.checkpointClaimReopensAt(OTHER_L2_EID, NETWORK_ID, 1), 0, "cooldown on its own stream");
        assertEq(archive.checkpointClaimReopensAt(L2_EID, NETWORK_ID, 1), 0, "no cooldown on this L2's stream");
    }
}
