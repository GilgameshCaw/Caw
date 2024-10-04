// contracts/IMint.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IMint {

  function nextId() external returns (uint32);

  function mint(
    uint32 clientId,
    address sender,
    string memory username,
    uint32 newId,
    uint256 lzTokenAmount
  ) external payable;

}

