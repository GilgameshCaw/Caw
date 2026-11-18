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
// challenge and replay it). It is single-use via an atomic DEL of its own
// key; each ceremony has its own key, so two ceremonies never cancel each
// other. See the
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
const CHALLENGE_PATTERN = /^0x[0-9a-fA-F]{64}$/
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

// The part of the Redis client these helpers use, so a test can swap in an
// in-memory stub (the other route and util tests do the same).
type ChallengeStore = Pick<Redis, 'set' | 'del'>
let _storeOverride: ChallengeStore | null = null
export function _setChallengeStoreForTest(store: ChallengeStore | null): void {
  _storeOverride = store
}
function challengeStore(): ChallengeStore {
  return _storeOverride ?? redis
}

// What a challenge was issued for. The routes that issue and the routes that
// consume are paired: sign-in issues and consumes 'signin'; the backup routes
// issue and consume 'backup'. A challenge from one is refused by the other.
export type PasskeyChallengePurpose = 'signin' | 'backup'

// One key per issued challenge: the key carries the purpose, the tokenId and the challenge.
function challengeKey(tokenId: number, purpose: PasskeyChallengePurpose, challengeHex: string): string {
  return `${CHALLENGE_PREFIX}${purpose}:${tokenId}:${challengeHex.toLowerCase()}`
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
 *
 * Each call gets its own key and leaves earlier challenges of the same tokenId
 * alone. The issuing routes take only a tokenId or an address, with no login,
 * so with one slot per tokenId anyone could cancel another person's ceremony
 * in progress, and two tabs of one person cancelled each other. An earlier
 * challenge stays valid until it is used or its TTL ends.
 *
 * A challenge is issued for one purpose and consumed only for that purpose.
 */
export async function issuePasskeyChallenge(tokenId: number, purpose: PasskeyChallengePurpose): Promise<`0x${string}`> {
  const challenge = ('0x' + randomBytes(32).toString('hex')) as `0x${string}`
  const saved = await challengeStore().set(challengeKey(tokenId, purpose, challenge), '1', 'EX', CHALLENGE_TTL_SECONDS, 'NX')
  if (saved !== 'OK') throw new Error('Could not issue a passkey challenge')
  return challenge
}

/**
 * Atomically consume a challenge issued for a tokenId. Returns true only if
 * this exact challenge is live for this tokenId, and then removes it: DEL
 * reports how many keys it removed, so two concurrent verify calls can't both
 * pass (no GET-then-DEL TOCTOU).
 */
export async function consumePasskeyChallenge(tokenId: number, challengeHex: string, purpose: PasskeyChallengePurpose): Promise<boolean> {
  // The presented string becomes part of a Redis key: accept only the shape
  // issuePasskeyChallenge produces.
  if (typeof challengeHex !== 'string' || !CHALLENGE_PATTERN.test(challengeHex)) return false
  return (await challengeStore().del(challengeKey(tokenId, purpose, challengeHex))) === 1
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
