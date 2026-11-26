// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// How CawActions / CawActionsERC1271 account for the native value of a processing call:
//   - the withdraw fee is paid out of msg.value only (an underfunded call reverts, the balance
//     of the contract is never spent);
//   - whatever is not spent (everything, when no WITHDRAW executed) is returned to the caller.

import "./harness/WithdrawValueHarness.sol";

/// @dev A contract caller that cannot receive ETH.
contract NoReceiveCaller {
    function go(CawActions a, bytes calldata packed, bytes calldata sigs, uint256 fee) external payable {
        a.processActions{value: msg.value}(99, packed, sigs, fee, 0);
    }
}

/// @dev A contract caller whose receive() re-enters processActions with a second, fresh WITHDRAW.
contract ReentrantCaller {
    CawActions a; bytes packed2; bytes sigs2; uint256 fee2; bool done;
    constructor(CawActions _a) { a = _a; }
    function arm(bytes memory p, bytes memory s, uint256 f) external { packed2 = p; sigs2 = s; fee2 = f; }
    function go(bytes calldata packed, bytes calldata sigs, uint256 fee) external payable {
        a.processActions{value: msg.value}(99, packed, sigs, fee, 0);
    }
    receive() external payable {
        if (done) return;
        done = true;
        a.processActions{value: fee2}(99, packed2, sigs2, fee2, 0);
    }
}

