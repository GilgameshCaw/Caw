// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "./CawActionVerifier.sol";

/// @title CawTipResponder
///
/// @notice Example contract that "reacts" to a tip-bearing action sent to its
///         own CAW profile, trustlessly. The pattern:
///
///         1. The contract owns a CAW profile (NFT transferred in).
///         2. A user posts an action (caw, tip, etc.) directed at this
///            profile, including an `::echo:msg::` marker in the text.
///         3. A watcher (could be the user themselves, the contract owner,
///            or anyone) calls `fulfill()` with the checkpoint slice that
///            contains the action.
///         4. The contract uses `CawActionVerifier` to prove the action is
///            canonical, then emits `Echoed(senderId, msg)`.
///
///         The verifier check is what makes this trustless: a watcher
///         cannot forge an action, because the slice they submit must fold
///         to the on-chain canonical hash. No bonds, no challenge window.
///
/// @dev    This is intentionally minimal — the "react" step just emits an
///         event. Real responders (DEX-via-tips, function-via-text, prediction
///         markets) would do meaningful work here: transfer ERC-20s, update
///         pools, etc. The verification pattern is identical.
contract CawTipResponder is IERC721Receiver {
  CawActionVerifier public immutable verifier;
  uint32 public immutable expectedNetworkId;

  /// @dev Anti-replay: a given (networkId, checkpointId, targetIndex) action
  ///      can only be fulfilled once.
  mapping(uint256 => bool) public fulfilled;

  event Echoed(uint32 indexed senderId, uint32 indexed receiverId, bytes message);

  constructor(address _verifier, uint32 _expectedNetworkId) {
    verifier = CawActionVerifier(_verifier);
    expectedNetworkId = _expectedNetworkId;
  }

  /// @notice CawProfile.transferAndSync uses plain _transfer (not _safeTransfer)
  ///         so this won't fire on that path. Don't put init logic here.
  function onERC721Received(address, address, uint256, bytes calldata)
    external pure override returns (bytes4)
  {
    return IERC721Receiver.onERC721Received.selector;
  }

  /// @notice Fulfill an action by proving it exists in the canonical hash
  ///         chain. Anyone can call this — the verifier check provides the
  ///         trust. The action's text is parsed for an `::echo:msg::` marker;
  ///         if found, `Echoed` is emitted.
  ///
  /// @param  checkpointId    1-indexed checkpoint containing the action.
  /// @param  packedActions   The 32 packed-action slices in this checkpoint.
  /// @param  rValues         The 32 per-action `r` anchors.
  /// @param  targetIndex     Which action (0-31) to fulfill.
  function fulfill(
    uint256 checkpointId,
    bytes[] calldata packedActions,
    bytes32[] calldata rValues,
    uint256 targetIndex
  ) external {
    uint256 fulfillKey = uint256(keccak256(
      abi.encodePacked(expectedNetworkId, checkpointId, targetIndex)
    ));
    require(!fulfilled[fulfillKey], "Already fulfilled");

    bytes memory action = verifier.verifyAndExtract(
      expectedNetworkId, checkpointId, packedActions, rValues, targetIndex
    );

    (uint32 senderId, uint32 receiverId, bytes memory text) = _readKeyFields(action);

    bytes memory echoed = _extractEchoMarker(text);
    if (echoed.length > 0) {
      fulfilled[fulfillKey] = true;
      emit Echoed(senderId, receiverId, echoed);
    }
  }

  // ============================================
  // Packed action reader
  // ============================================

  /// @dev Walks the packed-action layout (see CawActions.sol PACKED FORMAT)
  ///      to extract the fields this example cares about. We only read
  ///      senderId, receiverId, and text — recipients/amounts are skipped.
  function _readKeyFields(bytes memory action)
    internal pure returns (uint32 senderId, uint32 receiverId, bytes memory text)
  {
    require(action.length >= 23, "Action too short");

    uint256 rc;
    uint256 ac;
    assembly {
      // bytes memory layout: first 32 bytes is length, then data
      let dataPtr := add(action, 0x20)
      let w := mload(dataPtr)
      // actionType: bits [255..248] (skipped — we don't care)
      // senderId: bits [247..216]
      senderId := and(shr(216, w), 0xFFFFFFFF)
      // receiverId: bits [215..184]
      receiverId := and(shr(184, w), 0xFFFFFFFF)
      // (skip receiverCawonce, networkId, cawonce — 12 bytes)
      // rc: bits [87..80]
      rc := and(shr(80, w), 0xFF)
      // ac: bits [79..72]
      ac := and(shr(72, w), 0xFF)
    }

    uint256 pos = 23 + (rc * 4) + (ac * 8);
    require(action.length >= pos + 2, "Truncated before text length");

    uint256 textLen;
    assembly {
      let dataPtr := add(action, 0x20)
      textLen := shr(240, mload(add(dataPtr, pos)))
    }
    pos += 2;

    require(action.length >= pos + textLen, "Truncated text");

    // Copy the text bytes out into a fresh memory slice.
    text = new bytes(textLen);
    for (uint256 i = 0; i < textLen; i++) {
      text[i] = action[pos + i];
    }
  }

  // ============================================
  // ::echo:msg:: marker extraction
  // ============================================

  /// @dev Looks for an `::echo:<msg>::` substring at the START of `text`.
  ///      Returns the inner `<msg>` bytes, or empty if not present.
  ///      Real responders would use a more flexible parser; this is enough
  ///      to demonstrate the pattern.
  function _extractEchoMarker(bytes memory text) internal pure returns (bytes memory) {
    // Need at least "::echo:::" = 9 bytes
    if (text.length < 9) return bytes("");

    // Prefix must be "::echo:"
    if (
      text[0] != ':' || text[1] != ':' ||
      text[2] != 'e' || text[3] != 'c' || text[4] != 'h' || text[5] != 'o' ||
      text[6] != ':'
    ) {
      return bytes("");
    }

    // Find the closing "::" starting at position 7
    uint256 end = type(uint256).max;
    for (uint256 i = 7; i + 1 < text.length; i++) {
      if (text[i] == ':' && text[i + 1] == ':') {
        end = i;
        break;
      }
    }
    if (end == type(uint256).max) return bytes("");

    bytes memory result = new bytes(end - 7);
    for (uint256 i = 0; i < end - 7; i++) {
      result[i] = text[7 + i];
    }
    return result;
  }
}
