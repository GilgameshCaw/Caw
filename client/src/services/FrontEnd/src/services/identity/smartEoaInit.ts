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
 * The sponsor server has its own ethers copy (SponsorService/smartEoaInit.ts);
 * the two are pinned to the same vector by tests on both sides.
 */
import { concat, encodeAbiParameters, keccak256, toHex, zeroAddress, type Hex } from 'viem'
import { serializeSignature, sign } from 'viem/accounts'

export type SmartEoaInitArgs = {
  chainId: number
  /** The delegated EOA (address(this) inside SmartEOA). */
  account: `0x${string}`
  pubkeyX: `0x${string}`
  pubkeyY: `0x${string}`
  ecdsaFallback: `0x${string}`
  /** CawProfileMinter for the L1 bootstrap; zero address for the standalone L2 leg. */
  minterContract: `0x${string}`
  /** Encoded mintAndDepositSponsored call, or '0x' for the standalone L2 leg. */
  mintCalldata: Hex
}

/** Args for the standalone (enroll-only, no mint) initialize used on L2. */
export function standaloneInitArgs(a: Omit<SmartEoaInitArgs, 'minterContract' | 'mintCalldata'>): SmartEoaInitArgs {
  return { ...a, minterContract: zeroAddress, mintCalldata: '0x' }
}

export function smartEoaInitDigest(a: SmartEoaInitArgs): Hex {
  const domainSep = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [keccak256(toHex('SmartEOA')), BigInt(a.chainId), a.account],
  ))
  const structHash = keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'address' },
      { type: 'bytes32' },
    ],
    [
      keccak256(toHex('initialize')),
      a.pubkeyX,
      a.pubkeyY,
      a.ecdsaFallback,
      a.minterContract,
      keccak256(a.mintCalldata),
    ],
  ))
  return keccak256(concat(['0x1901', domainSep, structHash]))
}

/** Sign the initialize digest with the EOA's raw 32-byte secp256k1 key → 65-byte r || s || v. */
export async function signSmartEoaInit(privateKey: Uint8Array, a: SmartEoaInitArgs): Promise<Hex> {
  if (privateKey.length !== 32) {
    throw new Error(`Private key must be 32 bytes; got ${privateKey.length}`)
  }
  const signature = await sign({ hash: smartEoaInitDigest(a), privateKey: toHex(privateKey) })
  return serializeSignature(signature)
}