contract CawActionsWithdrawValueTest is WithdrawValueHarness {

    // ---- CawActions.processActions ----

    function test_exactValue_isSpentAndNothingIsReturned() public {
        _deploy(false);
        _send(validatorEoa, FEE, _packed(6, TOKEN_A, 1, 10), _sigs(6, TOKEN_A, 1, 10, true), FEE);
        assertEq(ep.sends(), 1);
        assertEq(address(actions).balance, 0);
        assertEq(validatorEoa.balance, 0);
    }

    function test_overpay_isReturnedToTheCaller() public {
        _deploy(false);
        _send(validatorEoa, FEE + 0.5 ether, _packed(6, TOKEN_A, 1, 10), _sigs(6, TOKEN_A, 1, 10, true), FEE);
        assertEq(ep.sends(), 1);
        assertEq(address(actions).balance, 0);
        assertEq(validatorEoa.balance, 0.5 ether);
    }

    function test_underfunded_reverts() public {
        _deploy(false);
        bytes memory packed = _packed(6, TOKEN_A, 1, 10);
        bytes memory sigs = _sigs(6, TOKEN_A, 1, 10, true);
        vm.deal(validatorEoa, FEE);
        vm.prank(validatorEoa, validatorEoa);
        vm.expectRevert(CawActions.WithdrawFeeNotFunded.selector);
        actions.processActions{value: FEE - 1}(VALIDATOR_ID, packed, sigs, FEE, 0);
    }

    /// ETH that is already in the contract (left by calls made before this change) is not spendable as a fee.
    function test_leftoverInTheContractIsNotSpendable() public {
        _deploy(false);
        vm.deal(address(actions), 0.5 ether);
        bytes memory packed = _packed(6, TOKEN_A, 1, 10);
        bytes memory sigs = _sigs(6, TOKEN_A, 1, 10, true);
        vm.prank(thief, thief);
        vm.expectRevert(CawActions.WithdrawFeeNotFunded.selector);
        actions.processActions(VALIDATOR_ID, packed, sigs, 0.5 ether, 0);
        assertEq(address(actions).balance, 0.5 ether);
        assertEq(thief.balance, 0);
    }

    function test_valueWithoutAnyWithdraw_isReturned() public {
        _deploy(false);
        _send(validatorEoa, 0.1 ether, _packed(5, TOKEN_A, 1, 0), _sigs(5, TOKEN_A, 1, 0, true), 0);
        assertEq(address(actions).balance, 0);
        assertEq(validatorEoa.balance, 0.1 ether);
    }

    function test_bypassLz_valueIsReturned() public {
        _deploy(true);
        _send(validatorEoa, 1 ether, _packed(6, TOKEN_A, 1, 10), _sigs(6, TOKEN_A, 1, 10, true), 0);
        assertEq(setWithdrawableCalls, 1);
        assertEq(address(actions).balance, 0);
        assertEq(validatorEoa.balance, 1 ether);
    }

    function test_noFeeStillReverts_inLzMode() public {
        _deploy(false);
        bytes memory packed = _packed(6, TOKEN_A, 1, 10);
        bytes memory sigs = _sigs(6, TOKEN_A, 1, 10, true);
        vm.prank(validatorEoa, validatorEoa);
        vm.expectRevert(CawActions.NoWithdrawFee.selector);
        actions.processActions(VALIDATOR_ID, packed, sigs, 0, 0);
    }

    function test_contractCallerThatCannotReceive_revertsOnASurplus_andWorksWithExactValue() public {
        _deploy(false);
        NoReceiveCaller c = new NoReceiveCaller();
        vm.deal(address(this), 10 ether);
        bytes memory packed = _packed(6, TOKEN_A, 1, 10);
        bytes memory sigs = _sigs(6, TOKEN_A, 1, 10, true);
        vm.expectRevert(CawActions.RefundFailed.selector);
        c.go{value: FEE + 1}(actions, packed, sigs, FEE);
        c.go{value: FEE}(actions, packed, sigs, FEE);
        assertEq(ep.sends(), 1);
        assertEq(address(actions).balance, 0);
    }

    /// The refund is the last step, so a receiver that re-enters with another batch sees finished state.
    function test_refundReceiverThatReentersWithAnotherBatch() public {
        _deploy(false);
        ReentrantCaller c = new ReentrantCaller(actions);
        c.arm(_packed(6, TOKEN_A, 2, 10), _sigs(6, TOKEN_A, 2, 10, true), FEE);
        vm.deal(address(c), FEE);                      // what the re-entering call spends
        vm.deal(address(this), 1 ether);
        c.go{value: FEE + 1000}(_packed(6, TOKEN_A, 1, 10), _sigs(6, TOKEN_A, 1, 10, true), FEE);
        assertEq(ep.sends(), 2, "both WITHDRAWs went out");
        assertEq(address(actions).balance, 0);
        assertEq(address(c).balance, 1000, "only the surplus of the first call is left with the caller");
    }

    // ---- CawActions.processActionsWithZkSigs ----

    function test_zk_raceLostWithdraw_valueIsReturned_andTheBatchStillSucceeds() public {
        _deploy(false);
        _send(thief, FEE, _packed(6, TOKEN_A, 1, 10), _sigs(6, TOKEN_A, 1, 10, true), FEE); // another validator wins
        bytes memory packed = _packed(6, TOKEN_A, 1, 10);
        bytes memory sigs   = _sigs(6, TOKEN_A, 1, 10, true);
        vm.deal(validatorEoa, FEE);
        vm.prank(validatorEoa, validatorEoa);
        actions.processActionsWithZkSigs{value: FEE}(VALIDATOR_ID, packed, sigs, abi.encodePacked(owner), hex"00", FEE, 0);
        assertEq(ep.sends(), 1);
        assertEq(address(actions).balance, 0);
        assertEq(validatorEoa.balance, FEE);
    }

    function test_zk_executedWithdraw_isFundedFromTheCall() public {
        _deploy(false);
        bytes memory packed = _packed(6, TOKEN_A, 1, 10);
        bytes memory sigs   = _sigs(6, TOKEN_A, 1, 10, true);
        vm.deal(validatorEoa, FEE);
        vm.prank(validatorEoa, validatorEoa);
        actions.processActionsWithZkSigs{value: FEE}(VALIDATOR_ID, packed, sigs, abi.encodePacked(owner), hex"00", FEE, 0);
        assertEq(ep.sends(), 1);
        assertEq(address(actions).balance, 0);
        // a second WITHDRAW with no value: the helpers below make external calls, so build the arguments first
        bytes memory packed2 = _packed(6, TOKEN_A, 2, 10);
        bytes memory sigs2   = _sigs(6, TOKEN_A, 2, 10, true);
        vm.prank(validatorEoa, validatorEoa);
        vm.expectRevert(CawActions.WithdrawFeeNotFunded.selector);
        actions.processActionsWithZkSigs(VALIDATOR_ID, packed2, sigs2, abi.encodePacked(owner), hex"00", FEE, 0);
    }

    // ---- CawActions.safeProcessActions ----

    function test_safe_rejectedWithdraw_valueIsReturned() public {
        _deploy(false);
        bytes memory packed = _packed(6, TOKEN_A, 1, 10);
        bytes memory sigs = _sigs(6, TOKEN_A, 1, 10, false);
        vm.deal(validatorEoa, FEE);
        vm.prank(validatorEoa, validatorEoa);
        (uint256 ok, ) = actions.safeProcessActions{value: FEE}(VALIDATOR_ID, packed, sigs, FEE, 0);
        assertEq(ok, 0);
        assertEq(ep.sends(), 0);
        assertEq(address(actions).balance, 0);
        assertEq(validatorEoa.balance, FEE);
    }

    function test_safe_executedWithdraw_spendsTheFeeAndReturnsTheSurplus() public {
        _deploy(false);
        bytes memory packed = _packed(6, TOKEN_A, 1, 10);
        bytes memory sigs = _sigs(6, TOKEN_A, 1, 10, true);
        vm.deal(validatorEoa, FEE + 7);
        vm.prank(validatorEoa, validatorEoa);
        (uint256 ok, ) = actions.safeProcessActions{value: FEE + 7}(VALIDATOR_ID, packed, sigs, FEE, 0);
        assertEq(ok, 1);
        assertEq(ep.sends(), 1);
        assertEq(address(actions).balance, 0);
        assertEq(validatorEoa.balance, 7);
    }

    // ---- CawActionsERC1271.processActionsERC1271 ----

    function test_erc1271_overpay_isReturnedToTheCaller() public {
        _deploy(false);
        _erc1271(validatorEoa, FEE + 0.5 ether, 1, FEE);
        assertEq(ep.sends(), 1);
        assertEq(address(sibling).balance, 0);
        assertEq(validatorEoa.balance, 0.5 ether);
    }

    function test_erc1271_underfunded_reverts() public {
        _deploy(false);
        vm.expectRevert(bytes("withdrawFee not funded"));
        this._erc1271External(validatorEoa, FEE - 1, 1, FEE);
    }

    function test_erc1271_leftoverInTheContractIsNotSpendable() public {
        _deploy(false);
        vm.deal(address(sibling), 0.5 ether);
        vm.expectRevert(bytes("withdrawFee not funded"));
        this._erc1271External(thief, 0, 1, 0.5 ether);
        assertEq(address(sibling).balance, 0.5 ether);
    }

    function test_erc1271_valueWithoutWithdraw_isReturned() public {
        _deploy(false);
        bytes memory packed = abi.encodePacked(uint16(1), _action(5, TOKEN_W, 1, 0));
        bytes[] memory sigs = new bytes[](1); sigs[0] = hex"01";
        bytes32[] memory rs = new bytes32[](1); rs[0] = keccak256(sigs[0]);
        vm.deal(validatorEoa, 0.1 ether);
        vm.prank(validatorEoa, validatorEoa);
        sibling.processActionsERC1271{value: 0.1 ether}(VALIDATOR_ID, packed, sigs, rs, 0, 0);
        assertEq(address(sibling).balance, 0);
        assertEq(validatorEoa.balance, 0.1 ether);
    }

    /// external wrapper so vm.expectRevert sees the revert of the inner call
    function _erc1271External(address caller, uint256 value, uint32 cawonce, uint256 fee) external {
        _erc1271(caller, value, cawonce, fee);
    }
}
