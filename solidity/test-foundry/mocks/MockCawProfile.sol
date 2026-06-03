// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Minimal stand-in for CawProfile that satisfies the
///         `ICawProfileTransfer` interface used by CawProfileMarketplace.
///         `transferAndSync` is a thin wrapper around `safeTransferFrom`,
///         dropping the LayerZero side-effect (irrelevant under Foundry).
///         The marketplace approves itself via `setApprovalForAll`.
contract MockCawProfile is ERC721 {
    constructor() ERC721("MockCAW", "MCAW") {}

    function mintTo(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }

    /// @dev Mirrors `CawProfile.transferAndSync(to, tokenId, lzDestId, lzTokenAmount)`.
    ///      Marketplace calls this with `value: lzFee` — we accept the ETH and
    ///      forward nothing onward (no LZ in the test).
    function transferAndSync(address to, uint256 tokenId, uint32 /*lzDestId*/, uint256 /*lzTokenAmount*/)
        external
        payable
    {
        // The marketplace pre-checks ownership/approval; mirror real semantics.
        address from = ownerOf(tokenId);
        // Marketplace is approved-for-all by the seller, so it's authorized to
        // initiate this. We don't enforce that here — this is a test stand-in.
        _transfer(from, to, tokenId);

        // Refund any ETH the marketplace forwarded for "LZ fee" — keeps the
        // marketplace's ETH balance clean and avoids leaking value to a mock.
        if (msg.value > 0) {
            (bool ok, ) = msg.sender.call{value: msg.value}("");
            require(ok, "refund fail");
        }
    }
}
