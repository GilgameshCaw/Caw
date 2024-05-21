// contracts/ISpend.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ISpend {

  function ownerOf(
    uint256 tokenId
  ) external view returns (address);

  function spendAndDistribute(
    uint64 tokenId,
    uint256 amountToSpend,
    uint256 amountToDistribute
  ) external;

  function spendAndDistributeTokens(
    uint64 tokenId,
    uint256 amountToSpend,
    uint256 amountToDistribute
  ) external;


  function addToBalance(uint64 tokenId, uint256 amount) external;

  function addTokensToBalance(uint64 tokenId, uint256 amount) external;


}

