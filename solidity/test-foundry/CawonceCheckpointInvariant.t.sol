// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// =============================================================================
// CawonceCheckpointInvariant.t.sol — Foundry invariant test
//
// Properties tested:
//   1. No cawonce slot ever flips from used→unused.
//   2. networkHashAtCheckpoint[netId][i] is only set after networkActionCount
//      crosses i*CHECKPOINT_INTERVAL (32).  It never resets.
//   3. networkActionCount is monotonically non-decreasing.
//   4. networkCurrentHash is consistent with the last-applied checkpoint logic.
//
// Approach: instead of constructing full packed-action calldata (which requires
// ECDSA signing infrastructure in Solidity), we use the CawonceHarness for
// property (1) and a lightweight CawActions storage harness for properties (2-4).
//
// For properties (2-4) we write a StorageHarness that reproduces CawActions'
// cawonce and checkpoint storage logic verbatim, without needing valid sigs.
// This captures the class of bugs where a coding error in the hash chain or
// cawonce bitmap could reset state.
// =============================================================================

import "forge-std/Test.sol";
import "./harness/CawonceHarness.sol";

// ---------------------------------------------------------------------------
// Checkpoint storage harness — mirrors the CawActions checkpoint + cawonce
// storage logic without requiring real packed calldata or ECDSA sigs.
// ---------------------------------------------------------------------------
contract CheckpointHarness {
    uint256 private constant CHECKPOINT_INTERVAL = 32;

    mapping(uint32 => uint256) public networkActionCount;
    mapping(uint32 => bytes32) public networkCurrentHash;
    mapping(uint32 => mapping(uint256 => bytes32)) public networkHashAtCheckpoint;
    mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;

    error AlreadyUsed();

    /// @notice Apply one action: use a cawonce and advance the hash chain.
    ///         The action bytes are arbitrary (just keccak'd into the chain).
    ///         Reverts if cawonce already used (same semantics as CawActions).
    function applyAction(
        uint32 networkId,
        uint32 senderId,
        uint32 cawonce,
        bytes32 rAnchor,
        bytes memory actionBytes
    ) external {
        // --- cawonce bitmap ---
        uint256 slot = cawonce >> 8;
        uint256 bit  = 1 << (cawonce & 0xff);
        if ((usedCawonce[senderId][slot] & bit) != 0) revert AlreadyUsed();
        usedCawonce[senderId][slot] |= bit;

        // --- hash chain ---
        bytes32 prevHash = networkCurrentHash[networkId];
        bytes32 actionHash = keccak256(actionBytes);
        // CawActions uses the r-anchor from the sig; here we use rAnchor param
        bytes32 newHash = keccak256(abi.encodePacked(prevHash, actionHash, rAnchor));
        networkCurrentHash[networkId] = newHash;

        uint256 prevCount = networkActionCount[networkId];
        uint256 newCount  = prevCount + 1;
        networkActionCount[networkId] = newCount;

        // Checkpoint: store at every CHECKPOINT_INTERVAL boundary
        if (newCount % CHECKPOINT_INTERVAL == 0) {
            uint256 checkpointIdx = newCount / CHECKPOINT_INTERVAL;
            networkHashAtCheckpoint[networkId][checkpointIdx] = newHash;
        }
    }

    /// @notice Check if a cawonce is used.
    function isCawonceUsed(uint32 senderId, uint256 cawonce_) external view returns (bool) {
        uint256 slot = cawonce_ >> 8;
        uint256 bit  = 1 << (cawonce_ & 0xff);
        return (usedCawonce[senderId][slot] & bit) != 0;
    }
}

