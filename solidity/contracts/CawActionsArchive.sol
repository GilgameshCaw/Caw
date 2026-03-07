// contracts/CawActionsArchive.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

/**
 * @title CawActionsArchive
 * @notice Receives action data from CawActionsReplicator via LayerZero and emits it as events.
 * @dev This contract exists purely for censorship-resistant data preservation.
 *      It does not process or validate actions - it only archives the raw calldata.
 *      Data can be recovered by reading events from this chain if the source becomes unavailable.
 *      Security: LayerZero's peer system ensures only configured peers can send messages.
 */
contract CawActionsArchive is Ownable, OApp {
  /// @notice Emitted when action data is archived
  /// @param sourceChainId The LayerZero endpoint ID of the source chain
  /// @param guid The unique message identifier from LayerZero
  /// @param data The raw action data payload
  event ActionsArchived(uint32 indexed sourceChainId, bytes32 indexed guid, bytes data);

  constructor(address _endpoint) OApp(_endpoint, msg.sender) {}

  /**
   * @notice Receive action data and emit as event
   * @dev Only accepts messages from peers configured via setPeer()
   */
  function _lzReceive(
    Origin calldata _origin,
    bytes32 _guid,
    bytes calldata payload,
    address,
    bytes calldata
  ) internal override {
    emit ActionsArchived(_origin.srcEid, _guid, payload);
  }
}
