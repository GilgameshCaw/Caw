// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal ERC-1271 smart-contract wallet mock for MinterSponsor tests.
///
///         Represents Population C: an existing smart-contract wallet (Safe,
///         Argent, Coinbase Smart Wallet, etc.) that implements ERC-1271.
///
///         Behaviour:
///         - isValidSignature returns 0x1626ba7e for any sig of length > 0.
///           A zero-length sig returns 0xffffffff (so tests can exercise the
///           failure path by passing empty bytes).
///         - nonceOf / consumeNonce mirror the SmartEOA nonce model so the
///           Minter's _checkPermit helper works against this mock.
///           consumeNonce is gated: msg.sender must equal verifyingContract.
///
///         The mock does NOT implement passkey or ECDSA verification — it exists
///         solely to prove the Minter's contract layer is wallet-agnostic.
contract SmartContractWalletMock {

    // ERC-1271 magic from the standard.
    bytes4 private constant MAGIC = 0x1626ba7e;

    // Per-(verifyingContract, actionType) monotonic nonces — mirrors SmartEOA model.
    mapping(address => mapping(uint8 => uint256)) private _nonces;

    // ---------------------------------------------------------------
    // ERC-1271
    // ---------------------------------------------------------------

    /// @notice Returns magic for any non-empty sig; 0xffffffff for empty sig.
    function isValidSignature(bytes32 /*hash*/, bytes calldata sig)
        external
        pure
        returns (bytes4)
    {
        if (sig.length == 0) return bytes4(0xffffffff);
        return MAGIC;
    }

    // ---------------------------------------------------------------
    // ISmartEOA nonce surface (required by CawProfileMinter._checkPermit)
    // ---------------------------------------------------------------

    function nonceOf(address verifyingContract, uint8 actionType)
        external
        view
        returns (uint256)
    {
        return _nonces[verifyingContract][actionType];
    }

    /// @notice Gated: msg.sender must equal verifyingContract (mirrors SmartEOA).
    function consumeNonce(address verifyingContract, uint8 actionType) external {
        require(msg.sender == verifyingContract, "SmartContractWalletMock: not permitted");
        unchecked { ++_nonces[verifyingContract][actionType]; }
    }

    // ---------------------------------------------------------------
    // ERC-721 receiver — needed if the Minter mints an NFT to this address
    // ---------------------------------------------------------------

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    // Allow receiving ETH (sponsor may forward value).
    receive() external payable {}
}
