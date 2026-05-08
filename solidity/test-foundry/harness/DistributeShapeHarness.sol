// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Mirrors the SHAPE-GATE checks at the top of
///         CawActions._distributeAmountsMem (the path that runs *before* any
///         external state mutation).
///
///         Pulling the gate into a standalone contract lets us fuzz it
///         exhaustively — and any tweak to the production shape rules has to
///         be mirrored here, otherwise the documented audit fix (H-2,
///         2026-05-08) drifts.
///
/// @dev Production path being mirrored, in order:
///        require(numRecipients <= 10);
///        bool hasExplicitTip = numAmounts == numRecipients + 1;
///        if (numAmounts != numRecipients && !hasExplicitTip) revert;
///        bool isWithdrawal = action.actionType == WITHDRAW;
///        require(!(isWithdrawal && numRecipients == 0 && hasExplicitTip), ...);
///
///      Anything outside those gates falls through to the recipient loop
///      (return path). We model a 4th outcome — "validation passed" — so the
///      fuzz can assert the rejection categories are exhaustive.
contract DistributeShapeHarness {
    /// @dev Match CawActions.ActionType enum.
    enum ActionType { CAW, LIKE, UNLIKE, RECAW, FOLLOW, UNFOLLOW, WITHDRAW, OTHER }

    enum Outcome {
        TooManyRecipients,
        AmountsRecipientsMismatch,
        WithdrawEmptyRecipientsTipSlot,
        Pass
    }

    /// @notice Pure decision function — returns the same Outcome the real gate
    ///         path would take. Add nothing here that the real path doesn't
    ///         do; that's the whole point.
    function classify(ActionType actionType, uint256 numRecipients, uint256 numAmounts)
        external
        pure
        returns (Outcome)
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
}
