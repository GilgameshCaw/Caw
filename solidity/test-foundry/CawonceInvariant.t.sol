// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "./harness/CawonceHarness.sol";

/// @title CawonceInvariantTest
/// @notice Invariant: no cawonce slot can be marked twice. The harness mirrors
///         CawActions.useCawonce verbatim, so a regression in the bitmap
///         packing (e.g. swapping `>> 8` and `& 0xff`, or using `bit + 1`) would
///         allow a double-mark and surface here as a falsified invariant.
///
/// @dev Stateful invariant test — Foundry generates random sequences of
///      `useCawonce(senderId, cawonce)` calls and asserts after each step
///      that every (senderId, cawonce) pair we successfully marked is
///      reported as used. We use a parallel bookkeeping mapping in the
///      handler to compare against the harness.
contract CawonceHandler is Test {
    CawonceHarness public h;

    /// @dev Tracking pairs we've successfully marked.
    mapping(uint32 => mapping(uint256 => bool)) public marked;
    uint256 public successCount;
    uint256 public collisionCount;

    /// @dev Bound the input space so we get meaningful collisions.
    ///      4 senders * 256 cawonce range = ~1024 slots; with depth=32 runs we
    ///      reliably explore overlap.
    uint32  internal constant MAX_SENDER  = 4;
    uint256 internal constant MAX_CAWONCE = 256;

    constructor(CawonceHarness _h) {
        h = _h;
    }

    function tryUseCawonce(uint32 senderId, uint256 cawonce) external {
        senderId = uint32(bound(uint256(senderId), 0, MAX_SENDER - 1));
        cawonce  = bound(cawonce, 0, MAX_CAWONCE - 1);

        bool wasMarked = marked[senderId][cawonce];
        try h.useCawonce(senderId, cawonce) {
            // Should ONLY succeed if we hadn't marked it.
            assertTrue(!wasMarked, "succeeded on already-marked");
            marked[senderId][cawonce] = true;
            successCount++;
        } catch {
            // Should ONLY revert if we HAD marked it.
            assertTrue(wasMarked, "reverted on fresh slot");
            collisionCount++;
        }
    }
}

contract CawonceInvariantTest is Test {
    CawonceHarness  public harness;
    CawonceHandler  public handler;

    function setUp() public {
        harness = new CawonceHarness();
        handler = new CawonceHandler(harness);

        // Restrict the invariant runner to the handler's exposed function.
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = handler.tryUseCawonce.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice For every (senderId, cawonce) the handler successfully marked,
    ///         the harness reports the slot as used. Sweeping the bounded
    ///         space at the end of the run catches a stale-or-mismatched
    ///         packing bug.
    function invariant_AllMarkedSlotsAreUsed() public view {
        for (uint32 s = 0; s < 4; s++) {
            for (uint256 c = 0; c < 256; c++) {
                if (handler.marked(s, c)) {
                    assertTrue(harness.isCawonceUsed(s, c), "marked but not reported used");
                }
            }
        }
    }

    /// @notice The harness only marks a slot when handler.tryUseCawonce
    ///         succeeded — i.e. we should never see a slot reported as used
    ///         that the handler never successfully marked. This catches a
    ///         regression where useCawonce sets bits adjacent to its target.
    function invariant_NoSpuriousMarks() public view {
        for (uint32 s = 0; s < 4; s++) {
            for (uint256 c = 0; c < 256; c++) {
                if (harness.isCawonceUsed(s, c)) {
                    assertTrue(handler.marked(s, c), "harness used set without handler success");
                }
            }
        }
    }
}
