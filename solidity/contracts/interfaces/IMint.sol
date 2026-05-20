// contracts/IMint.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IMint {

  function nextId() external returns (uint32);

  function mint(
    uint32 networkId,
    address sender,
    string memory username,
    uint32 newId,
    uint256 lzTokenAmount
  ) external payable;

  function mintAndDeposit(
    uint32 networkId,
    address sender,
    string memory username,
    uint32 newId,
    uint256 depositAmount,
    uint32 lzDestId,
    uint256 lzTokenAmount,
    bytes calldata sessionExtra
  ) external payable;

  function mintAndAuth(
    uint32 networkId,
    address sender,
    string memory username,
    uint32 newId,
    uint32 lzDestId,
    uint256 lzTokenAmount,
    bytes calldata sessionExtra
  ) external payable;

  function depositFor(
    uint32 cawNetworkId,
    uint32 tokenId,
    uint256 amount,
    uint32 lzDestId,
    uint256 lzTokenAmount
  ) external payable;

  /// @notice Returns the current owner of a profile token.
  ///         Mirrors ERC-721 ownerOf — used by sponsor entry points to look up
  ///         which address must supply the ERC-1271 permit sig.
  function ownerOf(uint256 tokenId) external view returns (address);

  /// @notice Authenticate a token to a network via the registered minter.
  ///         msg.sender must be the minter; trust chain: owner sig verified at
  ///         Minter → Minter trusted by CawProfile.
  function authenticateForMinter(
    uint32 cawNetworkId,
    uint32 tokenId,
    uint32 lzDestId,
    address owner,
    uint256 lzTokenAmount
  ) external payable;

}
