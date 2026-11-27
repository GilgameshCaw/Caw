// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// A share of a slashed stake (SLASH_BURN_BPS) goes to the dead address; the account that
// lands the slash is credited the rest.
//
// _executeSlash used to credit the whole stake to `rewardTo`, and the self-slash guard
// compares addresses only. A validator that submitted fraud could slash itself from a
// second address and claim its whole stake back, on every slash route:
//   slashIncoherentRoot, resolveChallenge, and the proof of non-existence.
// These tests run each route with a second address and check that the validator now
// loses the burned share. The two routes that need LayerZero use two mock endpoints, so
// the message is delivered in the same transaction; the mock charges a mock fee.

import "forge-std/Test.sol";
import "../contracts/CawActionsArchive.sol";
import "../contracts/CawChallengeRelay.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

// The source-chain CawActions, reduced to the two views the relay reads.
contract BurnSourceActionsStub {
    mapping(uint32 => mapping(uint256 => bytes32)) public networkHashAtCheckpoint;
    mapping(uint32 => uint256) public networkActionCount;
    function setHash(uint32 n, uint256 cp, bytes32 h) external { networkHashAtCheckpoint[n][cp] = h; }
    function setCount(uint32 n, uint256 c) external { networkActionCount[n] = c; }
}

contract ArchiveSlashBurnTest is Test {
    CawActionsArchive archive;
    CawChallengeRelay relay;
    BurnSourceActionsStub source;
    MockLayerZeroEndpoint epSource;
    MockLayerZeroEndpoint epArchive;

    uint32 constant SOURCE_EID = 40245;
    uint32 constant ARCHIVE_EID = 40231;
    uint32 constant NETWORK_ID = 1;

    // Must equal SLASH_BURN_BPS in CawActionsArchive.
    uint256 constant BURN_BPS = 5_000;
    uint256 constant STAKE = 0.05 ether;
    uint256 constant BURNED = (STAKE * BURN_BPS) / 10_000;
    uint256 constant REWARD = STAKE - BURNED;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address cheater    = makeAddr("cheater");
    address cheaterAlt = makeAddr("cheaterSecondAddress");
    address challenger = makeAddr("unrelatedChallenger");

    function setUp() public {
        epSource  = new MockLayerZeroEndpoint(SOURCE_EID);
        epArchive = new MockLayerZeroEndpoint(ARCHIVE_EID);
        source    = new BurnSourceActionsStub();
        // This contract is both the OApp owner (deployer) and the delegate.
        archive = new CawActionsArchive(address(epArchive), address(this));
        relay   = new CawChallengeRelay(address(epSource), address(source), address(this));
        archive.setPeer(SOURCE_EID, bytes32(uint256(uint160(address(relay)))));
        relay.setPeer(ARCHIVE_EID, bytes32(uint256(uint160(address(archive)))));
        epSource.setDestLzEndpoint(address(archive), address(epArchive));

        vm.deal(cheater, 1 ether);
        vm.deal(cheaterAlt, 1 ether);
        vm.deal(challenger, 1 ether);
        vm.prank(cheater);
        archive.deposit{value: STAKE}();
    }

    // One checkpoint = 32 actions; the smallest well-formed action is 25 zero bytes.
    function _packed() internal pure returns (bytes memory b) {
        b = abi.encodePacked(uint16(32));
        for (uint256 i = 0; i < 32; i++) b = abi.encodePacked(b, new bytes(25));
    }
    function _r() internal pure returns (bytes32[] memory) { return new bytes32[](32); }

    function _submit(uint256 cp, bytes32 root) internal returns (uint256 id) {
        vm.prank(cheater);
        archive.submitReplication(NETWORK_ID, cp, cp, _packed(), _r(), root, bytes32(0));
        id = archive.nextSubmissionId() - 1;
    }

    function _status(uint256 id) internal view returns (CawActionsArchive.Status s) {
        ( , , , , , , s, ) = archive.submissions(id);
    }

    // After a second-address slash and its claim: the validator is out the burned share,
    // the dead address holds it, and the contract holds nothing more.
    function _assertValidatorLostTheBurnedShare() internal {
        assertEq(archive.stakes(cheater), 0, "stake is gone from the validator");
        assertEq(archive.pendingReward(cheaterAlt), REWARD, "only the rest is credited");
        assertEq(DEAD.balance, BURNED, "the burned share is at the dead address");

        vm.prank(cheaterAlt);
        archive.claimReward(cheater);
        assertEq(cheater.balance, 1 ether - BURNED, "the validator is out the burned share");
        assertEq(address(archive).balance, 0, "nothing is left in the contract");
    }

    // ───────────── route 1: slashIncoherentRoot ─────────────

    function test_incoherentRoot_secondAddress_losesBurnedShare() public {
        uint256 id = _submit(1, bytes32(uint256(1)));   // a root the data cannot produce
        vm.prank(cheaterAlt);
        archive.slashIncoherentRoot(id, _packed(), _r(), bytes32(0));
        assertEq(uint8(_status(id)), uint8(CawActionsArchive.Status.SLASHED));
        _assertValidatorLostTheBurnedShare();
    }

    // The guard that was already there still holds for the validator's own address.
    function test_incoherentRoot_ownAddress_stillForbidden() public {
        uint256 id = _submit(1, bytes32(uint256(1)));
        vm.prank(cheater);
        vm.expectRevert("Self-slash forbidden");
        archive.slashIncoherentRoot(id, _packed(), _r(), bytes32(0));
    }

    // ───────────── route 2: resolveChallenge ─────────────

    function test_resolveChallenge_secondAddress_losesBurnedShare() public {
        bytes32 claimed = keccak256("fabricated checkpoint hash");
        bytes32 correct = keccak256("the real checkpoint hash");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(uint256(1), claimed))));
        uint256 id = _submit(1, leaf);                  // one-leaf tree: root = leaf, empty proof
        source.setHash(NETWORK_ID, 1, correct);

        vm.prank(cheaterAlt);
        relay.relayChallenge{value: 1 ether}(ARCHIVE_EID, id, NETWORK_ID, 1);
        assertTrue(archive.challengeDelivered(id, 1));

        bytes32[] memory proof = new bytes32[](0);
        vm.prank(cheaterAlt);
        archive.resolveChallenge(id, 1, claimed, proof);
        assertEq(uint8(_status(id)), uint8(CawActionsArchive.Status.SLASHED));
        _assertValidatorLostTheBurnedShare();
    }

    // ───────────── route 3: proof of non-existence ─────────────

    function test_nonExistence_secondAddress_losesBurnedShare() public {
        uint256 id = _submit(100, bytes32(uint256(1)));  // a checkpoint the source has not reached
        source.setCount(NETWORK_ID, 64);                 // the source is at checkpoint 2

        vm.prank(cheaterAlt);
        relay.relayNonExistence{value: 1 ether}(ARCHIVE_EID, id, NETWORK_ID);
        assertEq(uint8(_status(id)), uint8(CawActionsArchive.Status.SLASHED));
        _assertValidatorLostTheBurnedShare();
    }

    // ───────────── the account that lands the slash is still paid ─────────────

    function test_unrelatedChallenger_isCreditedTheRest() public {
        uint256 id = _submit(1, bytes32(uint256(1)));
        vm.prank(challenger);
        archive.slashIncoherentRoot(id, _packed(), _r(), bytes32(0));
        assertEq(archive.pendingReward(challenger), REWARD);
        assertEq(DEAD.balance, BURNED);
        // What the challenger earns is far above what relaying costs (see the PR description).
        assertGt(REWARD, 100 * 0.000106 ether);
    }

    // ───────────── an honest validator is not affected ─────────────

    function test_honestValidator_withdrawsEverything() public {
        uint256 id = _submit(1, bytes32(uint256(1)));
        vm.warp(block.timestamp + archive.CHALLENGE_PERIOD() + 1);
        archive.finalizeSubmission(id);

        vm.prank(cheater);                               // here: the honest validator
        archive.withdraw(0);
        assertEq(cheater.balance, 1 ether, "the whole stake comes back");
        assertEq(DEAD.balance, 0, "nothing was burned");
        assertEq(address(archive).balance, 0);
    }

    // ───────────── accounting ─────────────

    // An odd stake: the two parts add up to the stake, wei for wei.
    function test_oddStake_splitConservesEveryWei() public {
        vm.prank(cheater);
        archive.deposit{value: 1}();                     // stake = STAKE + 1
        uint256 id = _submit(1, bytes32(uint256(1)));
        vm.prank(cheaterAlt);
        archive.slashIncoherentRoot(id, _packed(), _r(), bytes32(0));

        uint256 total = STAKE + 1;
        uint256 burned = (total * BURN_BPS) / 10_000;
        assertEq(DEAD.balance, burned);
        assertEq(archive.pendingReward(cheaterAlt), total - burned);
        assertEq(DEAD.balance + archive.pendingReward(cheaterAlt), total);
    }

    function testFuzz_split_neverCreatesOrLosesEth(uint96 extra) public {
        uint256 extraWei = bound(uint256(extra), 0, 100 ether);
        uint256 total = STAKE + extraWei;
        vm.deal(cheater, extraWei);
        if (extraWei > 0) {                              // deposit() refuses a zero amount
            vm.prank(cheater);
            archive.deposit{value: extraWei}();          // the setUp deposit is already in
        }
        uint256 id = _submit(1, bytes32(uint256(1)));
        vm.prank(cheaterAlt);
        archive.slashIncoherentRoot(id, _packed(), _r(), bytes32(0));

        uint256 burned = (total * BURN_BPS) / 10_000;
        assertEq(DEAD.balance, burned);
        assertEq(archive.pendingReward(cheaterAlt), total - burned);
        assertEq(address(archive).balance, total - burned, "the contract holds exactly the credited part");
    }

    // The dead address cannot refuse ETH on a real chain. If it ever did (here it is given
    // code that reverts), the slash must still land: the unsent part stays in the contract
    // and is credited to no one, and the credited part does not grow.
    function test_deadAddressRefusing_slashStillLands_andBurnStaysUnclaimable() public {
        vm.etch(DEAD, hex"60006000fd");                  // PUSH1 0 PUSH1 0 REVERT
        uint256 id = _submit(1, bytes32(uint256(1)));
        vm.prank(cheaterAlt);
        archive.slashIncoherentRoot(id, _packed(), _r(), bytes32(0));

        assertEq(uint8(_status(id)), uint8(CawActionsArchive.Status.SLASHED), "the slash landed");
        assertEq(archive.stakes(cheater), 0);
        assertEq(archive.pendingReward(cheaterAlt), REWARD, "credited part is unchanged");
        assertEq(DEAD.balance, 0);

        vm.prank(cheaterAlt);
        archive.claimReward(cheaterAlt);
        assertEq(address(archive).balance, BURNED, "the unsent share stays in the contract");
    }
}
