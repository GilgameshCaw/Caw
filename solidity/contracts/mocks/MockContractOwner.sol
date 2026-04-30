// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Test helper: a minimal contract that can hold a CawProfile NFT and
///         authorize CawActions via ERC-1271. The contract recovers the EOA
///         signer from a standard ECDSA signature and checks it against an
///         authorized signer set by the deployer. Returns 0x1626ba7e on a
///         match and 0xffffffff otherwise.
contract MockContractOwner is IERC721Receiver {
  bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;
  bytes4 internal constant INVALID_VALUE = 0xffffffff;

  address public authorizedSigner;
  bool public alwaysReject;

  constructor(address _authorizedSigner) {
    authorizedSigner = _authorizedSigner;
  }

  function setAuthorizedSigner(address signer) external {
    authorizedSigner = signer;
  }

  function setAlwaysReject(bool reject) external {
    alwaysReject = reject;
  }

  /// @notice ERC-1271 isValidSignature: recovers an ECDSA signer from `hash`
  ///         and `signature` (r,s,v packed) and matches against authorizedSigner.
  function isValidSignature(bytes32 hash, bytes memory signature)
    external view returns (bytes4)
  {
    if (alwaysReject) return INVALID_VALUE;
    if (signature.length != 65) return INVALID_VALUE;

    bytes32 r;
    bytes32 s;
    uint8 v;
    assembly {
      r := mload(add(signature, 32))
      s := mload(add(signature, 64))
      v := byte(0, mload(add(signature, 96)))
    }

    address recovered = ecrecover(hash, v, r, s);
    if (recovered != address(0) && recovered == authorizedSigner) {
      return MAGIC_VALUE;
    }
    return INVALID_VALUE;
  }

  function onERC721Received(address, address, uint256, bytes calldata)
    external pure override returns (bytes4)
  {
    return IERC721Receiver.onERC721Received.selector;
  }
}
