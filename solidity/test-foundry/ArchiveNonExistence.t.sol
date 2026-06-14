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
        uint64 endCp
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
        validatorSubmissions[submitter].push(submissionId);
        validatorSubmissionsIndexPlusOne[submissionId] = validatorSubmissions[submitter].length;
        pendingCount[submitter] += 1;
    }

    // Build the MSG_NONEXISTENCE payload and route it through the self-call the
    // same way _lzReceive -> _processChallenge would.
    function harnessDeliverNonExistence(
        uint256 submissionId,
        uint32 networkId,
        uint256 sourceMaxCheckpoint,
        address rewardTo
    ) external {
        bytes memory payload = abi.encode(uint8(2), submissionId, networkId, sourceMaxCheckpoint, rewardTo);
        this._processChallenge(payload);
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
        archive.harnessInjectSubmission(1, attacker, NETWORK_ID, 11, 266);

        uint256 relayerBalBefore = relayer.balance;
        // Source's real height = 16 (only checkpoints 1..16 exist).
        archive.harnessDeliverNonExistence(1, NETWORK_ID, 16, relayer);

        // Slashed: status SLASHED, stake zeroed, relayer paid.
        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(1);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.SLASHED), "over-reaching submission slashed");
        assertEq(archive.stakes(attacker), 0, "attacker stake zeroed");
        assertEq(relayer.balance, relayerBalBefore + 0.05 ether, "relayer paid the slashed stake");
    }

    // An HONEST submission entirely within the source's real height is NOT slashed
    // (a non-existence proof against it is a no-op).
    function test_honestSubmission_notSlashed() public {
        archive.harnessInjectSubmission(2, attacker, NETWORK_ID, 1, 16);

        archive.harnessDeliverNonExistence(2, NETWORK_ID, 16, relayer);

        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(2);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.PENDING), "in-range submission untouched");
        assertEq(archive.stakes(attacker), 0.05 ether, "honest stake intact");
    }

    // Boundary: endCheckpointId exactly equal to the source height is in-range
    // (the checkpoint exists), so NOT slashed.
    function test_exactHeight_notSlashed() public {
        archive.harnessInjectSubmission(3, attacker, NETWORK_ID, 10, 16);
        archive.harnessDeliverNonExistence(3, NETWORK_ID, 16, relayer);
        ( , , , , , , CawActionsArchive.Status status, ) = archive.submissions(3);
        assertEq(uint8(status), uint8(CawActionsArchive.Status.PENDING), "endCp == height is in-range");
    }
}
