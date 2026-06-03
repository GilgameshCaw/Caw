// contracts/CawProfileQuoter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { CawNetworkManager } from "./CawNetworkManager.sol";

struct CawProfileSelectors {
  bytes4 updateOwners;
}

interface ICawProfileForQuoter {
  function networkManager() external view returns (CawNetworkManager);
  function authenticated(uint32 networkId, uint32 tokenId) external view returns (bool);
  function withdrawFeeLocked(uint32 networkId, uint32 tokenId) external view returns (bool);
  function lockedWithdrawFee(uint32 networkId, uint32 tokenId) external view returns (uint256);
  function pendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) external view returns (uint32[] memory, address[] memory, uint64[] memory);
  function peerWithMaxPendingTransfers() external view returns (uint32);
  function mainnetLzId() external view returns (uint32);
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

  // Unified L2 dispatcher selector — matches CawProfileLedger.lzDepositMintSession exactly.
  // Replaces the 6 deleted per-flow selectors (depositAndUpdateOwners, authenticateAndUpdateOwners,
  // mintAndUpdateOwners, mintAuthAndUpdateOwners, depositAndRegisterSessionAndUpdateOwners,
  // mintAuthAndRegisterSessionAndUpdateOwners).
  bytes4 private constant _lzBundleSelector = bytes4(keccak256(
    "lzDepositMintSession(uint32,uint32,uint256,string,address,uint64,uint256,uint64,uint32[],address[],uint64[])"
  ));

  // Remaining single-purpose selectors still present on CawProfileLedger.
  bytes4 private constant _updateOwnersSel  = bytes4(keccak256("updateOwners(uint32[],address[],uint64[])"));
  bytes4 private constant _allowFreeAuthSel = bytes4(keccak256("setAllowFreeAuth(uint32,bool)"));

  constructor(address _cawProfile) {
    cawProfile = ICawProfileForQuoter(_cawProfile);
  }

  /// @dev Returns the updateOwners selector struct (kept for syncTransfer / updateOwner quote paths).
  function _s() private pure returns (CawProfileSelectors memory s) {
    s.updateOwners = _updateOwnersSel;
  }

  function authenticateQuote(uint32 networkId, uint32 tokenId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      _lzBundleSelector, networkId, tokenId, uint256(0), "", address(0), uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
    );

    quote = cawProfile.lzQuote(networkId, _lzBundleSelector, tokenIds.length, payload, lzDestId, payInLzToken);
    quote.nativeFee += cawProfile.networkManager().getAuthFee(networkId) * 2;
    return quote;
  }

  function depositQuote(uint32 networkId, uint32 tokenId, uint256 amount, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      _lzBundleSelector, networkId, tokenId, amount, "", address(0), uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
    );

    quote = cawProfile.lzQuote(networkId, _lzBundleSelector, tokenIds.length, payload, lzDestId, payInLzToken);
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
      _lzBundleSelector, networkId, uint32(0), depositAmount, "", address(0), uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
    );

    MessagingFee memory lz = cawProfile.lzQuote(networkId, _lzBundleSelector, tokenIds.length, payload, lzDestId, payInLzToken);
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
      _lzBundleSelector,
      networkId,
      uint32(0),
      uint256(0),
      "placeholdr",  // ~10-char placeholder username for sizing
      address(0),
      uint64(0),
      uint256(0),
      uint64(0),
      tokenIds,
      owners,
      stamps
    );

    MessagingFee memory lz = cawProfile.lzQuote(networkId, _lzBundleSelector, tokenIds.length, payload, lzDestId, payInLzToken);
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

    bytes memory payload;
    if (sessionKey == address(0)) {
      payload = abi.encodeWithSelector(
        _lzBundleSelector, networkId, uint32(0), depositAmount, "", address(0), uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
      );
    } else {
      payload = abi.encodeWithSelector(
        _lzBundleSelector, networkId, uint32(0), depositAmount, "",
        sessionKey, uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
      );
    }

    MessagingFee memory lz = cawProfile.lzQuote(networkId, _lzBundleSelector, tokenIds.length, payload, lzDestId, payInLzToken);
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

    bytes memory payload;
    if (sessionKey == address(0)) {
      payload = abi.encodeWithSelector(
        _lzBundleSelector, networkId, uint32(0), uint256(0), "placeholdr", address(0), uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
      );
    } else {
      payload = abi.encodeWithSelector(
        _lzBundleSelector, networkId, uint32(0), uint256(0), "placeholdr",
        sessionKey, uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
      );
    }

    MessagingFee memory lz = cawProfile.lzQuote(networkId, _lzBundleSelector, tokenIds.length, payload, lzDestId, payInLzToken);
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
      _lzBundleSelector, cawNetworkId, tokenId, uint256(0), "", address(0), uint64(0), uint256(0), uint64(0), tokenIds, owners, stamps
    );
    MessagingFee memory lz = cawProfile.lzQuote(cawNetworkId, _lzBundleSelector, tokenIds.length, payload, lzDestId, payInLzToken);
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
    CawProfileSelectors memory s = _s();
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;
    uint32 lzDestId = cawProfile.peerWithMaxPendingTransfers();
    (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, address(0), 0);

    if (tokenIds.length == 0) return MessagingFee(0, 0);
    bytes memory payload = abi.encodeWithSelector(
      s.updateOwners, tokenIds, owners, stamps
    );
    // updateOwners isn't bound to a single networkId — use 0 (no override).
    return cawProfile.lzQuote(0, s.updateOwners, tokenIds.length, payload, lzDestId, payInLzToken);
  }

  /// @notice Quote the LZ fee for `CawProfile.broadcastAllowFreeAuth`.
  /// @dev In bypassLZ mode (lzDestId == mainnetLzId) the L2 mirror is updated via a direct call
  ///      (no LZ message), so the quote is zero. On cross-chain deployments the fee covers one
  ///      LZ message to the storage chain with a single SSTORE handler. No ownership-update
  ///      tail is carried by this message, so n=0 is used for gas sizing.
  /// @param networkId The network whose free-auth flag is being propagated.
  /// @param lzDestId The L2 storage chain endpoint ID.
  /// @param payInLzToken True to quote in ZRO token, false for native gas.
  function broadcastAllowFreeAuthQuote(uint32 networkId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    if (lzDestId == cawProfile.mainnetLzId()) return MessagingFee(0, 0);
    // Payload: selector(4) + networkId(32) + allow(32) = 68 bytes. Matches what broadcastAllowFreeAuth sends.
    bytes memory payload = abi.encodeWithSelector(_allowFreeAuthSel, networkId, false);
    return cawProfile.lzQuote(networkId, _allowFreeAuthSel, 0, payload, lzDestId, payInLzToken);
  }

  /**
   * @notice Quote the LZ fee for transferAndSync or syncTransfer to a specific destination.
   * @dev Includes the given tokenId + new owner in the payload alongside any other pending
   *      transfers for that destination. Call with tokenId=0 and newOwner=address(0) to
   *      quote just flushing existing pending transfers. Returns (0,0) if the destination
   *      is mainnet (synchronous bypassLZ path — no LZ message fires) or has no pending updates.
   */
  function syncTransferQuote(uint32 tokenId, address newOwner, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    if (lzDestId == cawProfile.mainnetLzId()) return MessagingFee(0, 0);
    CawProfileSelectors memory s = _s();
    uint32[] memory tokenIds; address[] memory owners; uint64[] memory stamps;

    if (tokenId > 0 && newOwner != address(0)) {
      (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, newOwner, tokenId);
    } else {
      (tokenIds, owners, stamps) = cawProfile.pendingTransferUpdates(lzDestId, address(0), 0);
    }

    if (tokenIds.length == 0) return MessagingFee(0, 0);
    bytes memory payload = abi.encodeWithSelector(
      s.updateOwners, tokenIds, owners, stamps
    );
    // updateOwners isn't bound to a single networkId — use 0 (no override).
    return cawProfile.lzQuote(0, s.updateOwners, tokenIds.length, payload, lzDestId, payInLzToken);
  }

}
