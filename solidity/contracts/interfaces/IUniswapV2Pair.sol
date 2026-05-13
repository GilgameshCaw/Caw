// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal Uniswap V2 pair interface — just what the price reader needs.
///         Full V2 interface omitted to keep the dependency surface small.
interface IUniswapV2Pair {
  function token0() external view returns (address);
  function token1() external view returns (address);
  function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
  function price0CumulativeLast() external view returns (uint256);
  function price1CumulativeLast() external view returns (uint256);
}