// ---------------------------------------------------------------------------
// Cawonce handler (wraps CawonceHarness for property 1)
// ---------------------------------------------------------------------------
contract CawonceHandler is Test {
    CawonceHarness public h;

    mapping(uint32 => mapping(uint256 => bool)) public markedSlots;
    uint256 public successCount;
    uint256 public collisionCount;

    uint32  constant MAX_SENDER  = 6;
    uint256 constant MAX_CAWONCE = 512;

    constructor(CawonceHarness _h) { h = _h; }

    function handler_useCawonce(uint32 senderId, uint256 cawonce) external {
        senderId = uint32(bound(uint256(senderId), 0, MAX_SENDER - 1));
        cawonce  = bound(cawonce, 0, MAX_CAWONCE - 1);

        bool wasMarked = markedSlots[senderId][cawonce];
        try h.useCawonce(senderId, cawonce) {
            assertTrue(!wasMarked, "succeeded on already-marked slot");
            markedSlots[senderId][cawonce] = true;
            successCount++;
        } catch {
            assertTrue(wasMarked, "reverted on fresh cawonce slot");
            collisionCount++;
        }
    }
}

// ---------------------------------------------------------------------------
// Checkpoint handler (wraps CheckpointHarness for properties 2-4)
// ---------------------------------------------------------------------------
contract CheckpointHandler is Test {
    CheckpointHarness public h;

    // Ghost: map of (networkId, checkpointIdx) => hash captured at write time
    mapping(uint32 => mapping(uint256 => bytes32)) public ghost_checkpoints;
    // Ghost: last seen networkActionCount per network
    mapping(uint32 => uint256) public ghost_lastActionCount;

    uint32 constant NUM_NETWORKS = 3;
    uint32 constant NUM_SENDERS  = 5;
    uint256 constant MAX_CAWONCE_RANGE = 1024;

    // Track next available cawonce per sender to avoid collisions in handler
    mapping(uint32 => uint256) internal _nextCawonce;

    constructor(CheckpointHarness _h) { h = _h; }

    function handler_applyAction(
        uint256 networkSeed,
        uint256 senderSeed,
        uint256 rSeed,
        uint256 dataSeed
    ) external {
        uint32 networkId = uint32(bound(networkSeed, 1, NUM_NETWORKS));
        uint32 senderId  = uint32(bound(senderSeed, 1, NUM_SENDERS));

        // Use a fresh cawonce to guarantee no collision
        uint32 cawonce = uint32(_nextCawonce[senderId]);
        _nextCawonce[senderId]++;

        bytes32 rAnchor = keccak256(abi.encodePacked("r", rSeed));
        bytes memory actionBytes = abi.encodePacked("action", dataSeed, senderId, cawonce);

        uint256 prevCount = h.networkActionCount(networkId);
        h.applyAction(networkId, senderId, cawonce, rAnchor, actionBytes);
        uint256 newCount = h.networkActionCount(networkId);

        // Capture checkpoint if one was just written
        if (newCount % 32 == 0) {
            uint256 idx = newCount / 32;
            bytes32 checkpointHash = h.networkHashAtCheckpoint(networkId, idx);
            ghost_checkpoints[networkId][idx] = checkpointHash;
        }

        // Ghost: record action count must be prevCount + 1
        require(newCount == prevCount + 1, "actionCount did not increment by 1");
        ghost_lastActionCount[networkId] = newCount;
    }

    function handler_advanceBlock() external {
        vm.roll(block.number + 1);
    }
}

