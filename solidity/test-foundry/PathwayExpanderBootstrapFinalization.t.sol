// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/PathwayExpander.sol";

contract BootstrapMockOApp {
  address public owner;
  mapping(uint32 => bytes32) public peers;

  constructor(address _owner) {
    owner = _owner;
  }

  function setPeer(uint32 eid, bytes32 peer) external {
    require(msg.sender == owner, "not owner");
    peers[eid] = peer;
  }

  function transferOwnership(address newOwner) external {
    require(msg.sender == owner, "not owner");
    owner = newOwner;
  }

  function renounceOwnership() external {
    require(msg.sender == owner, "not owner");
    owner = address(0);
  }
}

contract PathwayExpanderBootstrapFinalization is Test {
  PathwayExpander pe;
  BootstrapMockOApp oapp;

  function setUp() public {
    pe = new PathwayExpander(address(this));
    oapp = new BootstrapMockOApp(address(pe));
  }

  function test_transferOwnershipIsPermanentlyDisabled() public {
    vm.expectRevert("PathwayExpander: ownership transfer disabled");
    pe.transferOwnership(address(0xBEEF));

    assertEq(pe.owner(), address(this));
  }

  function test_finalizeBootstrapRenouncesOwner() public {
    pe.finalizeBootstrap();

    assertEq(pe.owner(), address(0));

    vm.expectRevert("Ownable: caller is not the owner");
    pe.finalizeBootstrap();
  }

  function test_allPrivilegedSurfacesClosedAfterFinalization() public {
    pe.finalizeBootstrap();

    vm.expectRevert("Ownable: caller is not the owner");
    pe.addPeer(address(oapp), 1, bytes32(uint256(1)));

    address[] memory oapps = new address[](0);
    uint32[] memory eids = new uint32[](0);
    bytes32[] memory peers = new bytes32[](0);

    vm.expectRevert("Ownable: caller is not the owner");
    pe.addPeers(oapps, eids, peers);

    vm.expectRevert("Ownable: caller is not the owner");
    pe.addKycVerifier(address(0), 2, address(0));

    vm.expectRevert("Ownable: caller is not the owner");
    pe.configureNewPathway(
      address(0), address(0), address(0), 1, hex""
    );

    vm.expectRevert("Ownable: caller is not the owner");
    pe.addDvnToPathway(
      address(0), address(0), address(0), 1, hex"", hex""
    );
  }

  function test_finalizationPreservesPeerStateAndOAppOwner() public {
    uint32 eid = 30184;
    bytes32 peer = bytes32(uint256(uint160(address(0x1234))));

    pe.addPeer(address(oapp), eid, peer);

    assertEq(oapp.peers(eid), peer);
    assertEq(oapp.owner(), address(pe));

    pe.finalizeBootstrap();

    assertEq(pe.owner(), address(0));
    assertEq(oapp.owner(), address(pe));
    assertEq(oapp.peers(eid), peer);
  }

  function test_inheritedRenounceOwnershipAlsoClosesBootstrap() public {
    pe.renounceOwnership();

    assertEq(pe.owner(), address(0));

    vm.expectRevert("Ownable: caller is not the owner");
    pe.addPeer(address(oapp), 30184, bytes32(uint256(1)));
  }
}
