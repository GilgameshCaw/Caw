// contracts/CawChallengeRelay.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

interface ICawActionsCheckpoints {
  function clientHashAtCheckpoint(uint32 clientId, uint256 checkpointId) external view returns (bytes32);
}

/**
 * @title CawChallengeRelay
 * @notice Deployed on L2 (Base). Reads checkpoint hashes from CawActions and sends
 *         them via LayerZero to archive chains as fraud proofs.
 * @dev Only used during challenges — sits idle during normal operation. Anyone can
 *      call relayChallenge() to dispute a submission on any archive chain. The
 *      archive trusts the hash because it arrives from a registered LZ peer that
 *      reads directly from CawActions' immutable checkpoint storage.
 */
contract CawChallengeRelay is OApp {
  using OptionsBuilder for bytes;

  ICawActionsCheckpoints public immutable cawActions;

  /// @notice Fixed gas cost of the archive's _lzReceive minus per-checkpoint work
  ///         (abi.decode of arrays + entry SSTOREs + event emit).
  uint128 public constant CHALLENGE_GAS_BASE = 60_000;
  /// @notice Per-checkpoint gas cost on the archive (two SSTOREs + event).
  uint128 public constant CHALLENGE_GAS_PER_CP = 55_000;

  event ChallengeRelayed(
    uint256 indexed submissionId,
    uint32 indexed clientId,
    uint256 checkpointId,
    uint32 destEid,
    bytes32 correctHash
  );

  event ChallengeBatchRelayed(
    uint256 indexed submissionId,
    uint32 indexed clientId,
    uint256[] checkpointIds,
    uint32 destEid
  );

  constructor(
    address _endpoint,
    address _cawActions
  ) OApp(_endpoint, msg.sender) {
    require(_cawActions != address(0), "Invalid CawActions");
    cawActions = ICawActionsCheckpoints(_cawActions);
  }

  /// @notice Relay one or more checkpoint hashes to an archive chain as a
  ///         fraud proof. Anyone can call this. Correct hashes are read from
  ///         CawActions (this chain) and sent via LZ to the archive.
  /// @dev The batch form collapses what would otherwise be N transactions
  ///      into a single LZ message. Payload format is always the batch shape:
  ///        abi.encode(submissionId, clientId, checkpointIds[], correctHashes[])
  ///      so the archive has exactly one decode path.
  function relayChallengeBatch(
    uint32 destEid,
    uint256 submissionId,
    uint32 clientId,
    uint256[] calldata checkpointIds
  ) external payable {
    uint256 n = checkpointIds.length;
    require(n > 0, "Empty checkpointIds");

    bytes32[] memory correctHashes = new bytes32[](n);
    for (uint256 i = 0; i < n; i++) {
      bytes32 h = cawActions.clientHashAtCheckpoint(clientId, checkpointIds[i]);
      require(h != bytes32(0), "Checkpoint does not exist");
      correctHashes[i] = h;
    }

    bytes memory payload = abi.encode(submissionId, clientId, checkpointIds, correctHashes);
    uint128 gasLimit = CHALLENGE_GAS_BASE + CHALLENGE_GAS_PER_CP * uint128(n);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);

    _lzSend(destEid, payload, options, MessagingFee(msg.value, 0), payable(msg.sender));

    emit ChallengeBatchRelayed(submissionId, clientId, checkpointIds, destEid);
  }

  /// @notice Single-checkpoint convenience wrapper around relayChallengeBatch.
  function relayChallenge(
    uint32 destEid,
    uint256 submissionId,
    uint32 clientId,
    uint256 checkpointId
  ) external payable {
    bytes32 correctHash = cawActions.clientHashAtCheckpoint(clientId, checkpointId);
    require(correctHash != bytes32(0), "Checkpoint does not exist");

    uint256[] memory ids = new uint256[](1);
    bytes32[] memory hashes = new bytes32[](1);
    ids[0] = checkpointId;
    hashes[0] = correctHash;

    bytes memory payload = abi.encode(submissionId, clientId, ids, hashes);
    uint128 gasLimit = CHALLENGE_GAS_BASE + CHALLENGE_GAS_PER_CP;
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);

    _lzSend(destEid, payload, options, MessagingFee(msg.value, 0), payable(msg.sender));

    emit ChallengeRelayed(submissionId, clientId, checkpointId, destEid, correctHash);
  }

  /// @notice Quote the LZ fee for a batch challenge relay.
  function quoteChallengeBatch(
    uint32 destEid,
    uint256 submissionId,
    uint32 clientId,
    uint256[] calldata checkpointIds,
    bool payInLzToken
  ) external view returns (MessagingFee memory) {
    uint256 n = checkpointIds.length;
    bytes32[] memory placeholder = new bytes32[](n);
    bytes memory payload = abi.encode(submissionId, clientId, checkpointIds, placeholder);
    uint128 gasLimit = CHALLENGE_GAS_BASE + CHALLENGE_GAS_PER_CP * uint128(n);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);
    return _quote(destEid, payload, options, payInLzToken);
  }

  /// @notice Quote the LZ fee for a single-checkpoint challenge (legacy caller).
  function quoteChallenge(
    uint32 destEid,
    uint256 submissionId,
    uint32 clientId,
    uint256 checkpointId,
    bool payInLzToken
  ) external view returns (MessagingFee memory) {
    uint256[] memory ids = new uint256[](1);
    bytes32[] memory placeholder = new bytes32[](1);
    ids[0] = checkpointId;
    bytes memory payload = abi.encode(submissionId, clientId, ids, placeholder);
    uint128 gasLimit = CHALLENGE_GAS_BASE + CHALLENGE_GAS_PER_CP;
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);
    return _quote(destEid, payload, options, payInLzToken);
  }

  /// @notice This contract only sends, never receives.
  function _lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata) internal pure override {
    revert("ChallengeRelay does not receive");
  }

  // Overriding to allow the caller to receive LZ refunds
  function _payNative(uint256 _nativeFee) internal virtual override returns (uint256) {
    if (msg.value < _nativeFee) revert NotEnoughNative(msg.value);
    return _nativeFee;
  }
}
