// contracts/CawNameQuoter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { CawClientManager } from "./CawClientManager.sol";

interface ICawNameForQuoter {
  function clientManager() external view returns (CawClientManager);
  function authenticated(uint32 clientId, uint32 tokenId) external view returns (bool);
  function pendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) external view returns (uint32[] memory, address[] memory);
  function pendingTransferUpdates(uint32 lzDestId) external view returns (uint32[] memory, address[] memory);
  function peerWithMaxPendingTransfers() external view returns (uint32);
  function addToBalanceSelector() external view returns (bytes4);
  function mintSelector() external view returns (bytes4);
  function updateOwnersSelector() external view returns (bytes4);
  function authSelector() external view returns (bytes4);
  function setReplicationPeerSelector() external view returns (bytes4);
  function lzQuote(bytes4 selector, bytes memory payload, uint32 lzDestId, bool _payInLzToken) external view returns (MessagingFee memory quote);
}

/**
 * @title CawNameQuoter
 * @notice Separate contract for CawName quote functions to reduce main contract size
 * @dev All functions are view-only and read from the main CawName contract
 */
contract CawNameQuoter {
  using OptionsBuilder for bytes;

  ICawNameForQuoter public immutable cawName;

  constructor(address _cawName) {
    cawName = ICawNameForQuoter(_cawName);
  }

  function authenticateQuote(uint32 clientId, uint32 tokenId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = cawName.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      cawName.authSelector(), clientId, tokenId, tokenIds, owners
    );

    quote = cawName.lzQuote(cawName.authSelector(), payload, lzDestId, payInLzToken);
    quote.nativeFee += cawName.clientManager().getAuthFee(clientId) * 2;
    return quote;
  }

  function depositQuote(uint32 clientId, uint32 tokenId, uint256 amount, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = cawName.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      cawName.addToBalanceSelector(), clientId, tokenId, amount, tokenIds, owners
    );

    quote = cawName.lzQuote(cawName.addToBalanceSelector(), payload, lzDestId, payInLzToken);
    quote.nativeFee += cawName.clientManager().getDepositFee(clientId) * 2;

    if (!cawName.authenticated(clientId, tokenId))
      quote.nativeFee += cawName.clientManager().getAuthFee(clientId) * 2;

    return quote;
  }

  function mintQuote(uint32 clientId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    quote = updateOwnerQuote(payInLzToken);
    quote.nativeFee += cawName.clientManager().getMintFee(clientId) * 2;
    return quote;
  }

  function withdrawQuote(uint32 clientId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    quote = updateOwnerQuote(payInLzToken);
    quote.nativeFee += cawName.clientManager().getWithdrawFee(clientId) * 2;
    return quote;
  }

  function updateOwnerQuote(bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners;
    uint32 lzDestId = cawName.peerWithMaxPendingTransfers();
    (tokenIds, owners) = cawName.pendingTransferUpdates(lzDestId);

    if (tokenIds.length == 0) return MessagingFee(0, 0);
    bytes memory payload = abi.encodeWithSelector(
      cawName.updateOwnersSelector(), tokenIds, owners
    );
    return cawName.lzQuote(cawName.updateOwnersSelector(), payload, lzDestId, payInLzToken);
  }

  function syncReplicationQuote(uint32 clientId, uint32 archiveEid, address target, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory payload = abi.encodeWithSelector(cawName.setReplicationPeerSelector(), clientId, archiveEid, target);
    return cawName.lzQuote(cawName.setReplicationPeerSelector(), payload, lzDestId, payInLzToken);
  }

}
