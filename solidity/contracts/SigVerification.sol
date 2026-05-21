// contracts/SigVerification.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title SigVerification
/// @notice External library for signature verification with ERC-1271 fallback.
///         Extracted to keep `CawProfileL2` under the EIP-170 24,576-byte
///         deployed-bytecode limit. Functions are `external` so they live in
///         the library's own deployed bytecode — the consuming contract only
///         carries a small delegatecall stub (~50 bytes per linked function).
///
///         Mirrors the bounded-staticcall pattern used by
///         `CawActions._checkERC1271`. A future refactor can consolidate that
///         one here too; out of scope for the v1 ERC-1271 session-registration
///         change.
///
/// @dev Audit-trail tags in this contract (e.g. "H-N", "M-N", "Round N",
///      "Audit fix YYYY-MM-DD") are decoded in `docs/AUDIT_TRAIL.md`.
library SigVerification {

  /// @dev Forwarded to malicious / buggy 1271 contracts so they can't drain the
  ///      relaying caller. OOG inside the staticcall surfaces as `false`,
  ///      identical to a 1271 reject.
  uint256 internal constant ERC1271_GAS_LIMIT = 50_000;

  /// @dev EIP-1271 magic-value: `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`.
  bytes4  internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

  /// @dev Returns true iff `signature` proves `claimedSigner` authorized
  ///      `digest`. ECDSA fast path first for 65-byte sigs (covers plain
  ///      EOAs and ECDSA-wrapped smart accounts); ERC-1271 fallback for
  ///      contract-owned addresses (Safe, 7702-delegated EOAs with non-ECDSA
  ///      signers like passkeys, etc.).
  ///
  ///      For the 65-byte case we try BOTH `r||s||v` and `v||r||s` packings.
  ///      Most production wallets use `r||s||v` (OpenZeppelin's EIP-712
  ///      helpers, ethers.js's `Signature.serialized`), but some older
  ///      signers and a few hardware wallets emit `v||r||s`. Accepting both
  ///      is one extra ecrecover on miss — cheap relative to the ~3000-gas
  ///      baseline — and avoids forcing callers to commit to one packing.
  ///
  ///      Empty `signature` => false. Non-65-byte sigs skip ecrecover and go
  ///      straight to 1271. EOAs (no code) that don't match ecrecover return
  ///      false; caller's revert keeps the error surface consistent.
  ///
  ///      `internal` so the implementation inlines — no library link step
  ///      needed in tests/deploys. Size pressure on CawProfileL2 is managed
  ///      by other reductions (dropping legacy (v,r,s) overloads, replacing
  ///      added require-strings with 4-byte custom errors).
  function recoverOrValidate(
    address claimedSigner,
    bytes32 digest,
    bytes calldata signature
  ) internal view returns (bool) {
    if (signature.length == 65) {
      // Try r||s||v packing first (most common).
      bytes32 r = bytes32(signature[0:32]);
      bytes32 s = bytes32(signature[32:64]);
      uint8   v = uint8(signature[64]);
      address recovered = ecrecover(digest, v, r, s);
      if (recovered != address(0) && recovered == claimedSigner) return true;

      // Try v||r||s packing (some older signers).
      v = uint8(signature[0]);
      r = bytes32(signature[1:33]);
      s = bytes32(signature[33:65]);
      recovered = ecrecover(digest, v, r, s);
      if (recovered != address(0) && recovered == claimedSigner) return true;

      // Fall through to 1271 only if the claimed signer has code — a
      // non-matching ecrecover against an EOA is just a bad sig.
    }

    if (claimedSigner.code.length > 0) {
      (bool ok, bytes memory ret) = claimedSigner.staticcall{gas: ERC1271_GAS_LIMIT}(
        abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature)
      );
      return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC_VALUE;
    }

    return false;
  }
}
