/**
 * EIP-712 permit digest builders for CawProfileMinter sponsored entry points.
 *
 * These digests are signed (via WebAuthn passkey or secp256k1 fallback) and
 * passed to the sponsor server. The contract re-derives the same digest from
 * its DOMAIN_SEPARATOR (immutable, set at deploy time) and verifies the sig
 * via ERC-1271 on the user's SmartEOA.
 *
 * EIP-712 domain:
 *   { name: 'CawProfileMinter', version: '1', chainId, verifyingContract: minterAddress }
 *
 * Type hashes (from CawProfileMinter.sol — must match exactly):
 *
 *   MintAndDeposit(uint32 networkId,address recipient,string username,
 *     uint256 depositAmount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce)
 *
 *   DepositFor(uint32 networkId,uint32 tokenId,uint256 amount,
 *     uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce)
 *
 *   Authenticate(uint32 networkId,uint32 tokenId,uint32 lzDestId,
 *     uint256 lzTokenAmount,uint256 nonce)
 *
 * Uses viem's hashTypedData() which handles domain separator derivation,
 * struct hash computation, and the final keccak256("\x19\x01" || d || s).
 */

import { hashTypedData } from 'viem'

// ---------------------------------------------------------------------------
// mintAndDepositSponsored permit
// ---------------------------------------------------------------------------

export interface MintDepositPermitOpts {
  /** CawProfileMinter deployed address */
  minterAddress: `0x${string}`
  chainId: number
  networkId: number
  /** User's EOA / SmartEOA address — the recipient of the minted profile */
  recipient: `0x${string}`
  username: string
  depositAmount: bigint
  lzDestId: number
  lzTokenAmount: bigint
  nonce: bigint
}

/**
 * Produce the EIP-712 digest for CawProfileMinter.mintAndDepositSponsored.
 * This is the 32-byte value the user signs (via passkey or secp256k1).
 * The contract re-derives it as:
 *   keccak256("\x19\x01" || DOMAIN_SEPARATOR || keccak256(abi.encode(TYPEHASH, ...)))
 */
export function buildMintDepositPermitDigest(opts: MintDepositPermitOpts): `0x${string}` {
  return hashTypedData({
    domain: {
      name: 'CawProfileMinter',
      version: '1',
      chainId: BigInt(opts.chainId),
      verifyingContract: opts.minterAddress,
    },
    types: {
      MintAndDeposit: [
        { name: 'networkId',       type: 'uint32'  },
        { name: 'recipient',       type: 'address' },
        { name: 'username',        type: 'string'  },
        { name: 'depositAmount',   type: 'uint256' },
        { name: 'lzDestId',        type: 'uint32'  },
        { name: 'lzTokenAmount',   type: 'uint256' },
        { name: 'nonce',           type: 'uint256' },
      ],
    },
    primaryType: 'MintAndDeposit',
    message: {
      networkId:     opts.networkId,
      recipient:     opts.recipient,
      username:      opts.username,
      depositAmount: opts.depositAmount,
      lzDestId:      opts.lzDestId,
      lzTokenAmount: opts.lzTokenAmount,
      nonce:         opts.nonce,
    },
  })
}

// ---------------------------------------------------------------------------
// depositForSponsored permit
// ---------------------------------------------------------------------------

export interface DepositForPermitOpts {
  /** CawProfileMinter deployed address */
  minterAddress: `0x${string}`
  chainId: number
  networkId: number
  tokenId: number
  amount: bigint
  lzDestId: number
  lzTokenAmount: bigint
  nonce: bigint
}

/**
 * Produce the EIP-712 digest for CawProfileMinter.depositForSponsored.
 */
export function buildDepositForPermitDigest(opts: DepositForPermitOpts): `0x${string}` {
  return hashTypedData({
    domain: {
      name: 'CawProfileMinter',
      version: '1',
      chainId: BigInt(opts.chainId),
      verifyingContract: opts.minterAddress,
    },
    types: {
      DepositFor: [
        { name: 'networkId',     type: 'uint32'  },
        { name: 'tokenId',       type: 'uint32'  },
        { name: 'amount',        type: 'uint256' },
        { name: 'lzDestId',      type: 'uint32'  },
        { name: 'lzTokenAmount', type: 'uint256' },
        { name: 'nonce',         type: 'uint256' },
      ],
    },
    primaryType: 'DepositFor',
    message: {
      networkId:     opts.networkId,
      tokenId:       opts.tokenId,
      amount:        opts.amount,
      lzDestId:      opts.lzDestId,
      lzTokenAmount: opts.lzTokenAmount,
      nonce:         opts.nonce,
    },
  })
}

// ---------------------------------------------------------------------------
// authenticateSponsored permit
// ---------------------------------------------------------------------------

export interface AuthenticatePermitOpts {
  /** CawProfileMinter deployed address */
  minterAddress: `0x${string}`
  chainId: number
  networkId: number
  tokenId: number
  lzDestId: number
  lzTokenAmount: bigint
  nonce: bigint
}

/**
 * Produce the EIP-712 digest for CawProfileMinter.authenticateSponsored.
 */
export function buildAuthenticatePermitDigest(opts: AuthenticatePermitOpts): `0x${string}` {
  return hashTypedData({
    domain: {
      name: 'CawProfileMinter',
      version: '1',
      chainId: BigInt(opts.chainId),
      verifyingContract: opts.minterAddress,
    },
    types: {
      Authenticate: [
        { name: 'networkId',     type: 'uint32'  },
        { name: 'tokenId',       type: 'uint32'  },
        { name: 'lzDestId',      type: 'uint32'  },
        { name: 'lzTokenAmount', type: 'uint256' },
        { name: 'nonce',         type: 'uint256' },
      ],
    },
    primaryType: 'Authenticate',
    message: {
      networkId:     opts.networkId,
      tokenId:       opts.tokenId,
      lzDestId:      opts.lzDestId,
      lzTokenAmount: opts.lzTokenAmount,
      nonce:         opts.nonce,
    },
  })
}
