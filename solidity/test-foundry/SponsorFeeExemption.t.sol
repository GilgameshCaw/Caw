// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Layer 2 (2026-06-12): authorized-sponsor deposit-fee exemption on
// CawNetworkManager. The Minter flags a mint as deposit-fee-exempt for exactly
// one call when the resolved sponsor is in the network's authorizedSponsors set;
// getDepositFeeAndAddress then returns a 0 deposit fee. CawProfile is untouched
// (it reads the fee through getDepositFeeAndAddress as before).
//
// Security property under test: the exemption is keyed to the network-owner's
// authorized set + the minter-only flag — a self-sponsoring attacker who is not
// authorized pays the normal fee, and only the wired Minter can set the flag.

import "forge-std/Test.sol";
import "../contracts/CawNetworkManager.sol";

contract SponsorFeeExemptionTest is Test {
    CawNetworkManager nm;

    address buyAndBurn = makeAddr("buyAndBurn");
    address feeAddr    = makeAddr("feeAddr");
    address minter     = makeAddr("minter");
    address sponsor    = makeAddr("sponsor");
    address attacker   = makeAddr("attacker");
    uint32  constant STORAGE_EID = 2;
    uint256 constant DEPOSIT_FEE = 1e15; // network's deposit fee (= ceiling at create)

    function setUp() public {
        nm = new CawNetworkManager(buyAndBurn);
        // networkId 1, depositFee = depositFeeCeiling = DEPOSIT_FEE. Owner = this.
        nm.createNetwork("Net", feeAddr, STORAGE_EID, DEPOSIT_FEE, DEPOSIT_FEE, DEPOSIT_FEE, DEPOSIT_FEE, 5e11);
        nm.setMinter(minter);
    }

    function _depositFee(uint32 networkId) internal view returns (uint256 fee, address addr) {
        (fee, addr) = nm.getDepositFeeAndAddress(networkId);
    }

    // ── setMinter wiring ────────────────────────────────────────────────────
    function test_setMinter_isOneShot() public {
        vm.expectRevert("Minter already set");
        nm.setMinter(makeAddr("other"));
    }

    function test_setMinter_onlyDeployer() public {
        CawNetworkManager fresh = new CawNetworkManager(buyAndBurn);
        vm.prank(attacker);
        vm.expectRevert("Not deployer");
        fresh.setMinter(minter);
    }

    // ── authorize set (network-owner gated) ─────────────────────────────────
    function test_addAuthorizedSponsor_onlyNetworkOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Not the owner");
        nm.addAuthorizedSponsor(1, sponsor);
    }

    function test_isAuthorizedSponsor_reflectsAddRemove() public {
        assertFalse(nm.isAuthorizedSponsor(1, sponsor));
        nm.addAuthorizedSponsor(1, sponsor);
        assertTrue(nm.isAuthorizedSponsor(1, sponsor));
        nm.removeAuthorizedSponsor(1, sponsor);
        assertFalse(nm.isAuthorizedSponsor(1, sponsor));
    }

    // ── flag access control (minter-only) ───────────────────────────────────
    function test_flag_onlyMinter() public {
        vm.prank(attacker);
        vm.expectRevert("Not minter");
        nm.flagDepositFeeExempt(1);

        vm.prank(attacker);
        vm.expectRevert("Not minter");
        nm.clearDepositFeeExempt();
    }

    // ── the actual exemption behavior ───────────────────────────────────────
    function test_normalFee_whenNotFlagged() public view {
        (uint256 fee, address addr) = _depositFee(1);
        assertEq(fee, DEPOSIT_FEE, "unflagged: normal deposit fee");
        assertEq(addr, feeAddr);
    }

    function test_zeroFee_whenFlagged() public {
        vm.prank(minter);
        nm.flagDepositFeeExempt(1);
        (uint256 fee, address addr) = _depositFee(1);
        assertEq(fee, 0, "flagged: deposit fee exempt");
        assertEq(addr, feeAddr, "feeAddress still returned");
    }

    function test_flag_isScopedToNetworkId() public {
        // Create a second network; flag #1; #2 must be unaffected.
        nm.createNetwork("Net2", feeAddr, STORAGE_EID, DEPOSIT_FEE, DEPOSIT_FEE, DEPOSIT_FEE, DEPOSIT_FEE, 5e11);
        vm.prank(minter);
        nm.flagDepositFeeExempt(1);
        (uint256 fee1,) = _depositFee(1);
        (uint256 fee2,) = _depositFee(2);
        assertEq(fee1, 0, "flagged network exempt");
        assertEq(fee2, DEPOSIT_FEE, "other network unaffected");
    }

    function test_clear_restoresFee() public {
        vm.prank(minter);
        nm.flagDepositFeeExempt(1);
        vm.prank(minter);
        nm.clearDepositFeeExempt();
        (uint256 fee,) = _depositFee(1);
        assertEq(fee, DEPOSIT_FEE, "cleared: fee restored");
    }

    // The flag is a single transient slot; it does not persist across a
    // set→clear bracket, so a later mint with no flag pays the normal fee.
    // (The Minter brackets it around exactly one mintAndDeposit.)
    function test_flag_doesNotLeakAfterClear() public {
        vm.startPrank(minter);
        nm.flagDepositFeeExempt(1);
        nm.clearDepositFeeExempt();
        vm.stopPrank();
        (uint256 fee,) = _depositFee(1);
        assertEq(fee, DEPOSIT_FEE, "no leak after clear");
    }
}
