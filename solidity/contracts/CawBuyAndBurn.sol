// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./ISwapRouter.sol";

/// @title CawBuyAndBurn
/// @notice Swaps ETH for CAW, sends half to the client and burns the other half.
///         Called atomically by CawProfile.withdrawFees().
/// @dev The client's fees and the protocol's matching portion are swapped together
///      in a single Uniswap trade. Half the CAW goes to the client, half to 0xdead.
///      Because the client receives CAW from the same swap, they are incentivized to
///      set a good minCawOut — a bad value hurts their own payout equally.
contract CawBuyAndBurn {

  IERC20 public immutable CAW;
  ISwapRouter public immutable router;
  address public immutable WETH;

  address public cawProfile;
  address private immutable deployer;

  address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

  event BuyAndBurn(uint256 ethIn, uint256 cawBurned, uint256 cawToClient, address indexed client);

  constructor(address _caw, address _router) {
    CAW = IERC20(_caw);
    router = ISwapRouter(_router);
    WETH = router.WETH();
    deployer = msg.sender;
  }

  /// @notice Set the CawProfile address. Can only be called once, by the deployer.
  function setCawProfile(address _cawProfile) external {
    require(msg.sender == deployer, "Only deployer");
    require(cawProfile == address(0), "Already set");
    cawProfile = _cawProfile;
  }

  /// @notice Swap all incoming ETH for CAW, send half to the client and burn half.
  ///         Only callable by CawProfile during withdrawFees().
  /// @param minCawOut Minimum total CAW the swap must produce.
  /// @param client Address to receive half the CAW.
  /// @return clientShare The amount of CAW sent to the client.
  function swapAndSplit(uint256 minCawOut, address client) external payable returns (uint256 clientShare) {
    require(msg.sender == cawProfile, "Only CawProfile");
    require(msg.value > 0, "No ETH");

    address[] memory path = new address[](2);
    path[0] = WETH;
    path[1] = address(CAW);

    // Swap all ETH for CAW, received by this contract
    uint256[] memory amounts = router.swapExactETHForTokens{value: msg.value}(
      minCawOut,
      path,
      address(this),
      block.timestamp
    );

    uint256 totalCaw = amounts[amounts.length - 1];
    clientShare = totalCaw / 2;
    uint256 burnShare = totalCaw - clientShare;

    // Send half to client, half to dead
    CAW.transfer(client, clientShare);
    CAW.transfer(DEAD, burnShare);

    emit BuyAndBurn(msg.value, burnShare, clientShare, client);
  }

  /// @notice Preview how much CAW a given ETH amount would buy at current prices.
  function getExpectedCawOut(uint256 ethAmount) external view returns (uint256) {
    if (ethAmount == 0) return 0;

    address[] memory path = new address[](2);
    path[0] = WETH;
    path[1] = address(CAW);

    uint256[] memory amounts = router.getAmountsOut(ethAmount, path);
    return amounts[1];
  }

}
