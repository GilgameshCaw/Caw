import { Address } from "viem";
import TOKENS from "./constants/tokens";

export interface Amount {
  raw: bigint;
  usd: number;
}

export type TokenSymbol = keyof typeof TOKENS;

export interface Token {
  coingeckoId: string;
  symbol: TokenSymbol;
  decimals: number;
  address: Address;
  price: bigint
}

export interface TokenData {
  withdrawable: bigint;
  ownerBalance: bigint;
  stakedAmount: bigint;
  address: Address;
  username: string;
  tokenId: number;
  owner: Address;
  // balance: bigint;
  cawonce: number;
}

export interface User {
  username: string;
  id: number;
  image: string;
}

export type CawItem = {
  id: string
  content: string
  timestamp: string
  user: { id: number; username: string; image?: string }
  parent: CawItem
  likeCount: number
  hasLiked: boolean
  hasRecawed: boolean
  commentCount: number
  recawCount: number
  cawonce: number
}
