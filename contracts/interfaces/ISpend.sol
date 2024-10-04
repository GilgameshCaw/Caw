// contracts/ISpend.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ISpend {

  function ownerOf(
    uint256 tokenId
  ) external view returns (address);

  function spendAndDistribute(
    uint32 tokenId,
    uint256 amountToSpend,
    uint256 amountToDistribute
  ) external;

  function spendAndDistributeTokens(
    uint32 tokenId,
    uint256 amountToSpend,
    uint256 amountToDistribute
  ) external;


  function addToBalance(uint32 tokenId, uint256 amount) external;

  function addTokensToBalance(uint32 tokenId, uint256 amount) external;


}

