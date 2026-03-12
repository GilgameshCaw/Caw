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

  function clientHashAtCheckpoint(uint32 clientId, uint256 checkpointId) external view returns (bytes32);
  function clientCurrentHash(uint32 clientId) external view returns (bytes32);
  function verifySignature(uint8 v, bytes32 r, bytes32 s, ActionData calldata data) external view;
  function isCawonceUsed(uint32 senderId, uint256 cawonce) external view returns (bool);
}

/**
 * @title CawActionsReplicator
 * @notice Replicates action data to other chains via LayerZero.
 * @dev Deployed on L2. Receives replication config from L1 CawClientManager via LayerZero.
 *      When CawActions processes actions, it calls replicate() to send data to archive chains.
 */
contract CawActionsReplicator is OApp {
  using OptionsBuilder for bytes;

  /// @notice The CawActions contract authorized to replicate (immutable, set at deployment)
  address public immutable cawActions;

  /// @notice The CawNameL2 contract authorized to update peers (immutable, set at deployment)
  address public immutable cawNameL2;

  /// @notice Gas limit for receive on destination (just event emission, very cheap)
  /// @dev 50,000 gas is sufficient because CawActionsArchive only emits an event.
  ///      Event data cost scales with calldata (paid by sender), not execution gas.
  ///      Breakdown: ~25,000 for LZ overhead + ~5,000 for event = ~30,000 used.
  ///      Large payloads (images, long text) don't increase destination gas - they
  ///      increase the LayerZero fee on the source chain instead.
  uint128 public constant RECEIVE_GAS_LIMIT = 50000;

  /// @notice Peer addresses per client per chain: clientId => eid => target
  mapping(uint32 => mapping(uint32 => bytes32)) public clientPeers;

  /// @notice Replication destinations per client: clientId => destinations
  mapping(uint32 => ReplicationDestination[]) public clientReplications;

  /// @notice Whether replication is enabled for a client
  mapping(uint32 => bool) public clientReplicationEnabled;

  // Migration state: tracks progress through historical checkpoints (per-client, per-destination)
  // migrationBitmap[clientId][destEid][checkpointId] = bitmap of which actions have been migrated
  mapping(uint32 => mapping(uint32 => mapping(uint256 => uint256))) public migrationBitmap;

  event Replicated(uint32 indexed destEid, bytes32 guid, uint256 payloadSize, uint32 indexed clientId);
  event ReplicationFailed(uint32 indexed destEid, uint32 indexed clientId, string reason);
  event PeerUpdated(uint32 indexed clientId, uint32 indexed eid, address target);
  event MigrationBatchProcessed(uint256 indexed checkpointId, uint256 offset, uint256 count);

  /**
   * @param _endpoint LayerZero endpoint address
   * @param _cawActions The CawActions contract address (immutable)
   * @param _cawNameL2 The CawNameL2 contract address (immutable, for receiving config updates)
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

    // Renounce ownership - contract is now fully trustless
    _transferOwnership(address(0));
  }

  // ============================================
  // PEER MANAGEMENT (called by CawNameL2)
  // ============================================

  /**
   * @notice Update a replication peer for a client. Called by CawNameL2.
   * @param clientId The client ID
   * @param destEid The destination chain endpoint ID
   * @param target The target contract address (address(0) to remove)
   */
  function updatePeer(uint32 clientId, uint32 destEid, address target) external {
    require(msg.sender == cawNameL2, "Only CawNameL2 can update peers");
    _updatePeer(clientId, destEid, target);
  }

  /**
   * @notice Get all replication destinations for a client
   * @param clientId The client ID
   * @return destinations Array of replication destinations
   */
  function getReplicationDestinations(uint32 clientId) public view returns (ReplicationDestination[] memory) {
    if (!clientReplicationEnabled[clientId])
      return new ReplicationDestination[](0);
    return clientReplications[clientId];
  }

  /**
   * @notice Get replication count for a client
   * @param clientId The client ID
   * @return count Number of replication destinations
   */
  function getReplicationCount(uint32 clientId) public view returns (uint256) {
    if (!clientReplicationEnabled[clientId]) return 0;
    return clientReplications[clientId].length;
  }

  /**
   * @notice Replicate action data to all applicable destination chains
   * @param clientId The client ID (determines which chains to replicate to)
   * @param payload The encoded action data to replicate
   * @param lzTokenAmount Amount of LZ token for fees per chain (0 if paying in native)
   */
  function replicate(uint32 clientId, bytes calldata payload, uint256 lzTokenAmount) external payable {
    require(msg.sender == cawActions, "Only CawActions can replicate");

    ReplicationDestination[] memory destinations = getReplicationDestinations(clientId);
    if (destinations.length == 0) {
      // No replication configured, refund and return
      if (msg.value > 0) payable(tx.origin).transfer(msg.value);

      return;
    }

    _replicateToDestinations(clientId, payload, destinations, lzTokenAmount);
  }

  /**
   * @notice External wrapper for _lzSend to allow try/catch
   * @dev Only callable by this contract
   */
  function doLzSend(
    uint32 destEid,
    bytes calldata payload,
    bytes memory options,
    uint256 nativeFee,
    uint256 lzTokenFee
  ) external payable {
    require(msg.sender == address(this), "Only self");
    _lzSend(
      destEid,
      payload,
      options,
      MessagingFee(nativeFee, lzTokenFee),
      payable(tx.origin)
    );
  }

  /**
   * @notice Get a quote for replicating actions to all applicable chains
   * @param clientId The client ID
   * @param payload The payload to replicate
   * @param payInLzToken Whether to pay in LZ token
   * @return totalFee Total fee for all destination chains
   * @return chainCount Number of chains being replicated to
   */
  function quoteReplication(uint32 clientId, bytes calldata payload, bool payInLzToken)
    external view returns (MessagingFee memory totalFee, uint256 chainCount)
  {
    ReplicationDestination[] memory destinations = getReplicationDestinations(clientId);
    chainCount = destinations.length;

    if (chainCount == 0) return (MessagingFee(0, 0), 0);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(
      RECEIVE_GAS_LIMIT, 0
    );

    uint256 totalNativeFee = 0;
    uint256 totalLzTokenFee = 0;

    for (uint i = 0; i < destinations.length; i++) {
      MessagingFee memory fee = _quote(destinations[i].eid, payload, options, payInLzToken);
      totalNativeFee += fee.nativeFee;
      totalLzTokenFee += fee.lzTokenFee;
    }

    totalFee = MessagingFee(totalNativeFee, totalLzTokenFee);
  }

  /**
   * @notice This contract only sends, it doesn't receive LZ messages
   * @dev Config updates come from CawNameL2 via updatePeer()
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
   * @dev Update peer and replication destinations for a client
   */
  function _updatePeer(uint32 clientId, uint32 destEid, address target) internal {
    if (target == address(0)) {
      // Remove replication destination
      clientPeers[clientId][destEid] = bytes32(0);
      _removeReplicationDestination(clientId, destEid);
    } else {
      // Add/update replication destination
      clientPeers[clientId][destEid] = bytes32(uint256(uint160(target)));
      _addReplicationDestination(clientId, destEid, target);
      clientReplicationEnabled[clientId] = true;
    }

    emit PeerUpdated(clientId, destEid, target);
  }

  function _addReplicationDestination(uint32 clientId, uint32 eid, address target) internal {
    ReplicationDestination[] storage replications = clientReplications[clientId];

    // Check if already exists, update if so
    for (uint i = 0; i < replications.length; i++) {
      if (replications[i].eid == eid) {
        replications[i].target = target;
        return;
      }
    }

    // Add new
    replications.push(ReplicationDestination({
      target: target,
      eid: eid
    }));
  }

  function _removeReplicationDestination(uint32 clientId, uint32 eid) internal {
    ReplicationDestination[] storage replications = clientReplications[clientId];

    for (uint i = 0; i < replications.length; i++) {
      if (replications[i].eid == eid) {
        replications[i] = replications[replications.length - 1];
        replications.pop();
        return;
      }
    }
  }

  // ============================================
  // HISTORICAL MIGRATION
  // ============================================
  //
  // Allows migrating historical actions to new archive chains. Actions are verified
  // by checking that the r values chain correctly to on-chain checkpoints, and that
  // each action's signature is valid for its r value.
  //
  // Process:
  // 1. Submit 256 r values for a checkpoint + a batch of actions at an offset
  // 2. Contract verifies r values chain from previous checkpoint to this checkpoint
  // 3. Contract verifies each action's signature matches its r value at the offset
  // 4. Actions are replicated to configured destinations
  //
  // Anyone can call this - it's fully trustless since all data is verified on-chain.

  struct MigrationParams {
    uint32 clientId;
    uint32 destEid;
    uint256 checkpointId;
    uint256 offset;
    uint256 lzTokenAmount;
  }

  /**
   * @notice Migrate a batch of historical actions to a specific archive chain
   * @param params Migration parameters (clientId, destEid, checkpointId, offset, lzTokenAmount)
   * @param actions The actions to migrate (must all belong to clientId)
   * @param v Signature v values
   * @param r Signature r values (must match allR at offset positions)
   * @param s Signature s values
   * @param allR All 256 r values for this client's checkpoint
   */
  function migrateHistoricalBatch(
    MigrationParams calldata params,
    ICawActionsForReplicator.ActionData[] calldata actions,
    uint8[] calldata v,
    bytes32[] calldata r,
    bytes32[] calldata s,
    bytes32[256] calldata allR
  ) external payable {
    require(params.checkpointId > 0, "Invalid checkpoint");
    require(actions.length > 0, "No actions");
    require(actions.length == v.length && actions.length == r.length && actions.length == s.length, "Array mismatch");
    require(params.offset + actions.length <= 256, "Offset out of bounds");

    // Verify destination is valid for this client
    bytes32 peerBytes = clientPeers[params.clientId][params.destEid];
    require(peerBytes != bytes32(0), "Invalid destination for client");

    // Verify allR chains correctly
    _verifyCheckpointHash(params.clientId, params.checkpointId, allR);

    // Verify and mark actions
    _verifyAndMarkActions(params, actions, v, r, s, allR);

    // Replicate the verified actions to the single destination
    bytes memory payload = abi.encode(actions, v, r, s);
    _replicateToDestination(params.clientId, params.destEid, peerBytes, payload, params.lzTokenAmount);

    emit MigrationBatchProcessed(params.checkpointId, params.offset, actions.length);
  }

  function _verifyCheckpointHash(
    uint32 clientId,
    uint256 checkpointId,
    bytes32[256] calldata allR
  ) internal view {
    ICawActionsForReplicator cawActionsContract = ICawActionsForReplicator(cawActions);

    bytes32 hash = checkpointId == 1
      ? bytes32(0)
      : cawActionsContract.clientHashAtCheckpoint(clientId, checkpointId - 1);

    for (uint i = 0; i < 256; i++) {
      hash = keccak256(abi.encodePacked(hash, allR[i]));
    }
    require(hash == cawActionsContract.clientHashAtCheckpoint(clientId, checkpointId), "Invalid r sequence");
  }

  function _verifyAndMarkActions(
    MigrationParams calldata params,
    ICawActionsForReplicator.ActionData[] calldata actions,
    uint8[] calldata v,
    bytes32[] calldata r,
    bytes32[] calldata s,
    bytes32[256] calldata allR
  ) internal {
    ICawActionsForReplicator cawActionsContract = ICawActionsForReplicator(cawActions);

    for (uint i = 0; i < actions.length; i++) {
      require(actions[i].clientId == params.clientId, "Action clientId mismatch");
      require(r[i] == allR[params.offset + i], "R value mismatch");

      cawActionsContract.verifySignature(v[i], r[i], s[i], actions[i]);
      require(cawActionsContract.isCawonceUsed(actions[i].senderId, actions[i].cawonce), "Action never processed");

      uint256 bit = 1 << (params.offset + i);
      require((migrationBitmap[params.clientId][params.destEid][params.checkpointId] & bit) == 0, "Already migrated");
      migrationBitmap[params.clientId][params.destEid][params.checkpointId] |= bit;
    }
  }

  /**
   * @dev Internal function to replicate to a single destination (used by migration)
   */
  function _replicateToDestination(
    uint32 clientId,
    uint32 destEid,
    bytes32 peerBytes,
    bytes memory payload,
    uint256 lzTokenAmount
  ) internal {
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(RECEIVE_GAS_LIMIT, 0);
    peers[destEid] = peerBytes;

    try this.doLzSend(destEid, payload, options, msg.value, lzTokenAmount) {
      emit Replicated(destEid, bytes32(0), payload.length, clientId);
    } catch Error(string memory reason) {
      emit ReplicationFailed(destEid, clientId, reason);
    } catch {
      emit ReplicationFailed(destEid, clientId, "Unknown error");
    }
  }

  /**
   * @dev Internal function to replicate to all destinations (used by regular replicate)
   */
  function _replicateToDestinations(
    uint32 clientId,
    bytes memory payload,
    ReplicationDestination[] memory destinations,
    uint256 lzTokenAmount
  ) internal {
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(RECEIVE_GAS_LIMIT, 0);
    uint256 feePerChain = msg.value / destinations.length;
    uint256 lzTokenPerChain = lzTokenAmount / destinations.length;

    for (uint i = 0; i < destinations.length; i++) {
      ReplicationDestination memory dest = destinations[i];
      bytes32 peerBytes = clientPeers[clientId][dest.eid];

      if (peerBytes == bytes32(0)) {
        emit ReplicationFailed(dest.eid, clientId, "Peer not set");
        continue;
      }

      peers[dest.eid] = peerBytes;

      try this.doLzSend(dest.eid, payload, options, feePerChain, lzTokenPerChain) {
        emit Replicated(dest.eid, bytes32(0), payload.length, clientId);
      } catch Error(string memory reason) {
        emit ReplicationFailed(dest.eid, clientId, reason);
      } catch {
        emit ReplicationFailed(dest.eid, clientId, "Unknown error");
      }
    }
  }
}
