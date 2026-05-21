/**
 * eip7702.ts
 *
 * EIP-7702 authorization tuple construction and signing.
 *
 * An EIP-7702 auth tuple authorizes an EOA to temporarily delegate its
 * code to a given contract address. The tuple is:
 *   `[chainId, contractAddress, nonce]`
 * signed with the EOA's secp256k1 private key.
 *
 * The digest is:
 *   `keccak256(0x05 || rlp([chainId, contractAddress, nonce]))`
 *
 * viem 2.x exports `signAuthorization` from `viem/accounts` which handles
 * the magic byte, RLP encoding, and keccak256 digest correctly. We use it
 * directly rather than reimplementing the encoding.
 *
 * IMPORTANT — chainId must NEVER be hardcoded. The plan (§4) explicitly
 * requires reading the chainId from the RPC-connected provider at signing
 * time. The same code path is used on Sepolia, mainnet, and any future
 * network without code changes. The `signAuthorizationTuple` function
 * requires the caller to supply the chainId from the connected provider.
 *
 * Dependencies: viem (already installed, v2.31.3+).
 */

import { signAuthorization } from 'viem/accounts'
import type { Hex } from 'viem'

// ─── Types ───────────────────────────────────────────────────────────────────

export type AuthTupleSignature = {
  /** y-parity of the signing point (0 or 1) — equivalent to recovery bit. */
  yParity: number
  r: `0x${string}`
  s: `0x${string}`
  /**
   * The full signed authorization tuple, ready to be embedded in the
   * `authorizationList` of a type-0x04 (EIP-7702) transaction.
   * Shape matches viem's `SignedAuthorization` type.
   */
  signedAuthorization: SignedAuthorizationTuple
}

export type SignedAuthorizationTuple = {
  chainId: number
  address: `0x${string}`
  nonce: number
  yParity: number
  r: `0x${string}`
  s: `0x${string}`
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build and sign an EIP-7702 authorization tuple.
 *
 * The sponsoring server uses this tuple to construct the type-0x04
 * transaction that delegates the user's EOA to the SmartEOA implementation
 * contract.
 *
 * @param opts.privateKey        Raw 32-byte secp256k1 private key of the user's EOA.
 * @param opts.chainId           Chain ID of the target network. Read from the RPC
 *                               provider — NEVER hardcode. Pass the value you
 *                               get from `publicClient.getChainId()` or wagmi's
 *                               `useChainId()`.
 * @param opts.contractAddress   Address of the SmartEOA implementation contract.
 *                               Retrieved from the deployed ABI registry or a
 *                               network config constant — not from user input.
 * @param opts.nonce             The EOA's current transaction nonce (not to be
 *                               confused with the SmartEOA permit nonce). Retrieve
 *                               from `publicClient.getTransactionCount({ address })`.
 *                               The 7702 auth tuple nonce prevents replay on a
 *                               different nonce slot.
 */
export async function signAuthorizationTuple(opts: {
  privateKey: Uint8Array
  chainId: number
  contractAddress: `0x${string}`
  nonce: bigint
}): Promise<AuthTupleSignature> {
  const { privateKey, chainId, contractAddress, nonce } = opts

  if (privateKey.length !== 32) {
    throw new Error(`Private key must be 32 bytes; got ${privateKey.length}`)
  }
  if (chainId <= 0 || !Number.isInteger(chainId)) {
    throw new Error(`chainId must be a positive integer; got ${chainId}`)
  }
  if (nonce < 0n) {
    throw new Error(`nonce must be non-negative; got ${nonce}`)
  }

  // Convert private key bytes to viem's expected `0x${string}` hex form.
  const privateKeyHex: Hex =
    ('0x' +
      Array.from(privateKey)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')) as Hex

  // viem's signAuthorization implements the EIP-7702 spec:
  //   digest = keccak256(0x05 || rlp([chainId, address, nonce]))
  // and returns { chainId, address, nonce, yParity, r, s }.
  // The `nonce` field in the auth tuple is uint64 (per EIP-7702), so we
  // pass it as a number (safe up to 2^53-1 which is far beyond any
  // realistic EOA nonce).
  const nonceNum = Number(nonce)
  if (nonceNum !== Number(nonce)) {
    // Bigint was too large for a JS number — EOA nonces this high are
    // impossible in practice (would require more txes than atoms in the
    // universe), but guard against accidental misuse.
    throw new Error(`nonce ${nonce} overflows safe integer range`)
  }

  const signed = await signAuthorization({
    privateKey: privateKeyHex,
    chainId,
    contractAddress,
    nonce: nonceNum,
  })

  // viem's Signature type marks yParity as potentially undefined (union of
  // legacy-v and yParity forms). For an EIP-7702 auth tuple signed by
  // signAuthorization, yParity is always present (the function never
  // produces a legacy-v-only result). We assert non-null here; the error
  // below will surface if viem's implementation ever changes shape.
  const yParity = signed.yParity
  if (yParity === undefined) {
    throw new Error('signAuthorization returned a signature without yParity — unexpected viem behaviour')
  }

  return {
    yParity,
    r: signed.r,
    s: signed.s,
    signedAuthorization: {
      chainId: signed.chainId,
      address: signed.address,
      nonce: signed.nonce,
      yParity,
      r: signed.r,
      s: signed.s,
    },
  }
}
