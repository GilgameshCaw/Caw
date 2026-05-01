// src/hooks/useZapQuote.ts
//
// Hooks shared by the pay-with-ETH ZAP flows (mintAndDepositZap,
// depositZap, mintAndDepositAndQuickSignZap). Two responsibilities:
//
//   1. usePoolReserves — read live (reserve0, reserve1) from a Uniswap V2
//      pair contract and figure out which side is WETH vs CAW so callers
//      don't have to. Cached for the page session via wagmi's `useReadContract`
//      query layer; re-reads on key change.
//
//   2. useMinCawOut — pure math: given an ETH input and a slippage tolerance
//      (in basis points), return the expected CAW out (no slippage) and the
//      slippage-adjusted minimum the contract should enforce.
//
// The Uniswap V2 invariant we use is x*y=k. Output of swapping `amountIn`
// of WETH (the "in" token) is:
//   amountInWithFee = amountIn * 997
//   numerator = amountInWithFee * cawReserve
//   denominator = wethReserve * 1000 + amountInWithFee
//   amountOut = numerator / denominator
//
// We compute everything with bigint to avoid precision loss for large
// reserves (CAW supply is in the trillions).

import { useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { CAW_ADDRESS } from '~/../../../abi/addresses'

const PAIR_ABI = [
  {
    name: 'getReserves',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: '_reserve0', type: 'uint112' },
      { name: '_reserve1', type: 'uint112' },
      { name: '_blockTimestampLast', type: 'uint32' },
    ],
  },
  {
    name: 'token0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

export interface PoolReserves {
  cawReserve: bigint
  wethReserve: bigint
  loaded: boolean
}

export function usePoolReserves(
  pairAddress: `0x${string}` | undefined,
  chainId?: number
): PoolReserves {
  const { data: token0Addr } = useReadContract({
    abi: PAIR_ABI,
    address: pairAddress,
    chainId,
    functionName: 'token0',
    query: { enabled: !!pairAddress },
  })

  const { data: reserves } = useReadContract({
    abi: PAIR_ABI,
    address: pairAddress,
    chainId,
    functionName: 'getReserves',
    query: { enabled: !!pairAddress, refetchInterval: 30_000 },
  })

  return useMemo(() => {
    if (!reserves || !token0Addr) {
      return { cawReserve: 0n, wethReserve: 0n, loaded: false }
    }
    const [r0, r1] = reserves as readonly [bigint, bigint, number]
    // Determine which side is CAW. token0 is the lexicographically smaller
    // address; we don't assume — read it and compare.
    const cawIsToken0 =
      (token0Addr as string).toLowerCase() === CAW_ADDRESS.toLowerCase()
    return cawIsToken0
      ? { cawReserve: r0, wethReserve: r1, loaded: true }
      : { cawReserve: r1, wethReserve: r0, loaded: true }
  }, [reserves, token0Addr])
}

/**
 * Pure Uniswap V2 amount-out math (with the standard 0.3% fee).
 * Returns the CAW you'd receive for `ethIn` against the supplied reserves.
 */
export function getAmountOutV2(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * 997n
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * 1000n + amountInWithFee
  return numerator / denominator
}

export interface ZapQuote {
  expectedCawOut: bigint // 0 if reserves not yet loaded
  minCawOut: bigint // expectedCawOut * (10000 - slippageBps) / 10000
  loaded: boolean
}

/**
 * Given an ETH input and a slippage tolerance in basis points, compute the
 * expected CAW output and the slippage-floor minimum. Defaults to 200 bps
 * (2%). Caller should bump for trades that move the pool meaningfully.
 */
export function useMinCawOut(
  ethAmount: bigint,
  reserves: PoolReserves,
  slippageBps: number = 200
): ZapQuote {
  return useMemo(() => {
    if (!reserves.loaded || ethAmount <= 0n) {
      return { expectedCawOut: 0n, minCawOut: 0n, loaded: reserves.loaded }
    }
    const expectedCawOut = getAmountOutV2(
      ethAmount,
      reserves.wethReserve,
      reserves.cawReserve
    )
    const bps = BigInt(Math.max(0, Math.min(10000, Math.floor(slippageBps))))
    const minCawOut = (expectedCawOut * (10000n - bps)) / 10000n
    return { expectedCawOut, minCawOut, loaded: true }
  }, [
    ethAmount,
    reserves.loaded,
    reserves.cawReserve,
    reserves.wethReserve,
    slippageBps,
  ])
}

/**
 * Heuristic slippage scaler: 2% baseline, scaled up for trades that move
 * the pool meaningfully. Mirrors the spec recommendation:
 *   slippage = max(2%, min(10%, (eth * 50) / ethReserve))
 *
 * Returned in basis points (e.g. 200 = 2%, 1000 = 10%).
 */
export function suggestedSlippageBps(
  ethAmount: bigint,
  wethReserve: bigint
): number {
  if (wethReserve === 0n || ethAmount === 0n) return 200
  // (eth * 50 / ethReserve) gives an integer percentage scaled by the
  // factor 50 (so a 1% pool move => 50% slippage; we cap below).
  const ratio = Number((ethAmount * 5000n) / wethReserve) // bps
  if (ratio < 200) return 200
  if (ratio > 1000) return 1000
  return ratio
}
