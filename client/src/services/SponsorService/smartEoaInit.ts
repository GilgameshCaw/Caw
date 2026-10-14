/**
 * SmartEOA.initialize authorization (initSig).
 *
 * SmartEOA.initialize only accepts a 65-byte secp256k1 sig by the delegated
 * EOA's own key over every initialize argument. Without it, anyone who reaches
 * a delegated-but-uninitialized EOA first (a copied 7702 auth tuple in the
 * public mempool, or a type-4 tx whose body reverted after the delegation was
 * applied) could set their own passkey and fallback.
 *
 * Mirrors SmartEOA._initializeDigest:
 *   domainSep  = keccak256(abi.encode(keccak256("SmartEOA"), chainId, account))
 *   structHash = keccak256(abi.encode(keccak256("initialize"), pubkeyX, pubkeyY,
 *                                     ecdsaFallback, minterContract, keccak256(mintCalldata)))
 *   digest     = keccak256("\x19\x01" || domainSep || structHash)
 *
 * The FE has its own viem copy in services/identity/smartEoaInit.ts; the two are
 * pinned to the same vector by tests on both sides.
 */
import { AbiCoder, concat, keccak256, recoverAddress, toUtf8Bytes } from 'ethers'

export interface SmartEoaInitArgs {
  chainId: bigint | number
  /** The delegated EOA (address(this) inside SmartEOA). */
  account: string
  pubkeyX: string
  pubkeyY: string
  ecdsaFallback: string
  /** CawProfileMinter for the L1 bootstrap; the zero address for the standalone L2 leg. */
  minterContract: string
  /** Encoded mintAndDepositSponsored call, or '0x' for the standalone L2 leg. */
  mintCalldata: string
}

export function smartEoaInitDigest(a: SmartEoaInitArgs): string {
  const coder = AbiCoder.defaultAbiCoder()
  const domainSep = keccak256(coder.encode(
    ['bytes32', 'uint256', 'address'],
    [keccak256(toUtf8Bytes('SmartEOA')), BigInt(a.chainId), a.account],
  ))
  const structHash = keccak256(coder.encode(
    ['bytes32', 'bytes32', 'bytes32', 'address', 'address', 'bytes32'],
    [
      keccak256(toUtf8Bytes('initialize')),
      a.pubkeyX,
      a.pubkeyY,
      a.ecdsaFallback,
      a.minterContract,
      keccak256(a.mintCalldata),
    ],
  ))
  return keccak256(concat(['0x1901', domainSep, structHash]))
}

/**
 * Pre-flight: does initSig recover to `account` for these arguments? A mismatch
 * is a guaranteed on-chain InvalidInitSig revert, so callers reject before
 * spending gas. Returns the recovered address (or null if the sig is malformed).
 */
export function recoverSmartEoaInitSigner(a: SmartEoaInitArgs, initSig: string): string | null {
  try {
    if (!/^0x[0-9a-fA-F]{130}$/.test(initSig)) return null
    return recoverAddress(smartEoaInitDigest(a), initSig)
  } catch {
    return null
  }
}