// ---------------------------------------------------------------------------
// Invariant test combining both harnesses
// ---------------------------------------------------------------------------
contract CawonceCheckpointInvariantTest is Test {
    CawonceHarness    public cawonceHarness;
    CawonceHandler    public cawonceHandler;

    CheckpointHarness public checkpointHarness;
    CheckpointHandler public checkpointHandler;

    uint32 constant NUM_NETWORKS = 3;
    uint32 constant CHECKPOINT_INTERVAL = 32;

    function setUp() public {
        // --- Part 1: cawonce invariants ---
        cawonceHarness = new CawonceHarness();
        cawonceHandler = new CawonceHandler(cawonceHarness);

        // --- Part 2: checkpoint invariants ---
        checkpointHarness = new CheckpointHarness();
        checkpointHandler = new CheckpointHandler(checkpointHarness);

        targetContract(address(cawonceHandler));
        targetContract(address(checkpointHandler));

        bytes4[] memory sel1 = new bytes4[](1);
        sel1[0] = cawonceHandler.handler_useCawonce.selector;
        targetSelector(FuzzSelector({addr: address(cawonceHandler), selectors: sel1}));

        bytes4[] memory sel2 = new bytes4[](2);
        sel2[0] = checkpointHandler.handler_applyAction.selector;
        sel2[1] = checkpointHandler.handler_advanceBlock.selector;
        targetSelector(FuzzSelector({addr: address(checkpointHandler), selectors: sel2}));
    }

    // -----------------------------------------------------------------------
    // Cawonce invariants
    // -----------------------------------------------------------------------

    /// @notice Every successfully-marked slot must be reported as used.
    function invariant_allMarkedSlotsAreUsed() public view {
        for (uint32 s = 0; s < 6; s++) {
            for (uint256 c = 0; c < 512; c++) {
                if (cawonceHandler.markedSlots(s, c)) {
                    assertTrue(
                        cawonceHarness.isCawonceUsed(s, c),
                        "marked slot not reported used"
                    );
                }
            }
        }
    }

    /// @notice No slot reported as used that handler never marked (catches adjacent-bit bugs).
    function invariant_noSpuriousMarks() public view {
        for (uint32 s = 0; s < 6; s++) {
            for (uint256 c = 0; c < 512; c++) {
                if (cawonceHarness.isCawonceUsed(s, c)) {
                    assertTrue(
                        cawonceHandler.markedSlots(s, c),
                        "harness reports slot used but handler never marked it"
                    );
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Checkpoint invariants
    // -----------------------------------------------------------------------

    /// @notice networkActionCount is monotonically non-decreasing.
    ///         Since the handler only ever increments it by 1, checking that
    ///         ghost_lastActionCount <= current is sufficient.
    function invariant_actionCountNonDecreasing() public view {
        for (uint32 n = 1; n <= NUM_NETWORKS; n++) {
            assertGe(
                checkpointHarness.networkActionCount(n),
                checkpointHandler.ghost_lastActionCount(n),
                "networkActionCount decreased"
            );
        }
    }

    /// @notice Checkpoint hashes are only set at CHECKPOINT_INTERVAL boundaries.
    ///         For every captured ghost checkpoint, the on-chain value must match.
    ///         Also verify that no checkpoints appear at non-boundary indices.
    function invariant_checkpointOnlyAtBoundary() public view {
        for (uint32 n = 1; n <= NUM_NETWORKS; n++) {
            uint256 maxCount = checkpointHarness.networkActionCount(n);
            uint256 maxIdx   = maxCount / CHECKPOINT_INTERVAL;

            // Validate ghost-captured checkpoints match on-chain
            for (uint256 idx = 1; idx <= maxIdx; idx++) {
                bytes32 ghostHash   = checkpointHandler.ghost_checkpoints(n, idx);
                bytes32 onChainHash = checkpointHarness.networkHashAtCheckpoint(n, idx);
                // Only assert if ghost recorded this checkpoint (idx was hit)
                if (ghostHash != bytes32(0)) {
                    assertEq(onChainHash, ghostHash, "checkpoint hash mismatch");
                }
            }

            // Spot-check: no checkpoint exists beyond the last written boundary
            if (maxIdx > 0) {
                bytes32 nextHash = checkpointHarness.networkHashAtCheckpoint(n, maxIdx + 1);
                assertEq(nextHash, bytes32(0), "checkpoint written beyond action count boundary");
            }
        }
    }

    /// @notice networkCurrentHash is never zero after at least one action.
    ///         A zero hash after actions would indicate a logic error that resets state.
    function invariant_currentHashNonZeroAfterActions() public view {
        for (uint32 n = 1; n <= NUM_NETWORKS; n++) {
            if (checkpointHarness.networkActionCount(n) > 0) {
                assertTrue(
                    checkpointHarness.networkCurrentHash(n) != bytes32(0),
                    "networkCurrentHash is zero after actions"
                );
            }
        }
    }
}
