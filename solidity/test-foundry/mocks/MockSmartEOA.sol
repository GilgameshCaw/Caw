// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal delegate contract used by the EIP7702Bootstrap foundry test.
///         This is NOT the production SmartEOA implementation — it is a test
///         stand-in that exercises the single-tx EIP-7702 bundling flow described
///         in §5 of plan-smart-eoa-passkey-sponsorship.md.
///
/// @dev Key properties that mirror the real SmartEOA design:
///      - initialize() is payable and one-shot (re-call reverts).
///      - initialize() stores pubkey coordinates and ecdsaFallback, then calls
///        out to the minter in the same tx, forwarding all msg.value.
///      - isValidSignature() returns 0x1626ba7e unconditionally for any input
///        (no real P-256 verification needed to prove the call-pattern flow).
///      - All state lives in the EOA's storage slots — standard 7702 semantics.

interface IMockMinter {
    function mintAndDepositSponsored(address recipient, bytes calldata sig) external payable;
}

contract MockSmartEOA {
    // ---------------------------------------------------------------
    // Storage slots
    // NOTE: When a type-0x04 tx delegates an EOA to this implementation,
    //       these storage slots live in the EOA's own storage, not in this
    //       contract's storage. Each user has their own isolated state.
    // ---------------------------------------------------------------

    /// @dev Slot 0: initialization guard.
    ///      Using a bool wastes only 1 byte of the slot; the rest is unused.
    bool private _initialized;

    /// @dev Slots 1-2: passkey public key (P-256 coordinates).
    bytes32 private _pubkeyX;
    bytes32 private _pubkeyY;

    /// @dev Slot 3: ECDSA fallback — the user's secp256k1 address.
    address private _ecdsaFallback;

    // ---------------------------------------------------------------
    // ERC-1271 magic constant
    // ---------------------------------------------------------------

    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    // ---------------------------------------------------------------
    // External API
    // ---------------------------------------------------------------

    /// @notice One-shot initialization.  Must be called in the same type-0x04
    ///         transaction that sets the delegation, so that the EOA starts life
    ///         in a fully-initialized state with no window between delegation and
    ///         initialization.
    ///
    ///         The function is payable: the sponsor bundles ETH for the downstream
    ///         mintAndDepositSponsored call through this same tx.  All msg.value is
    ///         forwarded to the minter as the final step.
    ///
    /// @param pubkeyX      P-256 public key X coordinate (WebAuthn passkey).
    /// @param pubkeyY      P-256 public key Y coordinate (WebAuthn passkey).
    /// @param ecdsaFallback secp256k1 address held in the user's encrypted backup.
    /// @param minter       Address of the CawProfileMinter (or MockMinter in tests).
    function initialize(
        bytes32 pubkeyX,
        bytes32 pubkeyY,
        address ecdsaFallback,
        address minter
    ) external payable {
        require(!_initialized, "MockSmartEOA: already initialized");
        _initialized = true;
        _pubkeyX = pubkeyX;
        _pubkeyY = pubkeyY;
        _ecdsaFallback = ecdsaFallback;

        // Final step of the single-tx bundle: call the minter, forwarding all
        // ETH the sponsor attached to the transaction.  In production this calls
        // CawProfileMinter.mintAndDepositSponsored which mints the profile NFT
        // and deposits CAW tokens in one shot.
        //
        // The minter will staticcall back to address(this).isValidSignature() to
        // verify the permit sig — which is what this test proves works inside a
        // single tx's execution frame.
        bytes memory dummySig = abi.encode(bytes32(0));
        IMockMinter(minter).mintAndDepositSponsored{value: msg.value}(address(this), dummySig);
    }

    /// @notice ERC-1271 signature verification entry point.
    ///         In production this dispatches between WebAuthn P-256 verification
    ///         and secp256k1 ecrecover (65-byte sig path).
    ///
    ///         In this mock we return the magic value unconditionally — the goal
    ///         of the bootstrap test is to prove the CALL PATTERN works inside a
    ///         single tx, not to test real signature math.
    ///
    /// @return 0x1626ba7e always.
    function isValidSignature(bytes32 /*digest*/, bytes calldata /*sig*/)
        external
        pure
        returns (bytes4)
    {
        return ERC1271_MAGIC_VALUE;
    }

    /// @notice Allow the contract to receive ETH (needed for payable initialize
    ///         when the sponsor funds the tx).
    receive() external payable {}
}
