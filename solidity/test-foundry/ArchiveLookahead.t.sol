// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// ARC-FUTURE-1 (audit 2026-06-13): bounded-lookahead guard on submitReplication.
// An attacker could submit fabricated data for FAR-FUTURE checkpoints (cpId 10000
// when the source has reached cpId 5) — un-challengeable for the 2-day window
// (networkHashAtCheckpoint == 0 → relayChallenge reverts), then finalize and
// permanently poison the slots. The bound rejects any submission reaching more
// than LOOKAHEAD_WINDOW checkpoints past the network's highest finalized
// checkpoint, while comfortably covering the full legit in-flight pipeline.

import "forge-std/Test.sol";
import "../contracts/CawActionsArchive.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

contract ArchiveLookaheadTest is Test {
    CawActionsArchive archive;
    MockLayerZeroEndpoint lzEp;
    address pathwayExpander = makeAddr("pathwayExpander");
    address validator = makeAddr("validator");
    uint32 constant NETWORK_ID = 1;
    uint32 constant L2_EID = 40245;

    function setUp() public {
        lzEp = new MockLayerZeroEndpoint(L2_EID);
        // OApp ctor sets owner = msg.sender = this; pathwayExpander is the delegate.
        archive = new CawActionsArchive(address(lzEp), pathwayExpander);
        vm.deal(validator, 1 ether);
        vm.prank(validator);
        archive.deposit{value: 0.05 ether}();
    }

    // A far-future submission (cpId 10000 from genesis, lastFinalized==0) must
    // revert on the lookahead bound — BEFORE any action data is needed (the bound
    // check fires before the action-count / merkle checks).
    function test_farFuture_reverts() public {
        bytes memory emptyActions = "";
        bytes32[] memory emptyR = new bytes32[](0);
        uint256 farStart = archive.LOOKAHEAD_WINDOW() + 1; // 1 past the bound
        vm.prank(validator);
        vm.expectRevert("Checkpoint too far ahead");
        archive.submitReplication(NETWORK_ID, farStart, farStart, emptyActions, emptyR, bytes32(uint256(1)), bytes32(0));
    }

    // A submission at the edge of the window passes the bound (and then fails
    // later on action-count — proving the bound itself accepted it).
    function test_withinWindow_passesBound() public {
        bytes memory emptyActions = "";
        bytes32[] memory emptyR = new bytes32[](0);
        uint256 edge = archive.LOOKAHEAD_WINDOW(); // exactly at the bound
        vm.prank(validator);
        // Passes the lookahead bound; reverts later (no valid action data). The
        // point is the revert is NOT "Checkpoint too far ahead".
        vm.expectRevert(bytes("Action count mismatch"));
        archive.submitReplication(NETWORK_ID, edge, edge, emptyActions, emptyR, bytes32(uint256(1)), bytes32(0));
    }

    // The bound is per-network and starts from 0 (genesis): a genesis submission
    // for cp 1 is well within the window.
    function test_genesis_smallSubmission_passesBound() public {
        bytes memory emptyActions = "";
        bytes32[] memory emptyR = new bytes32[](0);
        vm.prank(validator);
        vm.expectRevert(bytes("Action count mismatch")); // passed the bound; fails on data
        archive.submitReplication(NETWORK_ID, 1, 1, emptyActions, emptyR, bytes32(uint256(1)), bytes32(0));
    }
}
