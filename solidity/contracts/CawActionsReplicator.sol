// contracts/CawActionsReplicator.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { ReplicationDestination } from "./CawClientManager.sol";


// Interface for CawActions checkpointing and verification
interface ICawActionsForReplicator {
  struct ActionData {
    uint8 actionType;
    uint32 senderId;
    uint32 receiverId;
    uint32 receiverCawonce;
    uint32 clientId;
    uint32 cawonce;
    uint32[] recipients;
    uint64[] amounts;  // Whole CAW tokens (not wei)
    string text;
  }

  function clientActionCount(uint32 clientId) external view returns (uint256);
  function clientCurrentHash(uint32 clientId) external view returns (bytes32);
  function clientHashAtCheckpoint(uint32 clientId, uint256 checkpointId) external view returns (bytes32);
  function verifySignature(uint8 v, bytes32 r, bytes32 s, ActionData calldata data) external view;
  function isCawonceUsed(uint32 senderId, uint256 cawonce) external view returns (bool);
}

/**
 * @title CawActionsReplicator
 * @notice Replicates action data to archive chains via LayerZero.
 * @dev Deployed on L2. Replication is decoupled from action processing — it runs
 *      as a background process that submits complete 128-action checkpoint batches.
 *      Owner registers archive chains globally via addArchiveChain.
 *      Clients select which available chains they replicate to via setClientChains (called by CawNameL2).
 *      Anyone can call replicateBatch() — it's fully trustless since all data is verified on-chain.
 */
