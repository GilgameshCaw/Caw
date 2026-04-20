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

  /// @notice Gas forwarded to the archive's _lzReceive for challenge processing.
  ///         Challenge payloads are small (~160 bytes) and the archive does minimal
  ///         work (one SSTORE), so 100K gas is generous.
  uint128 public constant CHALLENGE_GAS_LIMIT = 100_000;

  event ChallengeRelayed(
    uint256 indexed submissionId,
    uint32 indexed clientId,
    uint256 checkpointId,
    uint32 destEid,
    bytes32 correctHash
  );

  constructor(
    address _endpoint,
    address _cawActions
  ) OApp(_endpoint, msg.sender) {
    require(_cawActions != address(0), "Invalid CawActions");
    cawActions = ICawActionsCheckpoints(_cawActions);
  }

  /// @notice Relay a checkpoint hash to an archive chain as a fraud proof.
  ///         Anyone can call this. The correct hash is read from CawActions
  ///         (on this chain) and sent via LZ to the archive.
  /// @param destEid The LZ endpoint ID of the archive chain
  /// @param submissionId The submission being challenged on the archive
  /// @param clientId The client whose checkpoint is being disputed
  /// @param checkpointId The specific checkpoint to prove
  function relayChallenge(
    uint32 destEid,
    uint256 submissionId,
    uint32 clientId,
    uint256 checkpointId
  ) external payable {
    bytes32 correctHash = cawActions.clientHashAtCheckpoint(clientId, checkpointId);
    require(correctHash != bytes32(0), "Checkpoint does not exist");

    bytes memory payload = abi.encode(submissionId, clientId, checkpointId, correctHash);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(CHALLENGE_GAS_LIMIT, 0);

    _lzSend(destEid, payload, options, MessagingFee(msg.value, 0), payable(msg.sender));

    emit ChallengeRelayed(submissionId, clientId, checkpointId, destEid, correctHash);
  }

  /// @notice Quote the LZ fee for a challenge relay.
  function quoteChallenge(
    uint32 destEid,
    uint256 submissionId,
    uint32 clientId,
    uint256 checkpointId,
    bool payInLzToken
  ) external view returns (MessagingFee memory) {
    bytes memory payload = abi.encode(submissionId, clientId, checkpointId, bytes32(0));
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(CHALLENGE_GAS_LIMIT, 0);
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
