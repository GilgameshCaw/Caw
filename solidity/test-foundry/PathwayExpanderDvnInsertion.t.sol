// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/PathwayExpander.sol";

// ---------------------------------------------------------------------------
// addDvnToPathway: the new optional DVN may be inserted at ANY position.
//
// LayerZero's ULN302 libraries only accept DVN arrays in strictly ascending
// address order (UlnBase._assertNoDuplicates: `if (dvn <= lastDVN) revert
// LZ_ULN_Unsorted()`, @layerzerolabs/lz-evm-messagelib-v2 3.0.168,
// contracts/uln/UlnBase.sol L187-194), so a new DVN whose address is below the
// current highest one has to go in the middle. The other escalation tests use
// an endpoint that records the call and checks nothing, and DVN addresses that
// happen to ascend (0x1111 ... 0x5555), so they could not tell.
// ---------------------------------------------------------------------------

/// @dev NOT LayerZero's code: it records setConfig and applies the one check above to the
///      required and the optional DVN arrays, the way SendUln302.setConfig -> _setUlnConfig
///      -> _setConfig does.
contract UlnOrderCheckingEndpoint {
  struct SetConfigParam { uint32 eid; uint32 configType; bytes config; }
  struct UlnConfig {
    uint64    confirmations;
    uint8     requiredDVNCount;
    uint8     optionalDVNCount;
    uint8     optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
  }

  error LZ_ULN_Unsorted();

  uint256 public callCount;

  function setConfig(address, address, SetConfigParam[] calldata params) external {
    UlnConfig memory c = abi.decode(params[0].config, (UlnConfig));
    _assertNoDuplicates(c.requiredDVNs);
    _assertNoDuplicates(c.optionalDVNs);
    callCount++;
  }

  function _assertNoDuplicates(address[] memory dvns) private pure {
    address lastDVN = address(0);
    for (uint256 i = 0; i < dvns.length; i++) {
      address dvn = dvns[i];
      if (dvn <= lastDVN) revert LZ_ULN_Unsorted(); // to ensure no duplicates
      lastDVN = dvn;
    }
  }
}

