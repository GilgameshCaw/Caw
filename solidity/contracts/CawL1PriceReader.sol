// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IUniswapV2Pair.sol";

/// @title CawL1PriceReader
/// @notice Reads the current `priceCumulativeLast` for CAW/WETH from a specific
///         immutable Uniswap V2 pair, virtually advancing the cumulative to the
///         current block if the pair hasn't been touched this block.
///
///         The pair address is set once in the constructor and can never change.
///         If the pair ever dies (liquidity removed, etc.), the cumulative
///         simply stops advancing meaningfully and the L2 cap math sees a
///         stale TWAP — which under the L2 oracle's >24h-stale policy means
///         the cap goes dormant and baseline action costs apply forever.
///
/// @dev    Math is the standard UniswapV2OracleLibrary trick: when
///         `blockTimestampLast < block.timestamp`, the pair's last `_update()`
///         hasn't run this block, so the cumulative is missing the
///         `(currentPrice * elapsed)` portion. We splice it in virtually
///         without writing to the pair.
///
///         Returned price is the cumulative of (WETH per CAW), so a TWAP
///         derived from it gives ETH/CAW directly. The cumulative is a UQ112.112
///         fixed-point value as defined by Uniswap V2.
contract CawL1PriceReader {
  IUniswapV2Pair public immutable pair;

  /// @notice True if CAW is token0 in the pair. Determines which
  ///         priceCumulativeLast to read (we want WETH-per-CAW).
  bool public immutable cawIsToken0;

  /// @param _pair     Uniswap V2 pair contract (must contain CAW + WETH).
  /// @param _cawToken Address of the CAW token. Used only in the constructor
  ///                  to determine token ordering; not stored.
  constructor(IUniswapV2Pair _pair, address _cawToken) {
    address t0 = _pair.token0();
    address t1 = _pair.token1();
    require(t0 == _cawToken || t1 == _cawToken, "CAW not in pair");

    // L-2: probe the other functions we depend on, fail loudly here rather
    // than producing garbage at the first readSample() after deploy. `_pair`
    // is immutable, so a fat-finger here is permanent — this is the only
    // line of defense.
    _pair.getReserves();
    _pair.price0CumulativeLast();
    _pair.price1CumulativeLast();

    pair = _pair;
    cawIsToken0 = (t0 == _cawToken);
  }

  /// @notice Read the current cumulative for WETH-per-CAW, advanced to the
  ///         current block if the pair is stale this block.
  /// @return cumulative  UQ112.112 cumulative price (WETH-per-CAW), summed
  ///                     over all elapsed seconds since pair deployment.
  /// @return timestamp   The `block.timestamp` at the moment of this read.
  function readSample() external view returns (uint256 cumulative, uint32 timestamp) {
    timestamp = uint32(block.timestamp);

    // V2 convention: priceXCumulativeLast accumulates "price of tokenX in
    // terms of the other token". We want WETH-per-CAW, so we want the
    // cumulative for whichever slot CAW occupies:
    //   CAW = token0  →  price0CumulativeLast  (price of CAW in WETH)
    //   CAW = token1  →  price1CumulativeLast  (price of CAW in WETH)
    cumulative = cawIsToken0
      ? pair.price0CumulativeLast()
      : pair.price1CumulativeLast();

    (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = pair.getReserves();

    if (blockTimestampLast != timestamp) {
      // Pair hasn't been touched this block — advance cumulative virtually.
      uint32 elapsed;
      unchecked {
        // V2's _update() does the subtraction unchecked too; uint32 overflow
        // ("year 2106 problem") cancels out across a window so it's fine.
        elapsed = timestamp - blockTimestampLast;
      }
      if (elapsed > 0 && reserve0 != 0 && reserve1 != 0) {
        // UQ112.112 price = (other_reserve << 112) / our_reserve
        // For WETH-per-CAW:
        //   CAW = token0  →  WETH-per-CAW = reserve1 / reserve0  →  (reserve1 << 112) / reserve0
        //   CAW = token1  →  WETH-per-CAW = reserve0 / reserve1  →  (reserve0 << 112) / reserve1
        uint256 price = cawIsToken0
          ? (uint256(reserve1) << 112) / reserve0
          : (uint256(reserve0) << 112) / reserve1;

        // `price * elapsed` is CHECKED. Bounds: price ≤ 2^224 (UQ112.112,
        // since both reserves are uint112), elapsed ≤ 2^32, product ≤ 2^256
        // worst case. For any plausible reserve/time combination the
        // product is comfortably ≤ 2^200, but if a pathological pair or
        // time-warp pushes it to overflow we want a loud revert, not a
        // silent wrap. (The wrap that V2 *intends* is on the cumulative
        // accumulator below, not on the per-block increment.)
        uint256 increment = price * elapsed;
        unchecked {
          // `cumulative +=` is UNCHECKED. V2's pair `_update()` itself
          // wraps the cumulative — that's part of the design. A TWAP
          // consumer that subtracts unchecked recovers the true delta
          // because `(a + N) - a == N (mod 2^256)`. Our oracle's
          // `twapEthPerCaw()` subtracts unchecked for exactly this reason.
          cumulative += increment;
        }
      }
    }
  }
}
