// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "./harness/DistributeShapeHarness.sol";

/// @title DistributeShapeFuzzTest
/// @notice Exhaustively fuzz the top-of-`_distributeAmountsMem` validation
///         gate, in particular the new (audit fix H-2, 2026-05-08) rejection
///         of `WITHDRAW` actions with `recipients=[]` AND a trailing
///         "explicit tip" amount slot.
///
/// @dev We cover three properties:
///        1. The rejection of `numRecipients > 10` is unconditional.
///        2. `numAmounts != numRecipients` AND `numAmounts != numRecipients + 1`
///           is always rejected.
///        3. WITHDRAW + `numRecipients == 0` + `numAmounts == 1` is the only
///           extra-gated combination beyond (2). Every other combination
///           that survives (1) and (2) passes the gate.
contract DistributeShapeFuzzTest is Test {
    DistributeShapeHarness internal h;

    function setUp() public {
        h = new DistributeShapeHarness();
    }

    // ---------------------------------------------------------------
    // Property 1: too-many-recipients always rejected.
    // ---------------------------------------------------------------
    function testFuzz_TooManyRecipientsRejected(uint256 numRecipients, uint256 numAmounts, uint8 atRaw) public view {
        numRecipients = bound(numRecipients, 11, 1024);
        // numAmounts can be anything — too-many-recipients fires first.
        numAmounts = bound(numAmounts, 0, 2048);
        DistributeShapeHarness.ActionType at = DistributeShapeHarness.ActionType(uint8(bound(uint256(atRaw), 0, 7)));

        DistributeShapeHarness.Outcome o = h.classify(at, numRecipients, numAmounts);
        assertTrue(o == DistributeShapeHarness.Outcome.TooManyRecipients, "expected too-many");
    }

    // ---------------------------------------------------------------
    // Property 2: malformed length — neither N nor N+1 — always rejected
    //             with the mismatch outcome.
    // ---------------------------------------------------------------
    function testFuzz_AmountsLengthMismatchRejected(uint256 numRecipients, uint256 numAmounts, uint8 atRaw) public view {
        numRecipients = bound(numRecipients, 0, 10);
        numAmounts    = bound(numAmounts,    0, 50);
        DistributeShapeHarness.ActionType at = DistributeShapeHarness.ActionType(uint8(bound(uint256(atRaw), 0, 7)));
        // Skip the legitimate shapes — we want the mismatch path.
        vm.assume(numAmounts != numRecipients && numAmounts != numRecipients + 1);

        DistributeShapeHarness.Outcome o = h.classify(at, numRecipients, numAmounts);
        assertTrue(
            o == DistributeShapeHarness.Outcome.AmountsRecipientsMismatch,
            "expected mismatch"
        );
    }

    // ---------------------------------------------------------------
    // Property 3: WITHDRAW + 0 recipients + 1 amount is the only NEW
    //             reject (the audit-fix discriminator). Everything else
    //             that survives (1) and (2) passes.
    // ---------------------------------------------------------------
    function testFuzz_WithdrawEmptyTipSlotRejectedNothingElse(uint256 numRecipients, bool useTipSlot, uint8 atRaw) public view {
        numRecipients = bound(numRecipients, 0, 10);
        uint256 numAmounts = useTipSlot ? numRecipients + 1 : numRecipients;
        DistributeShapeHarness.ActionType at = DistributeShapeHarness.ActionType(uint8(bound(uint256(atRaw), 0, 7)));

        DistributeShapeHarness.Outcome o = h.classify(at, numRecipients, numAmounts);

        bool isWithdrawal = at == DistributeShapeHarness.ActionType.WITHDRAW;
        bool isAuditFixCase = isWithdrawal && numRecipients == 0 && useTipSlot;

        if (isAuditFixCase) {
            assertTrue(
                o == DistributeShapeHarness.Outcome.WithdrawEmptyRecipientsTipSlot,
                "audit-fix case must be flagged"
            );
        } else {
            assertTrue(
                o == DistributeShapeHarness.Outcome.Pass,
                "non-audit-fix case must pass the shape gate"
            );
        }
    }

    // ---------------------------------------------------------------
    // Targeted unit tests covering documented shapes.
    // ---------------------------------------------------------------

    function test_LegitimateWithdrawEmptyRecipientsSingleAmount_Passes() public view {
        // The legitimate withdraw-with-no-tip shape: recipients=[], amounts=[X].
        // BUT note this shape is ALSO numAmounts == numRecipients + 1 (= 0 + 1).
        // Per the audit-fix, this is REJECTED so the user is forced to fall
        // through the explicit-tip branch only when they actually have
        // recipients to pay. The ONLY safe withdraw-with-no-recipients path is
        // a different upstream construction.
        DistributeShapeHarness.Outcome o = h.classify(
            DistributeShapeHarness.ActionType.WITHDRAW,
            0,
            1
        );
        assertEq(uint256(o), uint256(DistributeShapeHarness.Outcome.WithdrawEmptyRecipientsTipSlot));
    }

    function test_LikeWithExplicitTip_Passes() public view {
        // A LIKE with one recipient + explicit tip slot is fine.
        DistributeShapeHarness.Outcome o = h.classify(
            DistributeShapeHarness.ActionType.LIKE,
            1,
            2
        );
        assertEq(uint256(o), uint256(DistributeShapeHarness.Outcome.Pass));
    }

    function test_NoRecipientsNoAmounts_Passes() public view {
        // Recipient-less actions (e.g. CAW post with no recipients) must pass.
        DistributeShapeHarness.Outcome o = h.classify(
            DistributeShapeHarness.ActionType.CAW,
            0,
            0
        );
        assertEq(uint256(o), uint256(DistributeShapeHarness.Outcome.Pass));
    }
}