contract PathwayExpanderDvnInsertion is Test {
  struct UlnConfig {
    uint64    confirmations;
    uint8     requiredDVNCount;
    uint8     optionalDVNCount;
    uint8     optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
  }

  string constant NOT_PLUS_ONE = "PathwayExpander: optionalDVNs not current plus one new DVN";

  PathwayExpander          pe;
  UlnOrderCheckingEndpoint ep;

  address oapp = address(0x0AAA);
  address lib  = address(0xABCDEF);
  uint32  eid  = 30110; // Arbitrum

  // Arbitrum mainnet initial optional DVNs from solidity/scripts/lz-dvn-config.js, in the ascending
  // order that script's .sort() gives them:
  address constant A0 = address(bytes20(hex"19670df5e16bea2ba9b9e68b48c054c5baea06b8")); // Horizen
  address constant A1 = address(bytes20(hex"2f55c492897526677c5b68fb199ea31e2c126416")); // LayerZero Labs
  address constant A2 = address(bytes20(hex"f2e380c90e6c09721297526dbc74f870e114dfcb")); // Canary (the highest)

  // A real provider whose address lies between A1 and A2 (Base's Canary DVN; any address in that range will do).
  address constant MID   = address(bytes20(hex"554833698ae0fb22ecc90b01222903fd62ca4b47"));
  // The only provider LayerZero lists for Arbitrum above A2 (2026-11-26): Bera.
  address constant BERA  = address(bytes20(hex"f2e89ed7e342c708ba8cd79b293ad9244f5fccb3"));
  // Below the lowest.
  address constant FRONT = address(0x0000000000000000000000000000000000001234);

  function setUp() public {
    pe = new PathwayExpander(address(this));
    ep = new UlnOrderCheckingEndpoint();
  }

  // ---- helpers --------------------------------------------------------------

  function _cfg(address[] memory req, address[] memory opt, uint8 threshold) internal pure returns (bytes memory) {
    UlnConfig memory c;
    c.confirmations        = 15;
    c.requiredDVNCount     = uint8(req.length);
    c.optionalDVNCount     = uint8(opt.length);
    c.optionalDVNThreshold = threshold;
    c.requiredDVNs         = req;
    c.optionalDVNs         = opt;
    return abi.encode(c);
  }
  function _none() internal pure returns (address[] memory) { return new address[](0); }
  function _a3(address a, address b, address c) internal pure returns (address[] memory r) { r = new address[](3); r[0]=a; r[1]=b; r[2]=c; }
  function _a4(address a, address b, address c, address d) internal pure returns (address[] memory r) { r = new address[](4); r[0]=a; r[1]=b; r[2]=c; r[3]=d; }
  function _a5(address a, address b, address c, address d, address e) internal pure returns (address[] memory r) { r = new address[](5); r[0]=a; r[1]=b; r[2]=c; r[3]=d; r[4]=e; }

  function _step0() internal pure returns (bytes memory) { return _cfg(_none(), _a3(A0, A1, A2), 2); }
  function _opt4(address a, address b, address c, address d) internal pure returns (bytes memory) { return _cfg(_none(), _a4(a, b, c, d), 3); }
  function _opt5(address a, address b, address c, address d, address e) internal pure returns (bytes memory) { return _cfg(_none(), _a5(a, b, c, d, e), 3); }

  function _configure() internal { pe.configureNewPathway(oapp, address(ep), lib, eid, _step0()); }
  function _add(bytes memory cur, bytes memory nxt) internal { pe.addDvnToPathway(oapp, address(ep), lib, eid, cur, nxt); }
  function _step() internal view returns (uint8) { return pe.dvnEscalationStep(oapp, lib, eid); }

  // ---- the new DVN can go at the front, in the middle, or at the end --------

  function test_insertAtFront_succeeds_andTheEventNamesTheInsertedDvn() public {
    _configure();
    vm.expectEmit(true, true, true, true);
    emit PathwayExpander.DvnEscalated(oapp, lib, eid, 1, 4, 3, FRONT); // FRONT, not the last element A2
    _add(_step0(), _opt4(FRONT, A0, A1, A2));
    assertEq(_step(), 1);
  }

  function test_insertInTheMiddle_realArbitrumAddresses() public {
    _configure();
    // MID is below the current highest (A2): before this change that could not be added at all.
    vm.expectEmit(true, true, true, true);
    emit PathwayExpander.DvnEscalated(oapp, lib, eid, 1, 4, 3, MID);
    _add(_step0(), _opt4(A0, A1, MID, A2));
    assertEq(_step(), 1);
    assertEq(ep.callCount(), 2);
  }

  function test_insertAtTheEnd_stillWorks() public {
    _configure();
    vm.expectEmit(true, true, true, true);
    emit PathwayExpander.DvnEscalated(oapp, lib, eid, 1, 4, 3, BERA);
    _add(_step0(), _opt4(A0, A1, A2, BERA));
    assertEq(_step(), 1);
  }

  function test_twoStepsAtDifferentPositions_thenLocked() public {
    _configure();
    bytes memory step1 = _opt4(FRONT, A0, A1, A2);
    _add(_step0(), step1);

    // second step: in the middle of the now four DVNs
    bytes memory step2 = _opt5(FRONT, A0, A1, MID, A2);
    vm.expectEmit(true, true, true, true);
    emit PathwayExpander.DvnEscalated(oapp, lib, eid, 2, 5, 3, MID);
    _add(step1, step2);
    assertEq(_step(), 2);

    vm.expectRevert("PathwayExpander: escalation locked");
    _add(step2, _cfg(_none(), _a5(FRONT, A0, A1, MID, A2), 3));
  }

  // ---- what is still refused ------------------------------------------------

  // The new DVN is appended although its address is below the highest: PathwayExpander lets it through
  // (ordering is LayerZero's), the endpoint refuses, and the whole call reverts: nothing advances.
  function test_appendThatBreaksAscendingOrder_isRefusedByTheEndpoint() public {
    _configure();
    vm.expectRevert(UlnOrderCheckingEndpoint.LZ_ULN_Unsorted.selector);
    _add(_step0(), _opt4(A0, A1, A2, MID));
    assertEq(_step(), 0);
    assertEq(ep.callCount(), 1);
  }

  function test_reorderingTheExistingDvns_reverts() public {
    _configure();
    vm.expectRevert(bytes(NOT_PLUS_ONE));
    _add(_step0(), _opt4(A1, A0, A2, BERA));
  }

  function test_removingAnExistingDvn_reverts() public {
    _configure();
    // A0 is gone and two new ones are in (the array length is right, the set is not)
    vm.expectRevert(bytes(NOT_PLUS_ONE));
    _add(_step0(), _opt4(A1, A2, MID, BERA));
  }

  function test_replacingAnExistingDvn_reverts() public {
    _configure();
    // A2 is replaced by MID and BERA is added
    vm.expectRevert(bytes(NOT_PLUS_ONE));
    _add(_step0(), _opt4(A0, A1, MID, BERA));
  }

  function test_insertingAnExistingOptionalDvnAgain_reverts() public {
    _configure();
    vm.expectRevert("PathwayExpander: duplicate DVN (optional)");
    _add(_step0(), _opt4(A0, A1, A1, A2));
  }

  function test_insertingARequiredDvnAsOptional_reverts() public {
    address req = address(0xAAAA);
    address[] memory reqs = new address[](1);
    reqs[0] = req;
    bytes memory cur = _cfg(reqs, _a3(A0, A1, A2), 2);
    pe.configureNewPathway(oapp, address(ep), lib, eid, cur);

    vm.expectRevert("PathwayExpander: duplicate DVN (required)");
    _add(cur, _cfg(reqs, _a4(req, A0, A1, A2), 3));
  }

  function test_insertingTheZeroAddress_reverts() public {
    _configure();
    vm.expectRevert("PathwayExpander: zero DVN address");
    _add(_step0(), _opt4(address(0), A0, A1, A2));
  }

  // ---- properties over arbitrary addresses ----------------------------------

  function _sorted3(address a, address b, address c) internal pure returns (address[] memory r) {
    r = _a3(a, b, c);
    if (uint160(r[0]) > uint160(r[1])) (r[0], r[1]) = (r[1], r[0]);
    if (uint160(r[1]) > uint160(r[2])) (r[1], r[2]) = (r[2], r[1]);
    if (uint160(r[0]) > uint160(r[1])) (r[0], r[1]) = (r[1], r[0]);
  }

  function _assumeDistinctNonzero(address a, address b, address c, address d) internal pure {
    vm.assume(a != address(0) && b != address(0) && c != address(0) && d != address(0));
    vm.assume(a != b && a != c && a != d && b != c && b != d && c != d);
  }

  /// @dev `d` placed at `pos` among the three sorted current DVNs.
  function _withNewAt(address[] memory cur, address d, uint256 pos) internal pure returns (address[] memory r) {
    r = new address[](4);
    uint256 j;
    for (uint256 i; i < 4; ++i) r[i] = (i == pos) ? d : cur[j++];
  }

  function _sortedPos(address[] memory cur, address d) internal pure returns (uint256 pos) {
    for (uint256 i; i < cur.length; ++i) if (uint160(cur[i]) < uint160(d)) ++pos;
  }

  /// A new DVN, whatever its address, can always be added at its sorted position, and the event names it.
  function testFuzz_aNewDvnAtItsSortedPositionIsAlwaysAccepted(address a, address b, address c, address d) public {
    _assumeDistinctNonzero(a, b, c, d);
    address[] memory cur = _sorted3(a, b, c);
    bytes memory step0 = _cfg(_none(), cur, 2);
    pe.configureNewPathway(oapp, address(ep), lib, eid, step0);

    vm.expectEmit(true, true, true, true);
    emit PathwayExpander.DvnEscalated(oapp, lib, eid, 1, 4, 3, d);
    _add(step0, _cfg(_none(), _withNewAt(cur, d, _sortedPos(cur, d)), 3));
    assertEq(_step(), 1);
  }

  /// At any other position the endpoint refuses (the array is not ascending) and nothing advances.
  function testFuzz_aNewDvnAtAnyOtherPositionIsRefused(address a, address b, address c, address d, uint8 posSeed) public {
    _assumeDistinctNonzero(a, b, c, d);
    address[] memory cur = _sorted3(a, b, c);
    bytes memory step0 = _cfg(_none(), cur, 2);
    pe.configureNewPathway(oapp, address(ep), lib, eid, step0);

    uint256 pos = posSeed % 4;
    uint256 right = _sortedPos(cur, d);
    vm.assume(pos != right);

    vm.expectRevert(UlnOrderCheckingEndpoint.LZ_ULN_Unsorted.selector);
    _add(step0, _cfg(_none(), _withNewAt(cur, d, pos), 3));
    assertEq(_step(), 0);
  }
}
