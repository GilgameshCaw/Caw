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

  // ----- escalation state (appended; never reorder) -----

  /// @dev 0 = initial 2-of-3, 1 = bumped to 3-of-4, 2 = bumped to 3-of-5, 3+ = LOCKED.
  ///      Pathway must already exist (_pathwayConfigured must be true) before
  ///      addDvnToPathway can be called.
  mapping(address => mapping(address => mapping(uint32 => uint8))) private _dvnEscalationStep;

  /// @dev keccak256 of the most recently applied ulnConfig bytes for this pathway.
  ///      Set by configureNewPathway and updated by addDvnToPathway. Used as a
  ///      replay-protection snapshot so the caller can't supply a stale "current"
  ///      config to rewind the escalation schedule.
  mapping(address => mapping(address => mapping(uint32 => bytes32))) private _ulnConfigHash;

  /// @dev Mirrors the LZ V2 UlnConfig ABI layout used for abi.decode.
  struct UlnConfig {
    uint64    confirmations;
    uint8     requiredDVNCount;
    uint8     optionalDVNCount;
    uint8     optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
  }

  event PeerAdded(address indexed oapp, uint32 indexed eid, bytes32 peer);
  event KycVerifierAdded(address indexed minter, uint8 indexed level, address indexed verifier);
  /// @notice Emitted after a successful DVN escalation step.
  /// @param newStep        The step we just moved TO (1 or 2).
  /// @param optionalCount  optionalDVNCount in the new config.
  /// @param threshold      optionalDVNThreshold in the new config.
  /// @param addedDvn       The single new DVN address that was appended.
  event DvnEscalated(
    address indexed oapp,
    address indexed lib,
    uint32  indexed eid,
    uint8   newStep,
    uint8   optionalCount,
    uint8   threshold,
    address addedDvn
  );
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
  ///         additions-only rule (existing levels can't be rewritten) AND
  ///         the level >= 2 floor (level 0 = no gate, level 1 = time-lock;
  ///         both are verifier-free paths in the withdraw-gate state machine).
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
    // Snapshot the initial config so addDvnToPathway can replay-protect itself
    // against a caller supplying a stale "current" config.
    _ulnConfigHash[oapp][lib][eid] = keccak256(ulnConfig);

    ILzEndpoint.SetConfigParam[] memory params = new ILzEndpoint.SetConfigParam[](1);
    params[0] = ILzEndpoint.SetConfigParam({ eid: eid, configType: CONFIG_TYPE_ULN, config: ulnConfig });
    ILzEndpoint(endpointAddr).setConfig(oapp, lib, params);

    emit PathwayConfigured(oapp, lib, eid, ulnConfig);
  }

  /// @notice Add exactly one new optional DVN to an existing pathway, following
  ///         the fixed escalation sequence:
  ///           step 0 → 1 : optionalDVNCount 3→4, threshold 2→3
  ///           step 1 → 2 : optionalDVNCount 4→5, threshold unchanged (3)
  ///           step 2+    : LOCKED — reverts
  ///
  ///         At every step the honest-DVN majority is preserved: at 3-of-5 the
  ///         owner has appended at most 2 DVNs, so passing threshold still
  ///         requires 1 honest DVN.
  ///
  /// @dev    Replay-safe via the stored hash of the current config. Owner can't
  ///         remove DVNs, lower threshold, replace required DVNs, reorder the
  ///         existing optional set, or skip a step.
  ///
  /// @param oapp             The OApp whose DVN set we're extending.
  /// @param endpointAddr     The LZ EndpointV2 address for this chain.
  /// @param lib              The send- or receive-ULN library address.
  /// @param eid              Remote eid identifying the pathway.
  /// @param currentUlnConfig ABI-encoded UlnConfig bytes of the CURRENT config.
  /// @param newUlnConfig     ABI-encoded UlnConfig bytes of the PROPOSED config.
  function addDvnToPathway(
    address oapp,
    address endpointAddr,
    address lib,
    uint32  eid,
    bytes calldata currentUlnConfig,
    bytes calldata newUlnConfig
  ) external onlyOwner {
    require(_pathwayConfigured[oapp][lib][eid], "PathwayExpander: pathway not configured");

    uint8 step = _dvnEscalationStep[oapp][lib][eid];
    require(step < 2, "PathwayExpander: escalation locked");

    require(
      keccak256(currentUlnConfig) == _ulnConfigHash[oapp][lib][eid],
      "PathwayExpander: current config hash mismatch"
    );

    UlnConfig memory cur = abi.decode(currentUlnConfig, (UlnConfig));
    UlnConfig memory nxt = abi.decode(newUlnConfig,     (UlnConfig));

    // Invariants that must never change.
    require(nxt.confirmations    == cur.confirmations,    "PathwayExpander: confirmations changed");
    require(nxt.requiredDVNCount == cur.requiredDVNCount, "PathwayExpander: requiredDVNCount changed");
    require(nxt.requiredDVNs.length == cur.requiredDVNs.length, "PathwayExpander: requiredDVNs length changed");
    for (uint256 i; i < cur.requiredDVNs.length; ++i) {
      require(nxt.requiredDVNs[i] == cur.requiredDVNs[i], "PathwayExpander: requiredDVNs changed");
    }

    // Transition-specific shape checks.
    //   step 0→1: optional 3 → 4, threshold 2 → 3
    //   step 1→2: optional 4 → 5, threshold stays 3
    uint8 expectedNewOptionalCount = cur.optionalDVNCount + 1;
    uint8 expectedNewThreshold     = (step == 0) ? 3 : cur.optionalDVNThreshold;

    require(nxt.optionalDVNCount     == expectedNewOptionalCount, "PathwayExpander: wrong optionalDVNCount");
    require(nxt.optionalDVNThreshold == expectedNewThreshold,     "PathwayExpander: wrong optionalDVNThreshold");
    require(nxt.optionalDVNs.length  == nxt.optionalDVNCount,     "PathwayExpander: optionalDVNs array length mismatch");
    require(cur.optionalDVNs.length  == cur.optionalDVNCount,     "PathwayExpander: current optionalDVNs array length mismatch");

    // Prefix must be identical (no reordering).
    for (uint256 i; i < cur.optionalDVNCount; ++i) {
      require(nxt.optionalDVNs[i] == cur.optionalDVNs[i], "PathwayExpander: optionalDVNs prefix reordered");
    }

    // New DVN must be fresh.
    address addedDvn = nxt.optionalDVNs[cur.optionalDVNCount];
    require(addedDvn != address(0), "PathwayExpander: zero DVN address");
    for (uint256 i; i < cur.requiredDVNs.length; ++i) {
      require(addedDvn != cur.requiredDVNs[i], "PathwayExpander: duplicate DVN (required)");
    }
    for (uint256 i; i < cur.optionalDVNCount; ++i) {
      require(addedDvn != cur.optionalDVNs[i], "PathwayExpander: duplicate DVN (optional)");
    }

    // Forward to LZ endpoint.
    ILzEndpoint.SetConfigParam[] memory params = new ILzEndpoint.SetConfigParam[](1);
    params[0] = ILzEndpoint.SetConfigParam({ eid: eid, configType: CONFIG_TYPE_ULN, config: newUlnConfig });
    ILzEndpoint(endpointAddr).setConfig(oapp, lib, params);

    // Advance state.
    uint8 newStep = step + 1;
    _dvnEscalationStep[oapp][lib][eid] = newStep;
    _ulnConfigHash[oapp][lib][eid]     = keccak256(newUlnConfig);

    emit DvnEscalated(oapp, lib, eid, newStep, nxt.optionalDVNCount, nxt.optionalDVNThreshold, addedDvn);
  }

  /// @notice Returns the current DVN escalation step for a pathway.
  ///         0 = initial (2-of-3), 1 = 3-of-4, 2 = 3-of-5, anything higher = locked.
  function dvnEscalationStep(address oapp, address lib, uint32 eid) external view returns (uint8) {
    return _dvnEscalationStep[oapp][lib][eid];
  }

  /// @notice Returns true if configureNewPathway has already been called for
  ///         this (oapp, lib, eid) triple. Read by deploy tooling to decide
  ///         whether to skip an already-applied config step.
  function isPathwayConfigured(address oapp, address lib, uint32 eid) external view returns (bool) {
    return _pathwayConfigured[oapp][lib][eid];
  }
}
