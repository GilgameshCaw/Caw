// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// H-1 audit fix 2026-05-23: regression tests for the feeAddress != buyAndBurn
// guard in CawNetworkManager.createNetwork and CawNetworkManager.setFeeAddress.
//
// If feeAddress == buyAndBurn, payFee credits buyAndBurn twice per fee event
// and _withdrawFees underflows when subtracting protocolAmount from the already-
// zeroed slot — fees permanently locked.

import "forge-std/Test.sol";
import "../contracts/CawNetworkManager.sol";

contract NetworkManagerFeeGuardTest is Test {
    CawNetworkManager networkManager;

    address buyAndBurn;
    address feeAddr;
    uint32  constant STORAGE_EID = 2;

    function setUp() public {
        buyAndBurn = makeAddr("buyAndBurn");
        feeAddr    = makeAddr("feeAddr");
        networkManager = new CawNetworkManager(buyAndBurn);
    }

    // -------------------------------------------------------------------------
    // createNetwork guard
    // -------------------------------------------------------------------------

    function test_createNetwork_revertsWhenFeeAddressIsBuyAndBurn() public {
        vm.expectRevert("Fee address is buyAndBurn");
        networkManager.createNetwork("BadNet", buyAndBurn, STORAGE_EID, 0, 0, 0, 0);
    }

    function test_createNetwork_succeedsWithLegitFeeAddress() public {
        networkManager.createNetwork("GoodNet", feeAddr, STORAGE_EID, 0, 0, 0, 0);
        assertEq(networkManager.getNetwork(1).feeAddress, feeAddr);
    }

    // -------------------------------------------------------------------------
    // setFeeAddress guard
    // -------------------------------------------------------------------------

    function test_setFeeAddress_revertsWhenFeeAddressIsBuyAndBurn() public {
        networkManager.createNetwork("Net", feeAddr, STORAGE_EID, 0, 0, 0, 0);
        vm.expectRevert("Fee address is buyAndBurn");
        networkManager.setFeeAddress(1, buyAndBurn);
    }

    function test_setFeeAddress_succeedsWithLegitFeeAddress() public {
        networkManager.createNetwork("Net", feeAddr, STORAGE_EID, 0, 0, 0, 0);
        address newFee = makeAddr("newFee");
        networkManager.setFeeAddress(1, newFee);
        assertEq(networkManager.getNetwork(1).feeAddress, newFee);
    }
}
