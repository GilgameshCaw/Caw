// contracts/CawProfileQuoter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { CawNetworkManager } from "./CawNetworkManager.sol";

interface ICawProfileForQuoter {
  function networkManager() external view returns (CawNetworkManager);
  function authenticated(uint32 networkId, uint32 tokenId) external view returns (bool);
  function withdrawFeeLocked(uint32 networkId, uint32 tokenId) external view returns (bool);
  function lockedWithdrawFee(uint32 networkId, uint32 tokenId) external view returns (uint256);
  function pendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) external view returns (uint32[] memory, address[] memory, uint64[] memory);
  function pendingTransferUpdates(uint32 lzDestId) external view returns (uint32[] memory, address[] memory, uint64[] memory);
  function peerWithMaxPendingTransfers() external view returns (uint32);
  function addToBalanceSelector() external view returns (bytes4);
  function mintSelector() external view returns (bytes4);
  function mintAuthSelector() external view returns (bytes4);
  function depositRegisterSessionSelector() external view returns (bytes4);
  function mintAuthRegisterSessionSelector() external view returns (bytes4);
  function mainnetLzId() external view returns (uint32);
  function updateOwnersSelector() external view returns (bytes4);
  function authSelector() external view returns (bytes4);
  function lzQuote(uint32 cawNetworkId, bytes4 selector, uint256 n, bytes memory payload, uint32 lzDestId, bool _payInLzToken) external view returns (MessagingFee memory quote);
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

  function authenticateQuote(uint32 networkId, uint32 tokenId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      cawProfile.authSelector(), networkId, tokenId, tokenIds, owners, stamps
    );

    quote = cawProfile.lzQuote(networkId, cawProfile.authSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += cawProfile.networkManager().getAuthFee(networkId) * 2;
    return quote;
  }

  function depositQuote(uint32 networkId, uint32 tokenId, uint256 amount, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      cawProfile.addToBalanceSelector(), networkId, tokenId, amount, tokenIds, owners, stamps
    );

    quote = cawProfile.lzQuote(networkId, cawProfile.addToBalanceSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += cawProfile.networkManager().getDepositFee(networkId) * 2;

    if (!cawProfile.authenticated(networkId, tokenId))
      quote.nativeFee += cawProfile.networkManager().getAuthFee(networkId) * 2;

    return quote;
  }

  function mintQuote(uint32 networkId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    quote = updateOwnerQuote(payInLzToken);
    quote.nativeFee += cawProfile.networkManager().getMintFee(networkId) * 2;
    return quote;
  }

  function mintAndDepositQuote(uint32 networkId, uint256 depositAmount, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    // Storage-fee leg: mint + deposit + auth (new user always needs auth).
    quote.nativeFee = cawProfile.networkManager().getMintFee(networkId) * 2
                    + cawProfile.networkManager().getDepositFee(networkId) * 2
                    + cawProfile.networkManager().getAuthFee(networkId) * 2;

    // LZ leg: only needed for true L2-storage networks. In bypassLZ
    // (lzDestId == mainnetLzId) the L2 mirror is updated via a direct call.
    if (lzDestId == cawProfile.mainnetLzId()) return quote;

    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, 0);

    bytes memory payload = abi.encodeWithSelector(
      cawProfile.addToBalanceSelector(), networkId, uint32(0), depositAmount, tokenIds, owners, stamps
    );

    MessagingFee memory lz = cawProfile.lzQuote(networkId, cawProfile.addToBalanceSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += lz.nativeFee;
    quote.lzTokenFee += lz.lzTokenFee;
    return quote;
  }

  function mintAndAuthQuote(uint32 networkId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    // Storage-fee leg: mint + auth (the deposit fee is intentionally skipped).
    quote.nativeFee = cawProfile.networkManager().getMintFee(networkId) * 2
                    + cawProfile.networkManager().getAuthFee(networkId) * 2;

    // LZ leg: only needed when the storage chain is a true L2 peer. In bypassLZ
    // (lzDestId == mainnetLzId) the L2 mirror is updated via a direct call, so
    // there's no LayerZero send and no LZ fee. (mintAndDepositQuote has the
    // same gap today; this version short-circuits explicitly so the L1-storage
    // path doesn't revert with NoPeer.)
    if (lzDestId == cawProfile.mainnetLzId()) return quote;

    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, 0);

    bytes memory payload = abi.encodeWithSelector(
      cawProfile.mintAuthSelector(),
      networkId,
      uint32(0),
      msg.sender,
      "placeholdr",  // ~10-char placeholder username for sizing
      tokenIds,
      owners,
      stamps
    );

    MessagingFee memory lz = cawProfile.lzQuote(networkId, cawProfile.mintAuthSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += lz.nativeFee;
    quote.lzTokenFee += lz.lzTokenFee;
    return quote;
  }

  /// @notice Quote the bundled mint+deposit+auth+quicksign flow.
  /// @dev When `sessionKey == address(0)`, falls through to mintAndDepositQuote (no session leg).
  ///      When `lzDestId == mainnetLzId` (bypassLZ), there's no LZ fee — just storage fees.
  function mintAndDepositAndQuickSignQuote(
    uint32 networkId, uint256 depositAmount, uint32 lzDestId, bool payInLzToken,
    address sessionKey
  ) public view returns (MessagingFee memory quote) {
    // Storage fees (mint + deposit + auth) — same as mintAndDepositQuote.
    quote.nativeFee = cawProfile.networkManager().getMintFee(networkId) * 2
                    + cawProfile.networkManager().getDepositFee(networkId) * 2
                    + cawProfile.networkManager().getAuthFee(networkId) * 2;

    if (lzDestId == cawProfile.mainnetLzId()) return quote;

    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, 0);

    bytes4 selector;
    bytes memory payload;
    if (sessionKey == address(0)) {
      selector = cawProfile.addToBalanceSelector();
      payload = abi.encodeWithSelector(
        selector, networkId, uint32(0), depositAmount, tokenIds, owners, stamps
      );
    } else {
      selector = cawProfile.depositRegisterSessionSelector();
      payload = abi.encodeWithSelector(
        selector, networkId, uint32(0), depositAmount, msg.sender,
        sessionKey, uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
      );
    }

    MessagingFee memory lz = cawProfile.lzQuote(networkId, selector, tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += lz.nativeFee;
    quote.lzTokenFee += lz.lzTokenFee;
    return quote;
  }

  /// @notice Quote the bundled mint+auth+quicksign flow (no deposit).
  /// @dev When `sessionKey == address(0)`, falls through to mintAndAuthQuote (no session leg).
  ///      When `lzDestId == mainnetLzId` (bypassLZ), there's no LZ fee — just storage fees.
  function mintAndAuthAndQuickSignQuote(
    uint32 networkId, uint32 lzDestId, bool payInLzToken,
    address sessionKey
  ) public view returns (MessagingFee memory quote) {
    quote.nativeFee = cawProfile.networkManager().getMintFee(networkId) * 2
                    + cawProfile.networkManager().getAuthFee(networkId) * 2;

    if (lzDestId == cawProfile.mainnetLzId()) return quote;

    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, 0);

    bytes4 selector;
    bytes memory payload;
    if (sessionKey == address(0)) {
      selector = cawProfile.mintAuthSelector();
      payload = abi.encodeWithSelector(
        selector, networkId, uint32(0), msg.sender, "placeholdr", tokenIds, owners, stamps
      );
    } else {
      selector = cawProfile.mintAuthRegisterSessionSelector();
      payload = abi.encodeWithSelector(
        selector, networkId, uint32(0), msg.sender, "placeholdr",
        sessionKey, uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
      );
    }

    MessagingFee memory lz = cawProfile.lzQuote(networkId, selector, tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += lz.nativeFee;
    quote.lzTokenFee += lz.lzTokenFee;
    return quote;
  }

  // ============================================
  // ZAP QUOTES — pay-with-ETH variants of deposit / mintAndDeposit /
  //              mintAndDepositAndQuickSign
  // ============================================
  // The on-chain LZ + storage fees for a ZAP are identical to its CAW-paid
  // sibling — the swap leg is a frontend concern (read pool reserves,
  // compute minCawOut). We expose `*ZapQuote` thin wrappers so the
  // frontend can call ONE quoter function and not worry about which
  // selector/payload to pass. Critically, the mint zap quotes drop the
  // `depositAmount` argument because the swap output (and therefore the
  // deposit) is unknown until the tx settles; we use a placeholder value
  // for LZ payload sizing only.

  function depositZapQuote(uint32 cawNetworkId, uint32 tokenId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    // Storage fees: deposit + auth (auth only if not yet authenticated).
    quote.nativeFee = cawProfile.networkManager().getDepositFee(cawNetworkId) * 2;
    if (!cawProfile.authenticated(cawNetworkId, tokenId))
      quote.nativeFee += cawProfile.networkManager().getAuthFee(cawNetworkId) * 2;

    // bypassLZ: no LZ leg, just storage fees. Mirrors the mintAndDeposit
    // short-circuit added in 48e37cb.
    if (lzDestId == cawProfile.mainnetLzId()) return quote;

    // Cross-chain (true L2 storage): include the LZ messaging cost.
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    // Use 0 as placeholder for `amount` — it doesn't affect LZ payload size.
    bytes memory payload = abi.encodeWithSelector(
      cawProfile.addToBalanceSelector(), cawNetworkId, tokenId, uint256(0), tokenIds, owners, stamps
    );
    MessagingFee memory lz = cawProfile.lzQuote(cawNetworkId, cawProfile.addToBalanceSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += lz.nativeFee;
    quote.lzTokenFee += lz.lzTokenFee;
    return quote;
  }

  function mintAndDepositZapQuote(uint32 networkId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    return mintAndDepositQuote(networkId, 0, lzDestId, payInLzToken);
  }

  function mintAndDepositAndQuickSignZapQuote(uint32 networkId, address sessionKey, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    return mintAndDepositAndQuickSignQuote(networkId, 0, lzDestId, payInLzToken, sessionKey);
  }

  function withdrawQuote(uint32 networkId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    quote = updateOwnerQuote(payInLzToken);
    quote.nativeFee += cawProfile.networkManager().getWithdrawFee(networkId) * 2;
    return quote;
  }

  /// @notice Returns the effective withdraw fee for a specific token, accounting for the locked-in
  ///         rate if one exists. Use this for accurate quotes — `withdrawQuote(networkId)` returns
  ///         the current network fee without considering the lock.
  /// @return The lower of (current network fee, locked-in fee for this token), in wei
  function effectiveWithdrawFee(uint32 networkId, uint32 tokenId) public view returns (uint256) {
    uint256 current = cawProfile.networkManager().getWithdrawFee(networkId);
    if (cawProfile.withdrawFeeLocked(networkId, tokenId)) {
      uint256 locked = cawProfile.lockedWithdrawFee(networkId, tokenId);
      if (locked < current) return locked;
    }
    return current;
  }

  function updateOwnerQuote(bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    uint32 lzDestId = cawProfile.peerWithMaxPendingTransfers();
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId);

    if (tokenIds.length == 0) return MessagingFee(0, 0);
    bytes memory payload = abi.encodeWithSelector(
      cawProfile.updateOwnersSelector(), tokenIds, owners, stamps
    );
    // updateOwners isn't bound to a single networkId — use 0 (no override).
    return cawProfile.lzQuote(0, cawProfile.updateOwnersSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
  }

  /**
   * @notice Quote the LZ fee for transferAndSync or syncTransfer.
   * @dev Includes the given tokenId + new owner in the payload alongside any other pending transfers.
   *      Call with tokenId=0 and newOwner=address(0) to quote just flushing existing pending transfers.
   */
  function syncTransferQuote(uint32 tokenId, address newOwner, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32 lzDestId = cawProfile.peerWithMaxPendingTransfers();
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;

    if (tokenId > 0 && newOwner != address(0)) {
      (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, newOwner, tokenId);
    } else {
      (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId);
    }

    if (tokenIds.length == 0) return MessagingFee(0, 0);
    bytes memory payload = abi.encodeWithSelector(
      cawProfile.updateOwnersSelector(), tokenIds, owners, stamps
    );
    // updateOwners isn't bound to a single networkId — use 0 (no override).
    return cawProfile.lzQuote(0, cawProfile.updateOwnersSelector(), tokenIds.length, payload, lzDestId, payInLzToken);
  }

}
