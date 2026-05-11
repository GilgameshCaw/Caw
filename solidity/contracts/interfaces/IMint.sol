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

}
