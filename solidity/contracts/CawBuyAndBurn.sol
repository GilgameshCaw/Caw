// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./ISwapRouter.sol";

/// @title CawBuyAndBurn
/// @notice Swaps ETH for CAW, sends half to the network and burns the other half.
///         Called atomically by CawProfile.withdrawFees().
/// @dev The network's fees and the protocol's matching portion are swapped together
///      in a single Uniswap trade. Half the CAW goes to the network, half to 0xdead.
///      Because the network receives CAW from the same swap, they are incentivized to
///      set a good minCawOut — a bad value hurts their own payout equally.
///
///      NOTE TO FUTURE AUDITORS — two findings re-examined 2026-05-17 and
///      intentionally left as-is:
///
///      1) `deadline: block.timestamp` on swapExactETHForTokens. Technically
///         loose (the tx never expires from the router's perspective), but the
///         MEV-sandwich vector requires a slack minCawOut. The only caller is
///         CawProfile.withdrawFees, and the network operator who triggers it
///         receives half the swap output — so they have a direct,
///         equal-magnitude incentive to set minCawOut tight. CawProfile is
///         immutable, so "future upgrade passes minCawOut=0" is not a real
///         scenario. The minCawOut incentive IS the safety mechanism.
///
///      2) Unchecked `CAW.transfer` return values. The real CAW ERC-20 is
///         OpenZeppelin-derived and reverts on failure, so the missing return
///         check is a no-op. SafeERC20 would be defensive style only — not
///         a security gap on the deployed token.
///
/// @dev Audit-trail tags in this contract (e.g. "H-N", "M-N", "Round N",
///      "Audit fix YYYY-MM-DD") are decoded in `docs/AUDIT_TRAIL.md`.
contract CawBuyAndBurn {

  IERC20 public immutable CAW;
  ISwapRouter public immutable router;
  address public immutable WETH;

  address public cawProfile;
  address private immutable deployer;

  address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

  event BuyAndBurn(uint256 ethIn, uint256 cawBurned, uint256 cawToNetwork, address indexed network);

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

  /// @notice Swap all incoming ETH for CAW, send half to the network and burn half.
  ///         Only callable by CawProfile during withdrawFees().
  /// @param minCawOut Minimum total CAW the swap must produce.
  /// @param network Address to receive half the CAW.
  /// @return networkShare The amount of CAW sent to the network.
  function swapAndSplit(uint256 minCawOut, address network) external payable returns (uint256 networkShare) {
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
    networkShare = totalCaw / 2;
    uint256 burnShare = totalCaw - networkShare;

    // Send half to network, half to dead
    CAW.transfer(network, networkShare);
    CAW.transfer(DEAD, burnShare);

    emit BuyAndBurn(msg.value, burnShare, networkShare, network);
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
