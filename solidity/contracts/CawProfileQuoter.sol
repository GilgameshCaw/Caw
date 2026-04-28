// contracts/CawProfileQuoter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { CawClientManager } from "./CawClientManager.sol";

interface ICawProfileForQuoter {
  function clientManager() external view returns (CawClientManager);
  function authenticated(uint32 clientId, uint32 tokenId) external view returns (bool);
  function withdrawFeeLocked(uint32 clientId, uint32 tokenId) external view returns (bool);
  function lockedWithdrawFee(uint32 clientId, uint32 tokenId) external view returns (uint256);
  function pendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) external view returns (uint32[] memory, address[] memory);
  function pendingTransferUpdates(uint32 lzDestId) external view returns (uint32[] memory, address[] memory);
  function peerWithMaxPendingTransfers() external view returns (uint32);
  function addToBalanceSelector() external view returns (bytes4);
  function mintSelector() external view returns (bytes4);
  function mintAuthSelector() external view returns (bytes4);
  function mainnetLzId() external view returns (uint32);
  function updateOwnersSelector() external view returns (bytes4);
  function authSelector() external view returns (bytes4);
  function lzQuote(bytes4 selector, uint256 n, bytes memory payload, uint32 lzDestId, bool _payInLzToken) external view returns (MessagingFee memory quote);
}

/**
 * @title CawProfileQuoter
 * @notice Separate contract for CawProfile quote functions to reduce main contract size
 * @dev All functions are view-only and read from the main CawProfile contract
 */
contract CawProfileQuoter {
  using OptionsBuilder for bytes;

  ICawProfileForQuoter public immutable cawProfile;

  constructor(address _cawProfile) {
    cawProfile = ICawProfileForQuoter(_cawProfile);
  }

  function authenticateQuote(uint32 clientId, uint32 tokenId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      cawProfile.authSelector(), clientId, tokenId, tokenIds, owners
    );

    quote = cawProfile.lzQuote(cawProfile.authSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += cawProfile.clientManager().getAuthFee(clientId) * 2;
    return quote;
  }

  function depositQuote(uint32 clientId, uint32 tokenId, uint256 amount, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      cawProfile.addToBalanceSelector(), clientId, tokenId, amount, tokenIds, owners
    );

    quote = cawProfile.lzQuote(cawProfile.addToBalanceSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += cawProfile.clientManager().getDepositFee(clientId) * 2;

    if (!cawProfile.authenticated(clientId, tokenId))
      quote.nativeFee += cawProfile.clientManager().getAuthFee(clientId) * 2;

    return quote;
  }

  function mintQuote(uint32 clientId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    quote = updateOwnerQuote(payInLzToken);
    quote.nativeFee += cawProfile.clientManager().getMintFee(clientId) * 2;
    return quote;
  }

  function mintAndDepositQuote(uint32 clientId, uint256 depositAmount, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    // Use the same pattern as depositQuote — include a placeholder owner in the payload
    // so the LZ quote estimates gas for a realistic payload size
    uint32[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, 0);

    bytes memory payload = abi.encodeWithSelector(
      cawProfile.addToBalanceSelector(), clientId, uint32(0), depositAmount, tokenIds, owners
    );

    quote = cawProfile.lzQuote(cawProfile.addToBalanceSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    // Mint fee + deposit fee + auth fee (new user always needs auth)
    quote.nativeFee += cawProfile.clientManager().getMintFee(clientId) * 2;
    quote.nativeFee += cawProfile.clientManager().getDepositFee(clientId) * 2;
    quote.nativeFee += cawProfile.clientManager().getAuthFee(clientId) * 2;
    return quote;
  }

  function mintAndAuthQuote(uint32 clientId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    // Storage-fee leg: mint + auth (the deposit fee is intentionally skipped).
    quote.nativeFee = cawProfile.clientManager().getMintFee(clientId) * 2
                    + cawProfile.clientManager().getAuthFee(clientId) * 2;

    // LZ leg: only needed when the storage chain is a true L2 peer. In bypassLZ
    // (lzDestId == mainnetLzId) the L2 mirror is updated via a direct call, so
    // there's no LayerZero send and no LZ fee. (mintAndDepositQuote has the
    // same gap today; this version short-circuits explicitly so the L1-storage
    // path doesn't revert with NoPeer.)
    if (lzDestId == cawProfile.mainnetLzId()) return quote;

    uint32[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, 0);

    bytes memory payload = abi.encodeWithSelector(
      cawProfile.mintAuthSelector(),
      clientId,
      uint32(0),
      msg.sender,
      "placeholdr",  // ~10-char placeholder username for sizing
      tokenIds,
      owners
    );

    MessagingFee memory lz = cawProfile.lzQuote(cawProfile.mintAuthSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += lz.nativeFee;
    quote.lzTokenFee += lz.lzTokenFee;
    return quote;
  }

  function withdrawQuote(uint32 clientId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    quote = updateOwnerQuote(payInLzToken);
    quote.nativeFee += cawProfile.clientManager().getWithdrawFee(clientId) * 2;
    return quote;
  }

  /// @notice Returns the effective withdraw fee for a specific token, accounting for the locked-in
  ///         rate if one exists. Use this for accurate quotes — `withdrawQuote(clientId)` returns
  ///         the current client fee without considering the lock.
  /// @return The lower of (current client fee, locked-in fee for this token), in wei
  function effectiveWithdrawFee(uint32 clientId, uint32 tokenId) public view returns (uint256) {
    uint256 current = cawProfile.clientManager().getWithdrawFee(clientId);
    if (cawProfile.withdrawFeeLocked(clientId, tokenId)) {
      uint256 locked = cawProfile.lockedWithdrawFee(clientId, tokenId);
      if (locked < current) return locked;
    }
    return current;
  }

  function updateOwnerQuote(bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners;
    uint32 lzDestId = cawProfile.peerWithMaxPendingTransfers();
    (tokenIds, owners) = cawProfile.pendingTransferUpdates(lzDestId);

    if (tokenIds.length == 0) return MessagingFee(0, 0);
    bytes memory payload = abi.encodeWithSelector(
      cawProfile.updateOwnersSelector(), tokenIds, owners
    );
    return cawProfile.lzQuote(cawProfile.updateOwnersSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
  }

  /**
   * @notice Quote the LZ fee for transferAndSync or syncTransfer.
   * @dev Includes the given tokenId + new owner in the payload alongside any other pending transfers.
   *      Call with tokenId=0 and newOwner=address(0) to quote just flushing existing pending transfers.
   */
  function syncTransferQuote(uint32 tokenId, address newOwner, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32 lzDestId = cawProfile.peerWithMaxPendingTransfers();
    uint32[] memory tokenIds; address[] memory owners;

    if (tokenId > 0 && newOwner != address(0)) {
      (tokenIds, owners) = cawProfile.pendingTransferUpdates(lzDestId, newOwner, tokenId);
    } else {
      (tokenIds, owners) = cawProfile.pendingTransferUpdates(lzDestId);
    }

    if (tokenIds.length == 0) return MessagingFee(0, 0);
    bytes memory payload = abi.encodeWithSelector(
      cawProfile.updateOwnersSelector(), tokenIds, owners
    );
    return cawProfile.lzQuote(cawProfile.updateOwnersSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
  }

}
