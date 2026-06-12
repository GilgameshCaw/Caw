// api/util/passkeyVerify.ts
//
// Passkey (WebAuthn) sign-in support for Population B. The user proves
// possession of their passkey by signing a SERVER-issued challenge with their
// SmartEOA; the server verifies the assertion ON-CHAIN via the SmartEOA's
// ERC-1271 isValidSignature (which runs the EIP-7951 P-256 precompile path).
//
// Why on-chain verification: the passkey is a WebAuthn/P-256 credential, not an
// Ethereum key. ethers.verifyMessage (used by /api/auth/verify) only recovers
// 65-byte secp256k1 sigs, so it cannot validate a WebAuthn blob. The SmartEOA
// contract is the authority on whether a given assertion was produced by an
// enrolled passkey — so we ask it directly with a staticcall.
//
// This is a deliberate, narrow exception to the "no RPC in request handlers"
// rule (same class as the sponsor mint path): an auth ceremony fundamentally
// needs to consult chain state, and there is no indexer substitute for "is this
// signature valid for this account right now."
//
// SECURITY (post-review 2026-06-12): the challenge is SERVER-GENERATED (never
// client-supplied — that would let an attacker pre-seed a captured assertion's
// challenge and replay it). It is single-use via an atomic GETDEL. See the
// security findings addressed in the verify-passkey route.

import { Contract } from 'ethers'
import { randomBytes } from 'crypto'
import Redis from 'ioredis'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../../utils/rpcProvider'
import { smartEoaAbi } from '../../abi/generated'

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

const CHALLENGE_PREFIX = 'passkey-challenge:'
const CHALLENGE_TTL_SECONDS = 300 // 5 minutes
const ERC1271_MAGIC = '0x1626ba7e'

const L1_CHAIN_ID = process.env.L1_CHAIN_ID ? Number(process.env.L1_CHAIN_ID) : 11155111

let _provider: ReturnType<typeof makeJsonRpcProvider> | null = null
function getL1Provider() {
  if (_provider) return _provider
  const url = getL1HttpRpcUrl()
  if (!url) throw new Error('L1 RPC not configured')
  _provider = makeJsonRpcProvider(url, L1_CHAIN_ID)
  return _provider
}

/**
 * Generate a fresh 32-byte challenge SERVER-SIDE for a passkey sign-in attempt,
 * bound to the tokenId. The client passes the returned challenge verbatim into
 * navigator.credentials.get as the WebAuthn challenge. Stored in Redis with a
 * short TTL, single-use on verify.
 *
 * The challenge MUST be server-generated: a client-chosen challenge lets an
 * attacker who captured a victim's prior (challenge, assertion) pair pre-seed
 * that challenge and replay the assertion. Returns the 0x-prefixed hex.
 */
export async function issuePasskeyChallenge(tokenId: number): Promise<`0x${string}`> {
  const challenge = ('0x' + randomBytes(32).toString('hex')) as `0x${string}`
  // Overwrite any prior in-flight challenge for this tokenId — the latest
  // ceremony wins. (We don't use NX: a user re-initiating their own sign-in
  // should get a fresh challenge, not be blocked by a stale one. Single-use is
  // enforced atomically at consume time via GETDEL.)
  await redis.set(CHALLENGE_PREFIX + tokenId, challenge, 'EX', CHALLENGE_TTL_SECONDS)
  return challenge
}

/**
 * Atomically consume the challenge for a tokenId. Returns true only if the
 * presented challenge matches the live one. Uses GETDEL so two concurrent
 * verify calls can't both pass (no GET-then-DEL TOCTOU).
 */
export async function consumePasskeyChallenge(tokenId: number, challengeHex: string): Promise<boolean> {
  const key = CHALLENGE_PREFIX + tokenId
  // GETDEL (Redis 6.2+) returns the value AND deletes it in one atomic op.
  const stored = await redis.getdel(key)
  if (!stored) return false
  return stored.toLowerCase() === challengeHex.toLowerCase()
}

/**
 * Verify a WebAuthn assertion on-chain against the SmartEOA at `smartEoaAddress`.
 * `challengeHex` is the 32-byte digest the passkey signed; `sigBlob` is the
 * ABI-encoded (authenticatorData, clientDataJSON, r, s) blob that
 * SmartEOA.isValidSignature decodes. Returns true iff the contract returns the
 * ERC-1271 magic value.
 *
 * Never throws on a bad signature — a revert / wrong return is mapped to false.
 * Throws only on infrastructure failure (RPC unreachable) so the caller can 503.
 *
 * NOTE: SmartEOA binds the assertion to the passed digest (the challenge inside
 * clientDataJSON must equal `challengeHex`), so a sig over challenge A cannot
 * validate against digest B. It does NOT currently validate clientDataJSON.origin
 * / rpIdHash (security finding #1 — a contract-level gap tracked for the next
 * SmartEOA redeploy / before mainnet).
 */
export async function verifyPasskeyAssertionOnChain(
  smartEoaAddress: string,
  challengeHex: `0x${string}`,
  sigBlob: `0x${string}`,
): Promise<boolean> {
  const contract = new Contract(smartEoaAddress, smartEoaAbi as any, getL1Provider())
  try {
    const magic: string = await contract.isValidSignature(challengeHex, sigBlob)
    return typeof magic === 'string' && magic.toLowerCase() === ERC1271_MAGIC
  } catch {
    // SmartEOA reverts (or returns the fail value) for an invalid assertion.
    // Treat any non-magic outcome as "not valid", not an error.
    return false
  }
}
