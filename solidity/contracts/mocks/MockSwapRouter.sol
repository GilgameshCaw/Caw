// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../MintableCaw.sol";

/// @notice Mock Uniswap V2 router for testing CawBuyAndBurn.
///         Simulates swapExactETHForTokens by minting CAW at a fixed rate.
contract MockSwapRouter {
  MintableCaw public caw;
  address public immutable WETH_ADDR;

  // 1 ETH = 1,000,000 CAW (fixed test rate)
  uint256 public rate = 1_000_000 * 1e18;

  constructor(address _caw) {
    caw = MintableCaw(_caw);
    WETH_ADDR = address(this); // dummy WETH
  }

  function WETH() external view returns (address) {
    return WETH_ADDR;
  }

  function swapExactETHForTokens(
    uint amountOutMin,
    address[] calldata path,
    address to,
    uint /* deadline */
  ) external payable returns (uint[] memory amounts) {
    uint256 cawOut = (msg.value * rate) / 1 ether;
    require(cawOut >= amountOutMin, "MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");

    caw.mint(to, cawOut);

    amounts = new uint[](path.length);
    amounts[0] = msg.value;
    amounts[path.length - 1] = cawOut;
  }

  function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts) {
    amounts = new uint[](path.length);
    amounts[0] = amountIn;
    amounts[path.length - 1] = (amountIn * rate) / 1 ether;
  }

  receive() external payable {}
}
