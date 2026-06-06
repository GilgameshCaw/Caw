/**
 * Runtime auto-discovery of ERC-20 storage slot indices for _balances and
 * _allowances, using viem's stateOverride readback technique.
 *
 * For each candidate slot index S (0..15):
 *   balanceOf slot: keccak256(abi.encode(probeAddr, S))
 *   allowance slot: keccak256(abi.encode(spender, keccak256(abi.encode(owner, S))))
 *
 * We write a sentinel value into the candidate slot via stateOverride and
 * confirm the contract reports it back via balanceOf / allowance.
 *
 * Results are module-level cached by token address (lowercased) so discovery
 * runs at most once per token per session; concurrent callers share the
 * in-flight Promise.
 */

import { keccak256, encodeAbiParameters, toHex, erc20Abi } from 'viem'
import type { PublicClient } from 'viem'

const SENTINEL = 123_456_789n
const SENTINEL_HEX = toHex(SENTINEL, { size: 32 })
const MAX_SLOT = 15n

const cache = new Map<string, Promise<{ balances: bigint; allowances: bigint } | null>>()

export async function discoverErc20Slots(
  publicClient: PublicClient,
  token: `0x${string}`,
  minter: `0x${string}`,
  probe: `0x${string}`,
): Promise<{ balances: bigint; allowances: bigint } | null> {
  const key = token.toLowerCase()
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const promise = _discover(publicClient, token, minter, probe)
  cache.set(key, promise)
  return promise
}

async function _discover(
  publicClient: PublicClient,
  token: `0x${string}`,
  minter: `0x${string}`,
  probe: `0x${string}`,
): Promise<{ balances: bigint; allowances: bigint } | null> {
  try {
    let balancesSlot: bigint | null = null
    let allowancesSlot: bigint | null = null

    // Scan for _balances slot
    for (let s = 0n; s <= MAX_SLOT; s++) {
      const slot = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [probe, s],
        ),
      )
      try {
        const out = await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [probe],
          stateOverride: [{ address: token, stateDiff: [{ slot, value: SENTINEL_HEX }] }],
        })
        if (out === SENTINEL) {
          balancesSlot = s
          break
        }
      } catch {
        // stateOverride not supported or RPC error for this candidate — continue
      }
    }

    if (balancesSlot === null) return null

    // Scan for _allowances slot
    // Layout: allowances[owner][spender] at keccak256(spender || keccak256(owner || slotIndex))
    for (let s = 0n; s <= MAX_SLOT; s++) {
      const innerSlot = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [probe, s],
        ),
      )
      const outerSlot = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [minter, BigInt(innerSlot)],
        ),
      )
      try {
        const out = await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [probe, minter],
          stateOverride: [{ address: token, stateDiff: [{ slot: outerSlot, value: SENTINEL_HEX }] }],
        })
        if (out === SENTINEL) {
          allowancesSlot = s
          break
        }
      } catch {
        // continue
      }
    }

    if (allowancesSlot === null) return null

    return { balances: balancesSlot, allowances: allowancesSlot }
  } catch {
    return null
  }
}
