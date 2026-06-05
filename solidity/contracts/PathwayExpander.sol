// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal interface to the OApp surface we need.
interface IOAppOwner {
  function owner() external view returns (address);
  function transferOwnership(address newOwner) external;
  function renounceOwnership() external;
  function peers(uint32 eid) external view returns (bytes32);
  function setPeer(uint32 eid, bytes32 peer) external;
}

/// @notice Minimal interface to CawProfileMinter's additions-only KYC slot.
interface IKycRegistrar {
  function addKycVerifier(uint8 level, address verifier) external;
}

/// @notice Minimal interface to the LZ EndpointV2 config surface.
/// @dev    We only use setConfig/getConfig here. The full endpoint ABI is not
///         imported to keep PathwayExpander lean and dependency-free.
interface ILzEndpoint {
  struct SetConfigParam {
    uint32 eid;
    uint32 configType;
    bytes config;
  }
  function setConfig(address _oapp, address _lib, SetConfigParam[] calldata _params) external;
}

/// @title PathwayExpander
/// @notice Becomes the owner AND LZ delegate of every CAW OApp (CawProfile,
///         CawProfileLedger, CawActionsArchive, CawChallengeRelay) so that
///         the deployer EOA can renounce its direct authority over them while
///         still leaving the door open for TWO specific operations: adding
///         peers for new eids, and configuring DVN/ULN settings for NEW
///         (oapp, eid) pathways.
///
///         The original CAW OApps already gate setPeer per-eid via
///         OnlyOnce, so existing peers can never be reconfigured. This
///         contract reinforces that with its own check (peers[eid] == 0
///         required) — defense in depth.
///
///         For DVN config, PathwayExpander maintains its own
///         `_pathwayConfigured` bitmap so that existing pathway configs
///         can never be overwritten — additions-only. A compromised
///         expander key can add malicious DVN config for NEW pathways
///         but cannot rewrite existing ones. Same compromise profile as
///         addPeer.
///
///         There is no path to:
///           - reconfigure existing peers,
///           - rewrite existing DVN configs,
///           - call any other OnlyOwner function on the underlying OApp,
///           - transfer the OApp's ownership to anything else.
///         If a future protocol wants any of those, it has to deploy a
///         new PathwayExpander variant and migrate ownership *before*
///         this one is renounced.
///
/// @dev Trust profile: this contract has its own owner (the deployer or
///      whatever address it's transferred to). The owner can call
///      addPeer / configureNewPathway to bring up new pathways. The owner
///      CANNOT pull ownership of the underlying OApps back out — there is
///      no "transferOApp" function. This is intentional: the upstream
///      OApps' OnlyOnce per-eid guards are what make existing pathways
///      immutable, and this contract preserves that property.
///
///      The owner CAN renounceOwnership() on this contract, which
///      neutralizes the additions-only path entirely (no new chains
///      ever again, but all existing pathways keep working).
contract PathwayExpander is Ownable {
  // ULN config type id — LZ V2 standard (CONFIG_TYPE_EXECUTOR=1, CONFIG_TYPE_ULN=2).
  uint32 public constant CONFIG_TYPE_ULN = 2;

  /// @dev Tracks which (oapp, lib, eid) DVN configs have already been set via
  ///      configureNewPathway. The check uses a nested mapping rather than
  ///      endpoint.getConfig because getConfig merges OApp-specific config with
  ///      endpoint defaults and always returns non-empty bytes — making it
  ///      useless as an "is this freshly configured?" sentinel.
  mapping(address => mapping(address => mapping(uint32 => bool))) private _pathwayConfigured;

  event PeerAdded(address indexed oapp, uint32 indexed eid, bytes32 peer);
  event KycVerifierAdded(address indexed minter, uint8 indexed level, address indexed verifier);
  event PathwayConfigured(address indexed oapp, address indexed lib, uint32 indexed eid, bytes config);

  constructor(address _owner) {
    require(_owner != address(0), "PathwayExpander: zero address");
    _transferOwnership(_owner);
  }

  /// @notice Add a peer for a new eid on an OApp this contract owns.
  /// @dev    Reverts if the eid already has a peer set on the OApp,
  ///         which means existing pathways are unmovable. Also reverts
  ///         if this contract isn't the OApp's owner — early failure
  ///         is friendlier than letting the call dispatch into the
  ///         OApp and revert there with onlyOwner.
  /// @param  oapp The OApp contract whose peer table we're extending.
  /// @param  eid  The new LayerZero eid to register.
  /// @param  peer The peer address (bytes32-encoded for non-EVM compat).
  function addPeer(address oapp, uint32 eid, bytes32 peer) external onlyOwner {
    _addPeer(oapp, eid, peer);
  }

  /// @notice Convenience batch wrapper. Same per-call semantics as addPeer.
  function addPeers(
    address[] calldata oapps,
    uint32[] calldata eids,
    bytes32[] calldata peers
  ) external onlyOwner {
    uint256 n = oapps.length;
    require(n == eids.length && n == peers.length, "PathwayExpander: length mismatch");
    for (uint256 i; i < n; ++i) {
      _addPeer(oapps[i], eids[i], peers[i]);
    }
  }

  function _addPeer(address oapp, uint32 eid, bytes32 peer) internal {
    require(oapp != address(0), "PathwayExpander: zero address");
    require(peer != bytes32(0), "PathwayExpander: zero peer");

    IOAppOwner o = IOAppOwner(oapp);
    require(o.owner() == address(this), "PathwayExpander: not OApp owner");

    require(o.peers(eid) == bytes32(0), "PathwayExpander: peer already set");

    o.setPeer(eid, peer);
    emit PeerAdded(oapp, eid, peer);
  }

  /// @notice Register a new KYC verifier level on a CawProfileMinter that
  ///         points its `pathwayExpander` slot at this contract. Forwards
  ///         to Minter.addKycVerifier; the Minter itself enforces the
  ///         additions-only rule (existing levels can't be rewritten).
  /// @dev    Same trust profile as addPeer — a compromised expander key
  ///         can grow the KYC surface but cannot redirect an existing
  ///         level. To rotate an existing adapter, redeploy the Minter
  ///         (and CawProfile, since CawProfile.minter is immutable).
  function addKycVerifier(address minter, uint8 level, address verifier) external onlyOwner {
    require(minter != address(0), "PathwayExpander: zero address");
    require(verifier != address(0), "PathwayExpander: zero verifier");
    IKycRegistrar(minter).addKycVerifier(level, verifier);
    emit KycVerifierAdded(minter, level, verifier);
  }

  /// @notice Set the ULN (DVN) config for a NEW (oapp, lib, eid) pathway.
  ///         Reverts if this (oapp, lib, eid) triple has already been configured
  ///         via this function — additions-only. A compromised expander key can
  ///         add malicious DVN config for NEW pathways but cannot rewrite
  ///         existing ones. Same compromise profile as addPeer.
  ///
  /// @dev    Caller supplies the lib address (sendUln302 or receiveUln302) and
  ///         the pre-encoded ULN config bytes (ABI-encoded UlnConfig struct,
  ///         matching what endpoint.setConfig expects for CONFIG_TYPE_ULN).
  ///
  /// @dev    WHY NOT use endpoint.getConfig as the "already configured" check?
  ///         Because endpoint.getConfig delegates to the message lib's getConfig
  ///         which merges the OApp-specific config with the endpoint's default
  ///         ULN config. For any supported eid the merged result is always
  ///         non-empty — making it useless as a "freshly unconfigured" sentinel.
  ///         We track state locally instead.
  ///
  /// @param oapp         The OApp whose DVN config is being set.
  /// @param endpointAddr The LZ EndpointV2 address on this chain.
  /// @param lib          The send or receive ULN302 library address.
  /// @param eid          The remote LZ eid this config applies to.
  /// @param ulnConfig    ABI-encoded UlnConfig (the `config` field of SetConfigParam).
  function configureNewPathway(
    address oapp,
    address endpointAddr,
    address lib,
    uint32  eid,
    bytes calldata ulnConfig
  ) external onlyOwner {
    require(oapp         != address(0), "PathwayExpander: zero oapp");
    require(endpointAddr != address(0), "PathwayExpander: zero endpoint");
    require(lib          != address(0), "PathwayExpander: zero lib");
    require(ulnConfig.length > 0,       "PathwayExpander: empty config");

    require(
      !_pathwayConfigured[oapp][lib][eid],
      "PathwayExpander: pathway already configured"
    );

    // Mark before the external call (CEI pattern).
    _pathwayConfigured[oapp][lib][eid] = true;

    ILzEndpoint.SetConfigParam[] memory params = new ILzEndpoint.SetConfigParam[](1);
    params[0] = ILzEndpoint.SetConfigParam({ eid: eid, configType: CONFIG_TYPE_ULN, config: ulnConfig });
    ILzEndpoint(endpointAddr).setConfig(oapp, lib, params);

    emit PathwayConfigured(oapp, lib, eid, ulnConfig);
  }

  /// @notice Returns true if configureNewPathway has already been called for
  ///         this (oapp, lib, eid) triple. Read by deploy tooling to decide
  ///         whether to skip an already-applied config step.
  function isPathwayConfigured(address oapp, address lib, uint32 eid) external view returns (bool) {
    return _pathwayConfigured[oapp][lib][eid];
  }
}
