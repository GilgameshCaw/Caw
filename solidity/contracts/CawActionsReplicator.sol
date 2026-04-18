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

  struct ReplicationParams {
    uint32 clientId;
    uint32 destEid;
    uint256 checkpointId;
    uint256 lzTokenAmount;
  }

  /**
   * @notice Replicate a complete 128-action checkpoint to an archive chain
   * @param params Replication parameters (clientId, destEid, checkpointId, lzTokenAmount)
   * @param actions All 128 actions for this checkpoint
   * @param r Signature r values (128 items) — used for hash chain verification
   *
   * @dev Trust model: the on-chain hash chain `clientHashAtCheckpoint` in
   *      CawActions commits to BOTH the r sequence AND a hash of each action
   *      body (see CawActions._processAction). So if the hash chain check
   *      below passes, both (actions, r) match EXACTLY what was processed.
   *      No per-action ecrecover is needed on this side — the hash chain
   *      IS the proof. v and s aren't needed on the source chain at all.
   *      The archive also doesn't need v/s: it trusts (actions, r) arriving
   *      from this contract because LZ's peer-authenticity guarantee plus
   *      this contract's hash-chain gate together prove the payload matches
   *      what CawActions stored. See docs/CLIENT_REPLICATION_GUIDE.md.
   */
  function replicateBatch(
    ReplicationParams calldata params,
    ICawActionsForReplicator.ActionData[] calldata actions,
    bytes32[] calldata r
  ) external payable {
    require(params.checkpointId > 0, "Invalid checkpoint");
    require(actions.length == 256, "Must submit exactly 256 actions");
    require(r.length == 256, "r array must be 256");

    // Verify destination is valid
    require(isAvailableChain[params.destEid], "Chain not available");
    require(clientChainEnabled[params.clientId][params.destEid], "Client chain not enabled");

    // No duplicate guard — re-submission is allowed. If LZ delivery failed
    // (DVN stall, insufficient receiveGasLimit, etc.) anyone can resubmit the
    // same checkpoint. The archive just emits the event again (idempotent),
    // and the submitter pays gas + LZ fee so there's no griefing vector.
    // The hash chain verification below is the real security gate.

    // Verify (actions, r) chain correctly to the on-chain checkpoint hash.
    // This one call subsumes the previous _verifyActions (ecrecover + cawonce
    // + clientId checks) because the hash chain commits to the full action
    // struct, not just r.
    _verifyCheckpointHash(params.clientId, params.checkpointId, actions, r);

    // Mark as replicated before sending (checks-effects-interactions)
    checkpointReplicated[params.clientId][params.destEid][params.checkpointId] = true;

    // Replicate to the destination. Payload is tight-packed actions only — r
    // values are NOT forwarded. The hash chain was already verified above on
    // the source chain; the archive is for data preservation, not re-verification.
    // Dropping r saves 4KB (128×32) per checkpoint (~12-40% of payload).
    bytes memory payload = _packPayload(actions);
    _replicateToDestination(params.clientId, params.destEid, payload, params.lzTokenAmount);

    emit BatchReplicated(params.checkpointId, params.clientId, params.destEid);
  }

  function _verifyCheckpointHash(
    uint32 clientId,
    uint256 checkpointId,
    ICawActionsForReplicator.ActionData[] calldata actions,
    bytes32[] calldata r
  ) internal view {
    ICawActionsForReplicator cawActionsContract = ICawActionsForReplicator(cawActions);

    bytes32 hash = checkpointId == 1
      ? bytes32(0)
      : cawActionsContract.clientHashAtCheckpoint(clientId, checkpointId - 1);

    // Mirror the exact construction in CawActions._processAction:
    //   H_i = keccak256(H_{i-1} || r_i || keccak256(abi.encode(action_i)))
    for (uint i = 0; i < 256; i++) {
      bytes32 actionHash = keccak256(abi.encode(actions[i]));
      hash = keccak256(abi.encodePacked(hash, r[i], actionHash));
    }
    require(hash == cawActionsContract.clientHashAtCheckpoint(clientId, checkpointId), "Hash chain mismatch");
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
    totalCheckpoints = actionCount / 256;

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
    uint256 avgRecipients,
    uint256 avgAmounts,
    bool payInLzToken
  ) external view returns (MessagingFee memory fee) {
    // Estimate packed payload size for 128 actions.
    // Packed layout per action: 21 fixed + 1+4*recipients + 1+8*amounts + 2+textLen
    // Plus: 4-byte header + 128*32 r values
    uint256 perAction = 21 + 1 + (4 * avgRecipients) + 1 + (8 * avgAmounts) + 2 + avgTextLength;
    uint256 estimatedSize = 4 + (256 * perAction); // no r values in v2 format

    // Mirror the dynamic gas formula used in _replicateToDestination
    uint128 dynamicGas = uint128((50_000 + estimatedSize * 8) * 125 / 100);
    if (dynamicGas > receiveGasLimit) dynamicGas = receiveGasLimit;

    bytes memory dummyPayload = new bytes(estimatedSize);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(dynamicGas, 0);

    return _quote(destEid, dummyPayload, options, payInLzToken);
  }

  // ============================================
  // PAYLOAD PACKING
  // ============================================

  /// @dev Pack actions into a tight binary format for LZ transmission.
  ///      Assembly-optimized: uses mstore to write 32 bytes at a time.
  ///      r values are NOT included — hash-chain verification happens on the
  ///      source chain before this is called; the archive is for data preservation.
  ///
  /// Layout (version 2):
  ///   HEADER (4 bytes):
  ///     uint16 actionCount
  ///     uint8  version (2)
  ///     uint8  flags   (0, reserved)
  ///
  ///   Per action (variable length):
  ///     uint8   actionType
  ///     uint32  senderId
  ///     uint32  receiverId
  ///     uint32  receiverCawonce
  ///     uint32  clientId
  ///     uint32  cawonce
  ///     uint8   recipientCount
  ///     uint32  recipients[recipientCount]
  ///     uint8   amountCount
  ///     uint64  amounts[amountCount]
  ///     uint16  textLength
  ///     bytes   text[textLength]       (no padding)
  function _packPayload(
    ICawActionsForReplicator.ActionData[] calldata actions
  ) internal pure returns (bytes memory buf) {
    uint256 n = actions.length;

    // First pass: compute total size (Solidity — cheap, just length reads).
    uint256 size = 4; // header
    for (uint256 i = 0; i < n; i++) {
      size += 25 + (actions[i].recipients.length * 4)
                 + (actions[i].amounts.length * 8)
                 + actions[i].text.length;
    }

    buf = new bytes(size);

    assembly {
      // `buf` points to the length slot; actual data starts at buf+32.
      let ptr := add(buf, 32)

      // --- Header (4 bytes) ---
      // Pack [uint16 count, uint8 version=1, uint8 flags=0] into one word.
      // count is at most 256, version=1, flags=0 → top bytes = 0x0080_0100
      // for n=128. We shift into the top of a 32-byte word and mstore once.
      mstore(ptr, shl(240, n))          // uint16 count at bytes 0-1
      mstore8(add(ptr, 2), 2)           // version 2 (no r values)
      // flags = 0, already zero from allocation
      ptr := add(ptr, 4)
    }

    uint256 ptr;
    assembly { ptr := add(buf, 36) } // buf + 32 (data start) + 4 (header)

    // --- Actions ---
    for (uint256 i = 0; i < n; i++) {
      ICawActionsForReplicator.ActionData calldata a = actions[i];

      assembly {
        // actionType (1 byte)
        mstore8(ptr, calldataload(a))
        ptr := add(ptr, 1)

        // 5 × uint32 big-endian: senderId, receiverId, receiverCawonce, clientId, cawonce
        // Each is at a.offset + 32*fieldIndex in calldata.
        // calldataload gives 32 bytes left-aligned; we want the low 4 bytes
        // shifted to big-endian position. Since calldata uint32 is already
        // right-aligned in its 32-byte slot, we shift left by 224 bits (28 bytes).
        mstore(ptr, shl(224, calldataload(add(a, 0x20))))  // senderId
        mstore(add(ptr, 4), shl(224, calldataload(add(a, 0x40))))  // receiverId
        mstore(add(ptr, 8), shl(224, calldataload(add(a, 0x60))))  // receiverCawonce
        mstore(add(ptr, 12), shl(224, calldataload(add(a, 0x80)))) // clientId
        mstore(add(ptr, 16), shl(224, calldataload(add(a, 0xa0)))) // cawonce
        ptr := add(ptr, 20)
      }

      // Recipients: count byte + 4 bytes each
      uint32[] calldata recip = a.recipients;
      uint256 rc = recip.length;
      assembly {
        mstore8(ptr, rc)
        ptr := add(ptr, 1)
      }
      for (uint256 j = 0; j < rc; j++) {
        uint32 v = recip[j];
        assembly {
          mstore(ptr, shl(224, v))
          ptr := add(ptr, 4)
        }
      }

      // Amounts: count byte + 8 bytes each
      uint64[] calldata amts = a.amounts;
      uint256 ac = amts.length;
      assembly {
        mstore8(ptr, ac)
        ptr := add(ptr, 1)
      }
      for (uint256 j = 0; j < ac; j++) {
        uint64 v = amts[j];
        assembly {
          mstore(ptr, shl(192, v))
          ptr := add(ptr, 8)
        }
      }

      // Text: uint16 length + raw bytes
      bytes calldata text = a.text;
      uint256 tl = text.length;
      assembly {
        mstore(ptr, shl(240, tl))  // uint16 length big-endian
        ptr := add(ptr, 2)
        // Copy text from calldata in 32-byte chunks. Overwrites past the end
        // are harmless — they land in the next action's area (overwritten next
        // iteration). The buffer was pre-allocated to exact size.
        if tl {
          let src := text.offset
          let dst := ptr
          let end := add(ptr, tl)
          for {} lt(dst, end) {} {
            mstore(dst, calldataload(src))
            dst := add(dst, 32)
            src := add(src, 32)
          }
        }
        ptr := add(ptr, tl)
      }
    }

  }
}
