// contracts/CawChallengeRelay.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import "./OnlyOnce.sol";

interface ICawActionsCheckpoints {
  function networkHashAtCheckpoint(uint32 networkId, uint256 checkpointId) external view returns (bytes32);
}

/**
 * @title CawChallengeRelay
 * @notice Deployed on L2 (Base). Reads checkpoint hashes from CawActions and sends
 *         them via LayerZero to archive chains as fraud proofs.
 * @dev Only used during challenges — sits idle during normal operation. Anyone can
 *      call relayChallenge() to dispute a submission on any archive chain. The
 *      hash is canonical because the relay reads it directly from CawActions'
 *      immutable checkpoint storage on this chain; LayerZero is the transport
 *      that delivers that bytes32 to the archive, and the archive's peer lock
 *      authenticates that the message originated from this relay (not that
 *      LayerZero attests to the value).
 *
 * @dev Audit-trail tags in this contract (e.g. "H-N", "M-N", "Round N",
 *      "Audit fix YYYY-MM-DD") are decoded in `docs/AUDIT_TRAIL.md`.
 */
contract CawChallengeRelay is OnlyOnce, OApp {
  using OptionsBuilder for bytes;

  ICawActionsCheckpoints public immutable cawActions;

  /// @notice Fixed gas cost of the archive's _lzReceive minus per-checkpoint work
  ///         (abi.decode of arrays + entry SSTOREs + event emit).
  uint128 public constant CHALLENGE_GAS_BASE = 60_000;
  /// @notice Per-checkpoint gas cost on the archive (two SSTOREs + event).
  uint128 public constant CHALLENGE_GAS_PER_CP = 55_000;

  event ChallengeRelayed(
    uint256 indexed submissionId,
    uint32 indexed networkId,
    uint256 checkpointId,
    uint32 destEid,
    bytes32 correctHash
  );

  event ChallengeBatchRelayed(
    uint256 indexed submissionId,
    uint32 indexed networkId,
    uint256[] checkpointIds,
    uint32 destEid
  );

  constructor(
    address _endpoint,
    address _cawActions,
    address _pathwayExpander
  ) OApp(_endpoint, _pathwayExpander) {
    require(_cawActions       != address(0), "Invalid CawActions");
    require(_pathwayExpander  != address(0), "CawChallengeRelay: zero pathwayExpander");
    cawActions = ICawActionsCheckpoints(_cawActions);
  }

  /// @notice Lock the inherited OApp `setPeer` once per eid. Once a peer is set
  /// in deploy, it can NEVER be changed — even by the owner. The relay points at
  /// the canonical archive on each destination chain; swapping it would let a rogue
  /// owner redirect challenges into a bogus archive. New eids stay openable.
  function setPeer(uint32 _eid, bytes32 _peer)
    public
    override
    onlyOnce(keccak256(abi.encode("setPeer", _eid)))
  {
    super.setPeer(_eid, _peer);
  }

  /// @dev SECURITY NOTE — setDelegate hardening (Audit 2026-05-08 MED-3):
  ///      The inherited setDelegate is non-virtual; rely on owner renouncement
  ///      post-deploy. See CawActionsArchive.sol for the full note.

  /// @notice Relay one or more checkpoint hashes to an archive chain as a
  ///         fraud proof. Anyone can call this. Correct hashes are read from
  ///         CawActions (this chain) and sent via LZ to the archive.
  /// @dev The batch form collapses what would otherwise be N transactions
  ///      into a single LZ message. Payload format is always the batch shape:
  ///        abi.encode(submissionId, networkId, checkpointIds[], correctHashes[])
  ///      so the archive has exactly one decode path.
  function relayChallengeBatch(
    uint32 destEid,
    uint256 submissionId,
    uint32 networkId,
    uint256[] calldata checkpointIds
  ) external payable {
    uint256 n = checkpointIds.length;
    require(n > 0, "Empty checkpointIds");

    bytes32[] memory correctHashes = new bytes32[](n);
    for (uint256 i = 0; i < n; i++) {
      bytes32 h = cawActions.networkHashAtCheckpoint(networkId, checkpointIds[i]);
      require(h != bytes32(0), "Checkpoint does not exist");
      correctHashes[i] = h;
    }

    bytes memory payload = abi.encode(submissionId, networkId, checkpointIds, correctHashes);
    uint128 gasLimit = CHALLENGE_GAS_BASE + CHALLENGE_GAS_PER_CP * uint128(n);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);

    _lzSend(destEid, payload, options, MessagingFee(msg.value, 0), payable(msg.sender));

    emit ChallengeBatchRelayed(submissionId, networkId, checkpointIds, destEid);
  }

  /// @notice Single-checkpoint convenience wrapper around relayChallengeBatch.
  function relayChallenge(
    uint32 destEid,
    uint256 submissionId,
    uint32 networkId,
    uint256 checkpointId
  ) external payable {
    bytes32 correctHash = cawActions.networkHashAtCheckpoint(networkId, checkpointId);
    require(correctHash != bytes32(0), "Checkpoint does not exist");

    uint256[] memory ids = new uint256[](1);
    bytes32[] memory hashes = new bytes32[](1);
    ids[0] = checkpointId;
    hashes[0] = correctHash;

    bytes memory payload = abi.encode(submissionId, networkId, ids, hashes);
    uint128 gasLimit = CHALLENGE_GAS_BASE + CHALLENGE_GAS_PER_CP;
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);

    _lzSend(destEid, payload, options, MessagingFee(msg.value, 0), payable(msg.sender));

    emit ChallengeRelayed(submissionId, networkId, checkpointId, destEid, correctHash);
  }

  /// @notice Quote the LZ fee for a batch challenge relay.
  function quoteChallengeBatch(
    uint32 destEid,
    uint256 submissionId,
    uint32 networkId,
    uint256[] calldata checkpointIds,
    bool payInLzToken
  ) external view returns (MessagingFee memory) {
    uint256 n = checkpointIds.length;
    bytes32[] memory placeholder = new bytes32[](n);
    bytes memory payload = abi.encode(submissionId, networkId, checkpointIds, placeholder);
    uint128 gasLimit = CHALLENGE_GAS_BASE + CHALLENGE_GAS_PER_CP * uint128(n);
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);
    return _quote(destEid, payload, options, payInLzToken);
  }

  /// @notice Quote the LZ fee for a single-checkpoint challenge (legacy caller).
  function quoteChallenge(
    uint32 destEid,
    uint256 submissionId,
    uint32 networkId,
    uint256 checkpointId,
    bool payInLzToken
  ) external view returns (MessagingFee memory) {
    uint256[] memory ids = new uint256[](1);
    bytes32[] memory placeholder = new bytes32[](1);
    ids[0] = checkpointId;
    bytes memory payload = abi.encode(submissionId, networkId, ids, placeholder);
    uint128 gasLimit = CHALLENGE_GAS_BASE + CHALLENGE_GAS_PER_CP;
    bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimit, 0);
    return _quote(destEid, payload, options, payInLzToken);
  }

  /// @notice This contract only sends, never receives.
  function _lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata) internal pure override {
    revert("ChallengeRelay does not receive");
  }

  // Overriding so callers can over-pay; the LZ endpoint refunds the excess
  // to the _refundAddress passed in _lzSend (msg.sender). Audit fix
  // 2026-05-08 (Archive MED-1): the previous version returned _nativeFee,
  // which trapped the over-paid (msg.value - _nativeFee) ETH in this
  // contract permanently (no withdraw path). Returning msg.value forwards
  // the full balance to the endpoint, which uses _nativeFee for the
  // message and refunds the rest.
  function _payNative(uint256 _nativeFee) internal virtual override returns (uint256) {
    if (msg.value < _nativeFee) revert NotEnoughNative(msg.value);
    return msg.value;
  }
}
