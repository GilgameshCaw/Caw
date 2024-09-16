// contracts/IMint.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IMint {

  function nextId() external returns (uint64);

  function mint(
    address sender,
    string memory username,
    uint64 newId,
    uint256 lzTokenAmount
  ) external payable;

}

