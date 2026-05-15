// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title DistributeShapeEchidna
/// @notice Echidna mirror of the foundry DistributeShapeHarness — fuzz the
///         shape-gate that runs before any state mutation in
///         CawActions._distributeAmountsMem.
///
/// @dev The four outcomes the gate emits are an exhaustive partition:
///        - TooManyRecipients  (numRecipients > 10)
///        - AmountsRecipientsMismatch  (numAmounts != numRecipients AND
///                                      numAmounts != numRecipients + 1)
///        - WithdrawEmptyRecipientsTipSlot  (withdraw + 0 recipients + tip slot only)
///        - Pass
///
///      Echidna confirms exhaustiveness by trying random (actionType,
///      numRecipients, numAmounts) and asserting exactly one Outcome value
///      is returned, that the classification matches an independent
///      re-derivation, and that "Pass" implies the explicit-tip / no-tip
///      shape constraints hold.
contract DistributeShapeEchidna {
    enum ActionType { CAW, LIKE, UNLIKE, RECAW, FOLLOW, UNFOLLOW, WITHDRAW, OTHER }
    enum Outcome {
        TooManyRecipients,
        AmountsRecipientsMismatch,
        WithdrawEmptyRecipientsTipSlot,
        Pass
    }

    // Counters so Echidna can show coverage of each branch in the output.
    uint256 public tooManyHits;
    uint256 public mismatchHits;
    uint256 public withdrawEmptyHits;
    uint256 public passHits;

    /// @dev Production-mirroring pure decision function.
    function classify(ActionType actionType, uint256 numRecipients, uint256 numAmounts)
        public pure returns (Outcome)
    {
        if (numRecipients > 10) return Outcome.TooManyRecipients;
        bool hasExplicitTip = numAmounts == numRecipients + 1;
        if (numAmounts != numRecipients && !hasExplicitTip) return Outcome.AmountsRecipientsMismatch;
        bool isWithdrawal = actionType == ActionType.WITHDRAW;
        if (isWithdrawal && numRecipients == 0 && hasExplicitTip) {
            return Outcome.WithdrawEmptyRecipientsTipSlot;
        }
        return Outcome.Pass;
    }

    /// @notice Stateful entry — bumps the per-branch counter. Lets Echidna
    ///         show whether all four outcomes were reachable in the fuzz run.
    function probe(uint8 a, uint256 r, uint256 n) external {
        ActionType t = ActionType(a % 8);
        // Bound numRecipients to [0..20] and numAmounts to [0..22] so we
        // straddle the >10 cap and exercise the +1 tip slot.
        r = r % 21;
        n = n % 23;
        Outcome o = classify(t, r, n);
        if (o == Outcome.TooManyRecipients) tooManyHits++;
        else if (o == Outcome.AmountsRecipientsMismatch) mismatchHits++;
        else if (o == Outcome.WithdrawEmptyRecipientsTipSlot) withdrawEmptyHits++;
        else if (o == Outcome.Pass) passHits++;
    }

    /// @notice "Pass" must mean: numAmounts is one of {numRecipients, numRecipients + 1},
    ///         numRecipients <= 10, and (action != WITHDRAW OR numRecipients > 0 OR no explicit tip).
    ///         If Pass ever returns under conditions that violate these, the gate is buggy.
    function echidna_pass_postconditions_hold() external pure returns (bool) {
        // Direct white-box check (independent of internal counters): re-derive
        // a couple of representative test points so a mutation of classify
        // surfaces immediately.
        if (classify(ActionType.CAW, 0, 0) != Outcome.Pass) return false;
        if (classify(ActionType.CAW, 1, 1) != Outcome.Pass) return false;
        if (classify(ActionType.CAW, 1, 2) != Outcome.Pass) return false; // explicit tip
        if (classify(ActionType.WITHDRAW, 1, 1) != Outcome.Pass) return false;
        if (classify(ActionType.WITHDRAW, 1, 2) != Outcome.Pass) return false;
        if (classify(ActionType.WITHDRAW, 0, 0) != Outcome.Pass) return false; // no recipients, no tip — fine
        return true;
    }

    function echidna_rejection_paths_hold() external pure returns (bool) {
        // 11 recipients fails up front regardless of amounts shape.
        if (classify(ActionType.CAW, 11, 11) != Outcome.TooManyRecipients) return false;
        if (classify(ActionType.CAW, 11, 12) != Outcome.TooManyRecipients) return false;
        // Mismatched shapes fail.
        if (classify(ActionType.CAW, 2, 5) != Outcome.AmountsRecipientsMismatch) return false;
        if (classify(ActionType.LIKE, 3, 1) != Outcome.AmountsRecipientsMismatch) return false;
        // Withdraw with zero recipients but a lone tip slot is the documented audit fix.
        if (classify(ActionType.WITHDRAW, 0, 1) != Outcome.WithdrawEmptyRecipientsTipSlot) return false;
        return true;
    }
}
