// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/PathwayExpander.sol";

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

/// @dev Bare OApp stub: supports owner() and peers().
contract MockOApp {
  address public owner;
  mapping(uint32 => bytes32) public peers;

  constructor(address _owner) { owner = _owner; }

  function setPeer(uint32 eid, bytes32 peer) external {
    require(msg.sender == owner, "not owner");
    peers[eid] = peer;
  }

  function transferOwnership(address newOwner) external {
    require(msg.sender == owner, "not owner");
    owner = newOwner;
  }
}

/// @dev Records the last setConfig call for assertion.
contract MockEndpoint {
  struct SetConfigParam {
    uint32  eid;
    uint32  configType;
    bytes   config;
  }

  address public lastOapp;
  address public lastLib;
  bytes   public lastConfig;
  uint256 public callCount;

  function setConfig(
    address oapp,
    address lib,
    SetConfigParam[] calldata params
  ) external {
    lastOapp   = oapp;
    lastLib    = lib;
    lastConfig = params[0].config;
    callCount++;
  }
}

// ---------------------------------------------------------------------------
// Test contract
// ---------------------------------------------------------------------------

contract PathwayExpanderEscalation is Test {
  // UlnConfig struct mirrors the one in PathwayExpander.sol
  struct UlnConfig {
    uint64    confirmations;
    uint8     requiredDVNCount;
    uint8     optionalDVNCount;
    uint8     optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
  }

  PathwayExpander pe;
  MockOApp        oapp;
  MockEndpoint    ep;

  address lib     = address(0xABCDEF);
  uint32  eid     = 30101;
  address owner   = address(this);
  address nonOwner = address(0xDEAD);

  address dvn1 = address(0x1111);
  address dvn2 = address(0x2222);
  address dvn3 = address(0x3333);
  address dvn4 = address(0x4444);
  address dvn5 = address(0x5555);
  address req1 = address(0xAAAA);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function _makeConfig(
    uint64 confirmations,
    address[] memory reqDvns,
    address[] memory optDvns,
    uint8 threshold
  ) internal pure returns (bytes memory) {
    UlnConfig memory cfg;
    cfg.confirmations        = confirmations;
    cfg.requiredDVNCount     = uint8(reqDvns.length);
    cfg.optionalDVNCount     = uint8(optDvns.length);
    cfg.optionalDVNThreshold = threshold;
    cfg.requiredDVNs         = reqDvns;
    cfg.optionalDVNs         = optDvns;
    return abi.encode(cfg);
  }

  // Returns the canonical step-0 config: 3 optional DVNs, threshold 2.
  function _step0Config() internal view returns (bytes memory) {
    address[] memory req = new address[](0);
    address[] memory opt = new address[](3);
    opt[0] = dvn1; opt[1] = dvn2; opt[2] = dvn3;
    return _makeConfig(15, req, opt, 2);
  }

  // Returns step-1 config: 4 optional DVNs, threshold 3.
  function _step1Config() internal view returns (bytes memory) {
    address[] memory req = new address[](0);
    address[] memory opt = new address[](4);
    opt[0] = dvn1; opt[1] = dvn2; opt[2] = dvn3; opt[3] = dvn4;
    return _makeConfig(15, req, opt, 3);
  }

  // Returns step-2 config: 5 optional DVNs, threshold 3.
  function _step2Config() internal view returns (bytes memory) {
    address[] memory req = new address[](0);
    address[] memory opt = new address[](5);
    opt[0] = dvn1; opt[1] = dvn2; opt[2] = dvn3; opt[3] = dvn4; opt[4] = dvn5;
    return _makeConfig(15, req, opt, 3);
  }

  function _setupConfiguredPathway() internal {
    pe.configureNewPathway(address(oapp), address(ep), lib, eid, _step0Config());
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  function setUp() public {
    pe   = new PathwayExpander(address(this));
    oapp = new MockOApp(address(pe));
    ep   = new MockEndpoint();
  }

  // ---------------------------------------------------------------------------
  // Test 1: happy path — full 2-step escalation
  // ---------------------------------------------------------------------------

  function test_happyPath_fullEscalation() public {
    _setupConfiguredPathway();
    assertEq(pe.dvnEscalationStep(address(oapp), lib, eid), 0);

    // Step 0 → 1
    vm.expectEmit(true, true, true, true);
    emit PathwayExpander.DvnEscalated(address(oapp), lib, eid, 1, 4, 3, dvn4);
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step0Config(), _step1Config());

    assertEq(pe.dvnEscalationStep(address(oapp), lib, eid), 1);
    // configureNewPathway calls setConfig once, then each escalate adds one.
    assertEq(ep.callCount(), 2);

    // Step 1 → 2
    vm.expectEmit(true, true, true, true);
    emit PathwayExpander.DvnEscalated(address(oapp), lib, eid, 2, 5, 3, dvn5);
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step1Config(), _step2Config());

    assertEq(pe.dvnEscalationStep(address(oapp), lib, eid), 2);
    assertEq(ep.callCount(), 3);
  }

  // ---------------------------------------------------------------------------
  // Test 2: skip step rejected (0 → 2 in one call)
  // ---------------------------------------------------------------------------

  function test_skipStepRejected() public {
    _setupConfiguredPathway();

    vm.expectRevert("PathwayExpander: wrong optionalDVNCount");
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step0Config(), _step2Config());
  }

  // ---------------------------------------------------------------------------
  // Test 3: locked after step 2
  // ---------------------------------------------------------------------------

  function test_lockedAfterStep2() public {
    _setupConfiguredPathway();
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step0Config(), _step1Config());
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step1Config(), _step2Config());

    vm.expectRevert("PathwayExpander: escalation locked");
    // Even a valid-looking +1 step would be rejected:
    address[] memory req = new address[](0);
    address[] memory opt = new address[](6);
    opt[0] = dvn1; opt[1] = dvn2; opt[2] = dvn3; opt[3] = dvn4; opt[4] = dvn5; opt[5] = address(0x6666);
    bytes memory bogus = _makeConfig(15, req, opt, 3);
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step2Config(), bogus);
  }

  // ---------------------------------------------------------------------------
  // Test 4: wrong current hash (replay protection)
  // ---------------------------------------------------------------------------

  function test_wrongCurrentHash() public {
    _setupConfiguredPathway();

    // Supply step1Config as the "current" instead of step0Config
    vm.expectRevert("PathwayExpander: current config hash mismatch");
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step1Config(), _step1Config());
  }

  // ---------------------------------------------------------------------------
  // Test 5: required DVN tamper
  // ---------------------------------------------------------------------------

  function test_requiredDvnTamper() public {
    // Set up with a required DVN present
    address[] memory req = new address[](1);
    req[0] = req1;
    address[] memory opt = new address[](3);
    opt[0] = dvn1; opt[1] = dvn2; opt[2] = dvn3;
    bytes memory curCfg = _makeConfig(15, req, opt, 2);
    pe.configureNewPathway(address(oapp), address(ep), lib, eid, curCfg);

    // New config swaps the required DVN
    address[] memory req2 = new address[](1);
    req2[0] = address(0x9999); // tampered
    address[] memory opt2 = new address[](4);
    opt2[0] = dvn1; opt2[1] = dvn2; opt2[2] = dvn3; opt2[3] = dvn4;
    bytes memory newCfg = _makeConfig(15, req2, opt2, 3);

    vm.expectRevert("PathwayExpander: requiredDVNs changed");
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, curCfg, newCfg);
  }

  // ---------------------------------------------------------------------------
  // Test 6: threshold tamper (step 0→1 must raise to 3, not stay at 2)
  // ---------------------------------------------------------------------------

  function test_thresholdTamper() public {
    _setupConfiguredPathway();

    address[] memory req = new address[](0);
    address[] memory opt = new address[](4);
    opt[0] = dvn1; opt[1] = dvn2; opt[2] = dvn3; opt[3] = dvn4;
    bytes memory wrongThreshold = _makeConfig(15, req, opt, 2); // threshold should be 3

    vm.expectRevert("PathwayExpander: wrong optionalDVNThreshold");
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step0Config(), wrongThreshold);
  }

  // ---------------------------------------------------------------------------
  // Test 7: prefix reorder
  // ---------------------------------------------------------------------------

  function test_prefixReorder() public {
    _setupConfiguredPathway();

    address[] memory req = new address[](0);
    address[] memory opt = new address[](4);
    // Swap dvn1 and dvn2 in prefix
    opt[0] = dvn2; opt[1] = dvn1; opt[2] = dvn3; opt[3] = dvn4;
    bytes memory reordered = _makeConfig(15, req, opt, 3);

    vm.expectRevert("PathwayExpander: optionalDVNs prefix reordered");
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step0Config(), reordered);
  }

  // ---------------------------------------------------------------------------
  // Test 8: duplicate append (new DVN equals an existing optional DVN)
  // ---------------------------------------------------------------------------

  function test_duplicateAppend_optional() public {
    _setupConfiguredPathway();

    address[] memory req = new address[](0);
    address[] memory opt = new address[](4);
    opt[0] = dvn1; opt[1] = dvn2; opt[2] = dvn3; opt[3] = dvn2; // dvn2 already in prefix
    bytes memory dupConfig = _makeConfig(15, req, opt, 3);

    vm.expectRevert("PathwayExpander: duplicate DVN (optional)");
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step0Config(), dupConfig);
  }

  function test_duplicateAppend_required() public {
    // Set up with a required DVN
    address[] memory req = new address[](1);
    req[0] = req1;
    address[] memory opt = new address[](3);
    opt[0] = dvn1; opt[1] = dvn2; opt[2] = dvn3;
    bytes memory curCfg = _makeConfig(15, req, opt, 2);
    pe.configureNewPathway(address(oapp), address(ep), lib, eid, curCfg);

    // Try appending req1 as the new optional DVN
    address[] memory opt2 = new address[](4);
    opt2[0] = dvn1; opt2[1] = dvn2; opt2[2] = dvn3; opt2[3] = req1;
    bytes memory dupConfig = _makeConfig(15, req, opt2, 3);

    vm.expectRevert("PathwayExpander: duplicate DVN (required)");
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, curCfg, dupConfig);
  }

  // ---------------------------------------------------------------------------
  // Test 9: non-owner reverts
  // ---------------------------------------------------------------------------

  function test_nonOwnerReverts() public {
    _setupConfiguredPathway();

    vm.prank(nonOwner);
    vm.expectRevert();
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step0Config(), _step1Config());
  }

  // ---------------------------------------------------------------------------
  // Test 10: pathway not configured yet
  // ---------------------------------------------------------------------------

  function test_pathwayNotConfigured() public {
    // Do NOT call configureNewPathway
    vm.expectRevert("PathwayExpander: pathway not configured");
    pe.addDvnToPathway(address(oapp), address(ep), lib, eid, _step0Config(), _step1Config());
  }
}
