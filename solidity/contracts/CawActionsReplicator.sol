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
    bytes text;        // smltxt-compressed UTF-8
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
 *      Clients select which available chains they replicate to via setClientChains (called by CawProfileL2).
 *      Anyone can call replicateBatch() — it's fully trustless since all data is verified on-chain.
 */
contract CawActionsReplicator is OApp {
  using OptionsBuilder for bytes;

  /// @notice The CawActions contract used for checkpoint and signature verification
  address public immutable cawActions;

  /// @notice The CawProfileL2 contract authorized to set client chains (immutable, set at deployment)
  address public immutable cawProfileL2;

  /// @notice Gas limit for receive on destination (just event emission, very cheap)
  /// @notice Gas forwarded to `_lzReceive` on the destination archive.
  /// @dev The destination archive's `_lzReceive` emits an event with the full
  ///      payload in `data`. Solidity's LOG opcode charges 8 gas per byte of
  ///      event data, plus memory expansion, plus LZ framing overhead. For a
  ///      128-action checkpoint with smltxt-compressed text the payload is
  ///      ~40-90KB, requiring ~500k–1M gas. The 1,000,000 default covers
  ///      typical traffic with headroom.
  ///
  ///      This value is tunable by the owner within `[1, MAX_RECEIVE_GAS_LIMIT]`
  ///      during the protocol's tuning period. After renouncement the setter
  ///      becomes uncallable and the value is effectively immutable. The
  ///      MAX_RECEIVE_GAS_LIMIT constant bounds the worst case an owner (or
  ///      compromised owner key) can impose.
  uint128 public receiveGasLimit = 1_000_000;

  /// @notice Hard ceiling on receiveGasLimit. Immutable; not settable.
  /// @dev 5M is comfortably above worst-case archive `_lzReceive` gas for a
  ///      doubled (256-action) checkpoint with uncompressible text and leaves
  ///      room below Arbitrum/Base's 30M block gas limit for LZ's surrounding
  ///      executor overhead. Going above this would inflate LZ fees without
  ///      covering any realistic payload.
  uint128 public constant MAX_RECEIVE_GAS_LIMIT = 5_000_000;

  /// @notice Emitted when the owner adjusts `receiveGasLimit`.
  event ReceiveGasLimitUpdated(uint128 oldLimit, uint128 newLimit);

  /// @notice Adjust the gas forwarded to destination `_lzReceive`. Bounded by
  ///         MAX_RECEIVE_GAS_LIMIT. Typically called once after observing real
  ///         traffic and before renouncing ownership.
  /// @param newLimit Gas limit in the range [1, MAX_RECEIVE_GAS_LIMIT].
  function setReceiveGasLimit(uint128 newLimit) external onlyOwner {
    require(newLimit > 0 && newLimit <= MAX_RECEIVE_GAS_LIMIT, "Out of range");
    uint128 oldLimit = receiveGasLimit;
    receiveGasLimit = newLimit;
    emit ReceiveGasLimitUpdated(oldLimit, newLimit);
  }

  // ============================================
  // GLOBAL ARCHIVE CHAIN REGISTRY (owner-managed)
  // ============================================

  /// @notice List of all available archive chain EIDs
  uint32[] public availableChains;

  /// @notice Whether a chain EID is in the available set
  mapping(uint32 => bool) public isAvailableChain;

  // ============================================
  // CLIENT CHAIN SELECTION (set via CawProfileL2)
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
   * @param _cawProfileL2 The CawProfileL2 contract address (for receiving config updates)
   */
  constructor(
    address _endpoint,
    address _cawActions,
    address _cawProfileL2
  ) OApp(_endpoint, msg.sender) {
    require(_cawActions != address(0), "Invalid CawActions address");
    require(_cawProfileL2 != address(0), "Invalid CawProfileL2 address");
    cawActions = _cawActions;
    cawProfileL2 = _cawProfileL2;
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
  // CLIENT CHAIN SELECTION (called by CawProfileL2)
  // ============================================

  /**
   * @notice Set the full list of chains a client replicates to. Called by CawProfileL2.
   * @param clientId The client ID
   * @param destEids Array of destination chain EIDs (must all be available chains)
   */
  function setClientChains(uint32 clientId, uint32[] calldata destEids) external {
    require(msg.sender == cawProfileL2, "Only CawProfileL2");

    // Clear old chain selections
    uint32[] storage oldChains = clientChains[clientId];
    for (uint i = 0; i < oldChains.length; i++) {
      clientChainEnabled[clientId][oldChains[i]] = false;
    }
    delete clientChains[clientId];

    // Set new chain selections. Skip EIDs that aren't registered on THIS
    // replicator — the ClientManager stores a global chain list shared by
    // all L2s, but each replicator only has its own destinations registered
    // (e.g. L2's replicator has L2b's archive, L2b's replicator has L2's).
    for (uint i = 0; i < destEids.length; i++) {
      if (!isAvailableChain[destEids[i]]) continue;
      if (clientChainEnabled[clientId][destEids[i]]) continue;
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
    // Dynamic gas limit: sized to the actual payload instead of a fixed 1M.
    // Archive's _lzReceive emits an event: ~50K base + 8 gas per byte of data.
    // 25% buffer on top for safety.
    uint128 dynamicGas = uint128((50_000 + payload.length * 8) * 125 / 100);
    // Clamp to receiveGasLimit (owner-tunable ceiling) — never exceed it.
    if (dynamicGas > receiveGasLimit) dynamicGas = receiveGasLimit;
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(dynamicGas, 0);
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

  /// @dev Checkpoint interval — must match CawActions.CHECKPOINT_INTERVAL.
  uint256 private constant CHECKPOINT_INTERVAL = 32;

  struct ReplicationParams {
    uint32 clientId;
    uint32 destEid;
    uint256 startCheckpointId;   // first checkpoint in the range (inclusive)
    uint256 endCheckpointId;     // last checkpoint in the range (inclusive)
    uint256 lzTokenAmount;
  }

  /// @notice Replicate one or more consecutive checkpoints to an archive chain.
  ///         The validator packs as many checkpoints as fit in the ~60KB LZ limit.
  ///
  /// @dev Trust model: the on-chain hash chain in CawActions commits to BOTH the
  ///      r sequence AND keccak256(packedSlice) per action. Verification only needs
  ///      the hash at (startCheckpointId - 1) and endCheckpointId — intermediate
  ///      checkpoint hashes are implicitly verified by the chain. No per-action
  ///      ecrecover needed; the hash chain IS the proof.
  ///
  /// @param params Replication parameters (clientId, destEid, start/end checkpointId, lzTokenAmount)
  /// @param packedActions Packed action bytes covering all actions in the checkpoint range
  /// @param r Signature r values (CHECKPOINT_INTERVAL * numCheckpoints items)
  function replicateBatch(
    ReplicationParams calldata params,
    bytes calldata packedActions,
    bytes32[] calldata r
  ) external payable {
    require(params.startCheckpointId > 0, "Invalid start checkpoint");
    require(params.endCheckpointId >= params.startCheckpointId, "Invalid range");

    uint256 numCheckpoints = params.endCheckpointId - params.startCheckpointId + 1;
    uint256 expectedActions = numCheckpoints * CHECKPOINT_INTERVAL;

    // Read action count from packed header
    uint256 actionCount = (uint256(uint8(packedActions[0])) << 8) | uint256(uint8(packedActions[1]));
    require(actionCount == expectedActions, "Action count mismatch");
    require(r.length == expectedActions, "r array length mismatch");

    require(isAvailableChain[params.destEid], "Chain not available");
    require(clientChainEnabled[params.clientId][params.destEid], "Client chain not enabled");

    // Verify the hash chain from (startCheckpointId - 1) to endCheckpointId.
    _verifyCheckpointHashPacked(
      params.clientId, params.startCheckpointId, params.endCheckpointId,
      packedActions, r
    );

    // Mark all checkpoints in the range as replicated
    for (uint256 cp = params.startCheckpointId; cp <= params.endCheckpointId; ) {
      checkpointReplicated[params.clientId][params.destEid][cp] = true;
      unchecked { ++cp; }
    }

    // Forward packed bytes directly to LZ
    _replicateToDestination(params.clientId, params.destEid, packedActions, params.lzTokenAmount);

    emit BatchReplicated(params.startCheckpointId, params.clientId, params.destEid);
  }

  /// @dev Walk all packed actions across a range of checkpoints, verify the hash
  ///      chain from the checkpoint before startId to endId.
  function _verifyCheckpointHashPacked(
    uint32 clientId,
    uint256 startCheckpointId,
    uint256 endCheckpointId,
    bytes calldata packedActions,
    bytes32[] calldata r
  ) internal view {
    ICawActionsForReplicator cawActionsContract = ICawActionsForReplicator(cawActions);

    bytes32 hash = startCheckpointId == 1
      ? bytes32(0)
      : cawActionsContract.clientHashAtCheckpoint(clientId, startCheckpointId - 1);

    uint256 totalActions = (endCheckpointId - startCheckpointId + 1) * CHECKPOINT_INTERVAL;
    uint256 pos = 2; // skip actionCount header
    for (uint i = 0; i < totalActions; ) {
      uint256 actionStart = pos;
      pos += 21;
      uint256 rc = uint256(uint8(packedActions[pos])); pos += 1;
      uint256 ac = uint256(uint8(packedActions[pos])); pos += 1;
      pos += rc * 4;
      pos += ac * 8;
      uint256 tl = (uint256(uint8(packedActions[pos])) << 8) | uint256(uint8(packedActions[pos + 1]));
      pos += 2 + tl;

      bytes32 actionHash = keccak256(packedActions[actionStart:pos]);
      hash = keccak256(abi.encodePacked(hash, r[i], actionHash));
      unchecked { ++i; }
    }
    require(hash == cawActionsContract.clientHashAtCheckpoint(clientId, endCheckpointId), "Hash chain mismatch");
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
    totalCheckpoints = actionCount / CHECKPOINT_INTERVAL;

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
  /// @notice Get a fee quote for replicating a multibatch to a destination.
  /// @param destEid The destination chain endpoint ID
  /// @param numCheckpoints Number of checkpoints in this batch (1 = single, N = multibatch)
  /// @param avgTextLength Average text length per action (for payload size estimation)
  /// @param avgRecipients Average recipients per action (usually 0)
  /// @param payInLzToken Whether to pay in LZ token
  function quoteReplicateBatch(
    uint32 destEid,
    uint256 numCheckpoints,
    uint256 avgTextLength,
    uint256 avgRecipients,
    bool payInLzToken
  ) external view returns (MessagingFee memory fee) {
    uint256 totalActions = numCheckpoints * CHECKPOINT_INTERVAL;
    uint256 perAction = 25 + (4 * avgRecipients) + (8 * avgRecipients) + avgTextLength;
    uint256 estimatedSize = 2 + (totalActions * perAction); // 2-byte header

    // Mirror the dynamic gas formula used in _replicateToDestination
    uint128 dynamicGas = uint128((50_000 + estimatedSize * 8) * 125 / 100);
    if (dynamicGas > receiveGasLimit) dynamicGas = receiveGasLimit;

    bytes memory dummyPayload = new bytes(estimatedSize);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(dynamicGas, 0);

    return _quote(destEid, dummyPayload, options, payInLzToken);
  }

}
