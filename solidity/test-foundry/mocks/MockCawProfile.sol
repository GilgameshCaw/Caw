// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Minimal stand-in for CawProfile that satisfies the
///         `ICawProfileTransfer` interface used by CawProfileMarketplace.
///         Transfers are plain ERC721; there is no LayerZero (irrelevant under
///         Foundry), so the owner-sync queue is always empty and the marketplace
///         never sends a fee — it returns all of the LZ ETH to its caller.
///         The marketplace approves itself via `setApprovalForAll`.
contract MockCawProfile is ERC721 {
    constructor() ERC721("MockCAW", "MCAW") {}

    function mintTo(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }

    function pendingTransferUpdates(uint32, address, uint32)
        external
        pure
        returns (uint32[] memory, address[] memory, uint64[] memory)
    {}

    function lzQuote(uint32, bytes4, uint256, bytes memory, uint32, bool) external pure returns (uint256, uint256) {}

    function syncTransfer(uint32, uint256) external payable {
        revert("no LZ queue in mock");
    }
}
