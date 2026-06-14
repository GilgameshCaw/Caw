/**
 * useSmartEoaExecute — sign + relay a SmartEOA.executeBatch for a passkey wallet.
 *
 * Builds the exact digest SmartEOA.executeBatch expects (see SmartEOA._executeDigest):
 *   domainSep  = keccak256(abi.encode(keccak256("SmartEOA"), chainId, account))
 *   callHash_i = keccak256(abi.encode(to, value, keccak256(data)))
 *   structHash = keccak256(abi.encode(keccak256("executeBatch"),
 *                                     keccak256(abi.encodePacked(callHashes)), nonce))
 *   digest     = keccak256("\x19\x01" || domainSep || structHash)
 *
 * Signs it via useRootSigner().signDigest (secp256k1 recovery key → 65-byte, OR
 * passkey → WebAuthn blob — both accepted by executeBatch), then POSTs to
 * /api/sponsor/execute where the validator fronts gas + the withdraw's LZ fee and
 * is repaid by the signed CAW fee transfer in the batch.
 *
 * `account` is the user's EOA (7702-delegated). It must hold no special state
 * here — the contract reads executeNonce from its own per-EOA storage.
 */

import { useCallback } from 'react'
import {
  keccak256,
  encodeAbiParameters,
  encodePacked,
  type Address,
  type Hex,
} from 'viem'
import { usePublicClient } from 'wagmi'
import { useRootSigner } from '~/hooks/useRootSigner'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { smartEoaAbi } from '~/../../../abi/generated'
import { apiFetch } from '~/api/client'
import { chains } from '~/config/chains'

export interface ExecCall {
  to: Address
  value: bigint
  data: Hex
}

const KEC_SMARTEOA = keccak256(encodePacked(['string'], ['SmartEOA']))
const KEC_EXECUTEBATCH = keccak256(encodePacked(['string'], ['executeBatch']))

/** Recompute SmartEOA._executeDigest off-chain — MUST match the contract byte-for-byte. */
export function buildExecuteDigest(account: Address, chainId: number, calls: ExecCall[], nonce: bigint): Hex {
  const domainSep = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [KEC_SMARTEOA, BigInt(chainId), account],
    ),
  )
  const callHashes = calls.map(c =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
        [c.to, c.value, keccak256(c.data)],
      ),
    ),
  )
  const callsHash = keccak256(encodePacked(['bytes32[]'], [callHashes]))
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
      [KEC_EXECUTEBATCH, callsHash, nonce],
    ),
  )
  return keccak256(encodePacked(['bytes', 'bytes32', 'bytes32'], ['0x1901', domainSep, structHash]))
}

export interface UseSmartEoaExecuteResult {
  /** Sign the batch with the passkey and relay it. Returns the relay txHash. */
  execute: (calls: ExecCall[]) => Promise<string>
  /** The user's EOA address, or undefined if not a passkey wallet. */
  account: Address | undefined
}

export function useSmartEoaExecute(): UseSmartEoaExecuteResult {
  const { address, population } = useWalletPopulation()
  const { signDigest } = useRootSigner()
  const publicClient = usePublicClient({ chainId: chains.l1.chainId })

  const account = population === 'B' ? (address as Address | undefined) : undefined

  const execute = useCallback(async (calls: ExecCall[]): Promise<string> => {
    if (!account) throw new Error('No passkey wallet connected.')
    if (!publicClient) throw new Error('No L1 client available.')
    if (calls.length === 0) throw new Error('Empty batch.')

    // Read the current executeNonce from the user's EOA.
    const nonce = (await publicClient.readContract({
      address: account,
      abi: smartEoaAbi,
      functionName: 'executeNonceOf',
    })) as bigint

    const digest = buildExecuteDigest(account, chains.l1.chainId, calls, nonce)
    const sig = await signDigest(digest)

    const resp = await apiFetch<{ txHash: string }>('/api/sponsor/execute', {
      method: 'POST',
      body: JSON.stringify({
        smartEoaAddress: account,
        calls: calls.map(c => ({ to: c.to, value: c.value.toString(), data: c.data })),
        nonce: nonce.toString(),
        sig,
      }),
    })
    return resp.txHash
  }, [account, publicClient, signDigest])

  return { execute, account }
}