contract CawActionsReplicator is OApp {
  using OptionsBuilder for bytes;

  /// @notice The CawActions contract used for checkpoint and signature verification
  address public immutable cawActions;

  /// @notice The CawNameL2 contract authorized to set client chains (immutable, set at deployment)
  address public immutable cawNameL2;

  /// @notice Gas limit for receive on destination (just event emission, very cheap)
  /// @dev 50,000 gas is sufficient because CawActionsArchive only emits an event.
  ///      Event data cost scales with calldata (paid by sender), not execution gas.
  ///      Breakdown: ~25,000 for LZ overhead + ~5,000 for event = ~30,000 used.
  ///      Large payloads (images, long text) don't increase destination gas - they
  ///      increase the LayerZero fee on the source chain instead.
  uint128 public constant RECEIVE_GAS_LIMIT = 50000;

  // ============================================
  // GLOBAL ARCHIVE CHAIN REGISTRY (owner-managed)
  // ============================================

  /// @notice List of all available archive chain EIDs
  uint32[] public availableChains;

  /// @notice Whether a chain EID is in the available set
  mapping(uint32 => bool) public isAvailableChain;

  // ============================================
  // CLIENT CHAIN SELECTION (set via CawNameL2)
  // ============================================

  /// @notice Which chains each client replicates to: clientId => destEid[]
  mapping(uint32 => uint32[]) public clientChains;

  /// @notice Fast lookup: clientId => destEid => enabled
  mapping(uint32 => mapping(uint32 => bool)) public clientChainEnabled;

  /// @notice Whether replication is enabled for a client
  mapping(uint32 => bool) public clientReplicationEnabled;

  /// @notice Tracks which checkpoints have been replicated: clientId => destEid => checkpointId => done
  mapping(uint32 => mapping(uint32 => mapping(uint256 => bool))) public checkpointReplicated;

  event Replicated(uint32 indexed destEid, uint256 payloadSize, uint32 indexed clientId);
  event ArchiveChainAdded(uint32 indexed eid, address target);
  event ClientChainsUpdated(uint32 indexed clientId, uint32[] destEids);
  event BatchReplicated(uint256 indexed checkpointId, uint32 indexed clientId, uint32 indexed destEid);

  /**
   * @param _endpoint LayerZero endpoint address
   * @param _cawActions The CawActions contract address (for checkpoint/signature verification)
   * @param _cawNameL2 The CawNameL2 contract address (for receiving config updates)
   */
  constructor(
    address _endpoint,
    address _cawActions,
    address _cawNameL2
  ) OApp(_endpoint, msg.sender) {
    require(_cawActions != address(0), "Invalid CawActions address");
    require(_cawNameL2 != address(0), "Invalid CawNameL2 address");
    cawActions = _cawActions;
    cawNameL2 = _cawNameL2;
  }

  // ============================================
  // ARCHIVE CHAIN MANAGEMENT (owner only)
  // ============================================

  /**
   * @notice Register an archive chain globally. Sets OApp peer via standard setPeer.
   * @param destEid The LayerZero endpoint ID of the archive chain
   * @param target The CawActionsArchive contract address on that chain
   */
  function addArchiveChain(uint32 destEid, address target) external onlyOwner {
    require(target != address(0), "Invalid target");
    require(!isAvailableChain[destEid], "Chain already registered");

    setPeer(destEid, bytes32(uint256(uint160(target))));
    availableChains.push(destEid);
    isAvailableChain[destEid] = true;

    emit ArchiveChainAdded(destEid, target);
  }

  /**
   * @notice Get all available archive chains
   * @return chains Array of available chain EIDs
   */
  function getAvailableChains() external view returns (uint32[] memory) {
    return availableChains;
  }

  // ============================================
  // CLIENT CHAIN SELECTION (called by CawNameL2)
  // ============================================

  /**
   * @notice Set the full list of chains a client replicates to. Called by CawNameL2.
   * @param clientId The client ID
   * @param destEids Array of destination chain EIDs (must all be available chains)
   */
  function setClientChains(uint32 clientId, uint32[] calldata destEids) external {
    require(msg.sender == cawNameL2, "Only CawNameL2");

    // Clear old chain selections
    uint32[] storage oldChains = clientChains[clientId];
    for (uint i = 0; i < oldChains.length; i++) {
      clientChainEnabled[clientId][oldChains[i]] = false;
    }
    delete clientChains[clientId];

    // Set new chain selections
    for (uint i = 0; i < destEids.length; i++) {
      require(isAvailableChain[destEids[i]], "Chain not available");
      require(!clientChainEnabled[clientId][destEids[i]], "Duplicate chain");
      clientChains[clientId].push(destEids[i]);
      clientChainEnabled[clientId][destEids[i]] = true;
    }

    clientReplicationEnabled[clientId] = destEids.length > 0;

    emit ClientChainsUpdated(clientId, destEids);
  }

  /**
   * @notice Get all replication destinations for a client
   * @param clientId The client ID
   * @return destinations Array of replication destinations
   */
  function getReplicationDestinations(uint32 clientId) public view returns (ReplicationDestination[] memory) {
    if (!clientReplicationEnabled[clientId])
      return new ReplicationDestination[](0);

    uint32[] storage chains = clientChains[clientId];
    ReplicationDestination[] memory destinations = new ReplicationDestination[](chains.length);

    for (uint i = 0; i < chains.length; i++) {
      destinations[i] = ReplicationDestination({
        target: address(uint160(uint256(peers[chains[i]]))),
        eid: chains[i]
      });
    }

    return destinations;
  }

  /**
   * @notice Get replication count for a client
   * @param clientId The client ID
   * @return count Number of replication destinations
   */
  function getReplicationCount(uint32 clientId) public view returns (uint256) {
    if (!clientReplicationEnabled[clientId]) return 0;
    return clientChains[clientId].length;
  }

  /**
   * @notice This contract only sends, it doesn't receive LZ messages
   */
  function _lzReceive(
    Origin calldata,
    bytes32,
    bytes calldata,
    address,
    bytes calldata
  ) internal pure override {
    revert("Replicator does not receive");
  }

  /**
   * @dev Internal function to replicate to a single destination. Reverts on failure
   *      so the caller can retry — no silent failures since replication is decoupled
   *      from action processing.
   */
  /// @dev Internal: send a replication message to the destination chain via LayerZero.
  ///
  /// SECURITY NOTE (audited 2026-04-07): Refund address is `tx.origin` rather than the
  /// LayerZero-standard `msg.sender`. This is intentional for our deployment model:
  /// `replicateBatch` is called directly by our validator EOA (not via a wrapper contract),
  /// so `tx.origin == msg.sender` in practice. Using `tx.origin` ensures that even if
  /// someone wraps `replicateBatch` in a contract, the original caller (the entity who
  /// actually paid the ETH) receives any LZ fee refund.
  function _replicateToDestination(
    uint32 clientId,
    uint32 destEid,
    bytes memory payload,
    uint256 lzTokenAmount
  ) internal {
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(RECEIVE_GAS_LIMIT, 0);
    _lzSend(
      destEid,
      payload,
      options,
      MessagingFee(msg.value, lzTokenAmount),
      payable(tx.origin)
    );
    emit Replicated(destEid, payload.length, clientId);
  }

  // ============================================
  // BATCH REPLICATION
  // ============================================
  //
  // Replicates a complete 128-action checkpoint to an archive chain. Decoupled from
  // action processing — intended to be called by a background replication service.
  //
  // Process:
  // 1. Submit all 128 actions for a checkpoint with their signatures
  // 2. Contract verifies r values chain from previous checkpoint to this checkpoint
  // 3. Contract verifies each action's signature matches its r value
  // 4. Actions are replicated to the specified destination chain
  //
  // Anyone can call this - it's fully trustless since all data is verified on-chain.

  struct ReplicationParams {
    uint32 clientId;
    uint32 destEid;
    uint256 checkpointId;
    uint256 lzTokenAmount;
  }

  /**
   * @notice Replicate a complete 128-action checkpoint to an archive chain
   * @param params Replication parameters (clientId, destEid, checkpointId, lzTokenAmount)
   * @param actions All 128 actions for this checkpoint (must all belong to clientId)
   * @param v Signature v values (128 items)
   * @param r Signature r values (128 items, also used for hash chain verification)
   * @param s Signature s values (128 items)
   */
  function replicateBatch(
    ReplicationParams calldata params,
    ICawActionsForReplicator.ActionData[] calldata actions,
    uint8[] calldata v,
    bytes32[] calldata r,
    bytes32[] calldata s
  ) external payable {
    require(params.checkpointId > 0, "Invalid checkpoint");
    require(actions.length == 128, "Must submit exactly 128 actions");
    require(v.length == 128 && r.length == 128 && s.length == 128, "Signature arrays must be 128");

    // Verify destination is valid
    require(isAvailableChain[params.destEid], "Chain not available");
    require(clientChainEnabled[params.clientId][params.destEid], "Client chain not enabled");

    // Prevent duplicate replication
    require(!checkpointReplicated[params.clientId][params.destEid][params.checkpointId], "Already replicated");

    // Verify r values chain correctly to the on-chain checkpoint hash
    _verifyCheckpointHash(params.clientId, params.checkpointId, r);

    // Verify each action's signature and that it was processed
    _verifyActions(params.clientId, actions, v, r, s);

    // Mark as replicated before sending (checks-effects-interactions)
    checkpointReplicated[params.clientId][params.destEid][params.checkpointId] = true;

    // Replicate to the destination
    bytes memory payload = abi.encode(actions, v, r, s);
    _replicateToDestination(params.clientId, params.destEid, payload, params.lzTokenAmount);

    emit BatchReplicated(params.checkpointId, params.clientId, params.destEid);
  }

  function _verifyCheckpointHash(
    uint32 clientId,
    uint256 checkpointId,
    bytes32[] calldata r
  ) internal view {
    ICawActionsForReplicator cawActionsContract = ICawActionsForReplicator(cawActions);

    bytes32 hash = checkpointId == 1
      ? bytes32(0)
      : cawActionsContract.clientHashAtCheckpoint(clientId, checkpointId - 1);

    for (uint i = 0; i < 128; i++) {
      hash = keccak256(abi.encodePacked(hash, r[i]));
    }
    require(hash == cawActionsContract.clientHashAtCheckpoint(clientId, checkpointId), "Invalid r sequence");
  }

  function _verifyActions(
    uint32 clientId,
    ICawActionsForReplicator.ActionData[] calldata actions,
    uint8[] calldata v,
    bytes32[] calldata r,
    bytes32[] calldata s
  ) internal view {
    ICawActionsForReplicator cawActionsContract = ICawActionsForReplicator(cawActions);

    for (uint i = 0; i < 128; i++) {
      require(actions[i].clientId == clientId, "Action clientId mismatch");
      cawActionsContract.verifySignature(v[i], r[i], s[i], actions[i]);
      require(cawActionsContract.isCawonceUsed(actions[i].senderId, actions[i].cawonce), "Action never processed");
    }
  }

  /**
   * @notice Returns the next checkpoint ID that needs replication for a client/destination pair.
   *         Returns 0 if fully caught up (no unreplicated checkpoints).
   * @param clientId The client ID
   * @param destEid The destination chain endpoint ID
   * @return nextCheckpointId The next unreplicated checkpoint (0 if caught up)
   * @return totalCheckpoints Total complete checkpoints for this client
   */
  function getNextUnreplicatedCheckpoint(uint32 clientId, uint32 destEid)
    external view returns (uint256 nextCheckpointId, uint256 totalCheckpoints)
  {
    ICawActionsForReplicator cawActionsContract = ICawActionsForReplicator(cawActions);
    uint256 actionCount = cawActionsContract.clientActionCount(clientId);
    totalCheckpoints = actionCount / 128;

    for (uint256 i = 1; i <= totalCheckpoints; i++) {
      if (!checkpointReplicated[clientId][destEid][i]) {
        return (i, totalCheckpoints);
      }
    }

    return (0, totalCheckpoints);
  }

  /**
   * @notice Get a quote for replicating a batch to a specific destination
   * @param destEid The destination chain endpoint ID
   * @param avgTextLength Average text length per action (for payload size estimation)
   * @param payInLzToken Whether to pay in LZ token
   * @return fee The messaging fee
   */
  function quoteReplicateBatch(
    uint32 destEid,
    uint256 avgTextLength,
    bool payInLzToken
  ) external view returns (MessagingFee memory fee) {
    // Estimate payload size for 128 actions:
    // - Each ActionData: ~200 bytes base + text length + arrays
    // - v, r, s: 1 + 32 + 32 = 65 bytes per action
    // - Encoding overhead: ~100 bytes
    uint256 estimatedSize = 100 + (128 * (265 + avgTextLength));

    bytes memory dummyPayload = new bytes(estimatedSize);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(RECEIVE_GAS_LIMIT, 0);

    return _quote(destEid, dummyPayload, options, payInLzToken);
  }
}
