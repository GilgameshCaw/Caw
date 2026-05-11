// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal subset of CawActions we need to read checkpoint hashes.
interface ICawActionsCheckpoints {
  function networkHashAtCheckpoint(uint32 networkId, uint256 checkpointId) external view returns (bytes32);
}

/// @title CawActionVerifier
///
/// @notice Trustless verifier that proves a specific CAW action was committed
///         to the protocol's per-network hash chain. No optimistic window, no
///         bonds, no watchers to slash — the proof is "give me the 32 actions
///         in this checkpoint and the matching `r` anchors, and I'll fold them
///         into the canonical hash."
///
/// @dev    Background: `CawActions` maintains a rolling hash per `networkId`:
///
///           networkHash = keccak256(prevHash || r || keccak256(packedSlice))
///
///         At every 32nd action the hash is mirrored into
///         `networkHashAtCheckpoint[networkId][checkpointId]`. Checkpoint IDs
///         are 1-indexed (the first 32 actions form checkpoint 1).
///
///         To prove action N was real:
///           1. Submit the full checkpoint slice (32 packed actions + 32 r values).
///           2. We fold them forward from `networkHashAtCheckpoint[networkId][k-1]`
///              (or bytes32(0) for k=1) and compare against
///              `networkHashAtCheckpoint[networkId][k]`.
///           3. If they match, every action in that slice provably happened —
///              return the target action's bytes to the caller.
///
///         The proof is calldata-heavy (~32 × packed-action ≈ 1.5-6 KB) and
///         compute-bounded (~32 keccak rounds for the fold + 32 for slice
///         hashes ≈ ~100k gas). That's the tradeoff for not needing a Merkle
///         commitment in the protocol. For high-value callbacks (DEX trades,
///         large tips) this cost is trivial; for sub-cent flows you'd skip
///         on-chain verification and trust a watcher network with bounties.
contract CawActionVerifier {
  ICawActionsCheckpoints public immutable cawActions;

  /// @dev Must match CawActions.CHECKPOINT_INTERVAL.
  uint256 public constant CHECKPOINT_INTERVAL = 32;

  constructor(address _cawActions) {
    cawActions = ICawActionsCheckpoints(_cawActions);
  }

  /// @notice Verify a checkpoint slice and return the bytes of the target action.
  ///
  /// @param  networkId       The network the actions belong to.
  /// @param  checkpointId    1-indexed checkpoint number (k); proves the 32
  ///                         actions ending at action index `k * 32`.
  /// @param  packedActions   The 32 raw packed-action byte slices, in order.
  ///                         Each slice is the same bytes that were hashed
  ///                         into the rolling fold at action-processing time.
  /// @param  rValues         The 32 per-action signature `r` values, in order.
  ///                         These are the anchor terms in the fold; for EOA
  ///                         signatures they're the `r` from the ECDSA sig,
  ///                         for ERC-1271 signatures they're the first 32
  ///                         bytes of the contract-supplied sig blob.
  /// @param  targetIndex     Which action in the checkpoint to return (0-31).
  ///
  /// @return targetAction    The raw bytes of the action at `targetIndex`.
  ///                         The caller is responsible for decoding the packed
  ///                         format (see CawActions.sol for the layout).
  function verifyAndExtract(
    uint32 networkId,
    uint256 checkpointId,
    bytes[] calldata packedActions,
    bytes32[] calldata rValues,
    uint256 targetIndex
  ) external view returns (bytes memory targetAction) {
    require(checkpointId > 0, "Checkpoint must be 1-indexed");
    require(packedActions.length == CHECKPOINT_INTERVAL, "Need 32 actions");
    require(rValues.length == CHECKPOINT_INTERVAL, "Need 32 r values");
    require(targetIndex < CHECKPOINT_INTERVAL, "Target out of range");

    bytes32 expectedEndHash = cawActions.networkHashAtCheckpoint(networkId, checkpointId);
    require(expectedEndHash != bytes32(0), "Checkpoint not finalized");

    // Start hash is the previous checkpoint's hash, or bytes32(0) for checkpoint 1.
    bytes32 h = checkpointId == 1
      ? bytes32(0)
      : cawActions.networkHashAtCheckpoint(networkId, checkpointId - 1);

    // Fold: h = keccak256(h || r[i] || keccak256(packedActions[i])).
    for (uint256 i = 0; i < CHECKPOINT_INTERVAL; i++) {
      bytes32 sliceHash = keccak256(packedActions[i]);
      h = keccak256(abi.encodePacked(h, rValues[i], sliceHash));
    }

    require(h == expectedEndHash, "Slice does not fold to canonical hash");

    return packedActions[targetIndex];
  }

  /// @notice Convenience: return true iff the slice folds to the canonical
  ///         checkpoint hash. Reverts on bad input shape; returns false if
  ///         the fold simply doesn't match.
  /// @dev    Cheaper than `verifyAndExtract` for callers that already know
  ///         the action bytes and just want a yes/no.
  function verify(
    uint32 networkId,
    uint256 checkpointId,
    bytes[] calldata packedActions,
    bytes32[] calldata rValues
  ) external view returns (bool) {
    require(checkpointId > 0, "Checkpoint must be 1-indexed");
    require(packedActions.length == CHECKPOINT_INTERVAL, "Need 32 actions");
    require(rValues.length == CHECKPOINT_INTERVAL, "Need 32 r values");

    bytes32 expectedEndHash = cawActions.networkHashAtCheckpoint(networkId, checkpointId);
    if (expectedEndHash == bytes32(0)) return false;

    bytes32 h = checkpointId == 1
      ? bytes32(0)
      : cawActions.networkHashAtCheckpoint(networkId, checkpointId - 1);

    for (uint256 i = 0; i < CHECKPOINT_INTERVAL; i++) {
      bytes32 sliceHash = keccak256(packedActions[i]);
      h = keccak256(abi.encodePacked(h, rValues[i], sliceHash));
    }

    return h == expectedEndHash;
  }
}
