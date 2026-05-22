// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal stand-in for CawProfileMinter used by the EIP7702Bootstrap test.
///         Mirrors the ERC-1271 staticcall shape from CawActionsERC1271.sol and
///         the sponsor entry-point described in §3 of plan-smart-eoa-passkey-sponsorship.md.
///
/// @dev Two things are verified here:
///      1. recipient.code.length > 0  — proves the EOA was delegated before this call.
///      2. recipient.staticcall(isValidSignature(...)) == 0x1626ba7e
///                                   — proves the ERC-1271 gate fires correctly.
///      Both checks happen inside the same execution frame initiated by initialize(),
///      which itself runs inside the same type-0x04 tx as the 7702 delegation.

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external view returns (bytes4 magicValue);
}

contract MockMinter {
    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    // ERC-1271 gas limit mirrors CawActionsERC1271.sol: 30_000 gas.
    // Enough for a pure-return mock; real SmartEOA P-256 verify needs ~8_000.
    uint256 private constant ERC1271_GAS_LIMIT = 30_000;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    /// @dev Emitted on a successful mock mint.  The bootstrap test asserts
    ///      this event fires, proving the full call chain completed.
    event Minted(address indexed recipient);

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    /// @dev Stores the last recipient for which a successful mint ran.
    ///      Used as an additional assertion target in the test.
    address public lastMinted;

    // ---------------------------------------------------------------
    // Entry point
    // ---------------------------------------------------------------

    /// @notice Sponsor entry point.  In production this would verify a permit
    ///         sig, consume a nonce, then call CawProfile.mintAndDeposit.
    ///
    ///         In this mock:
    ///           1. Checks recipient.code.length > 0 (delegation proof).
    ///           2. Staticcalls recipient.isValidSignature(bytes32(0), sig).
    ///           3. Asserts the magic value comes back.
    ///           4. Emits Minted(recipient).
    ///
    /// @param recipient  The 7702-delegated EOA (address(this) from MockSmartEOA.initialize).
    /// @param sig        Signature blob forwarded verbatim to isValidSignature.
    function mintAndDepositSponsored(address recipient, bytes calldata sig)
        external
        payable
    {
        // --- Step 1: delegation check ---
        // After a type-0x04 tx processes its auth list, the target EOA has
        // code = 0xef0100 || implementationAddress (23 bytes).  Checking
        // code.length > 0 is the contract-layer guard — same as the real Minter.
        require(recipient.code.length > 0, "MockMinter: recipient not a smart account");

        // --- Step 2+3: ERC-1271 magic value check ---
        // Staticcall mirrors CawActionsERC1271 line 309.  We use a fixed gas
        // limit to match the real contract's pattern (not unlimited gas).
        (bool ok, bytes memory ret) = recipient.staticcall{gas: ERC1271_GAS_LIMIT}(
            abi.encodeWithSelector(IERC1271.isValidSignature.selector, bytes32(0), sig)
        );
        require(
            ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC_VALUE,
            "MockMinter: ERC-1271 check failed"
        );

        // --- Step 4: record + emit ---
        lastMinted = recipient;
        emit Minted(recipient);
    }

    /// @notice Accept ETH forwarded by MockSmartEOA.initialize.
    receive() external payable {}
}
