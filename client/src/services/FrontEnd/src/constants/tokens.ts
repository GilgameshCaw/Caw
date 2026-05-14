import { zeroAddress } from "viem";
import { Token } from "~/types";
import { WETH_ADDRESS, CAW_ADDRESS, } from "~/../../../abi/addresses";

// : Record<string, Token>
const TOKENS: Record<string, Token> = {
  ETH: {
    symbol: "ETH",
    address: WETH_ADDRESS,
    coingeckoId: "ethereum",
    decimals: 18,
    price: 0n,
  },
  CAW: {
    symbol: "CAW",
    address: CAW_ADDRESS,
    coingeckoId: "a-hunters-dream",
    decimals: 18,
    price: 0n,
  },
};

export default TOKENS;
