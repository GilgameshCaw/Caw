// src/services/DmRelayService/index.ts
//
// After a DM is stored locally, relay it to other instances serving the
// same client so the message reaches users regardless of which instance
// they're connected to. Fire-and-forget — best effort delivery.
//
// Trust model: server-to-server with validator-key signatures.
//   - This node signs the relay envelope with VALIDATOR_PRIVATE_KEY
//     using the same secp256k1 curve and (r,s,v) recovery format as
//     Ethereum, but over a SHA-256 of the canonical envelope (not the
//     ethers eth-personal-sign prefix — avoids the "this looks like a
//     wallet message to a user" surface).
//   - Receiver verifies against this node's registered validatorAddress
//     in CawNetworkManager, looked up via the sourceInstanceId field
//     and the receiver's instanceRegistryService.getPeers cache.
//
// Peers come from instanceRegistryService.getPeers — same cache the
// /api/instances HTTP route reads from, so deactivations on chain
// flow through (per commit 26b1e60). We don't maintain a duplicate
// scan anymore.
//
// SSRF / URL-injection notes (audit 2026-05-22 M-2, M-3):
//   M-3 (URL path injection): All outbound peer fetches use buildPeerUrl()
//   which constructs the URL via `new URL()` and asserts no query string
//   or fragment in the base — prevents an injected apiUrl like
//   "https://evil.com?x=" from absorbing our path into a query param.
//   M-2 (DNS-rebind window): `isSafePublicUrl` in ssrfGuard.ts checks DNS
//   at peer-cache-warm time (InstanceRegistryService), NOT at fetch time.
//   Between cache-warm and the actual fetch, DNS can rebind to a private IP
//   (e.g. 169.254.169.254). Full mitigation requires pinning the resolved IP
//   and fetching via that IP with a Host header override, which breaks TLS
//   SNI / common-name validation on standard Node https.Agent. Residual risk
//   accepted for now: attacker must control both the peer's on-chain apiUrl
//   AND the DNS resolver that serves this node. Documented here per audit.

import 'dotenv/config'
import { getPeers, getOwnInstanceId } from '../InstanceRegistryService'
import { signCanonicalWithSigner } from '../InstanceRegistryService/envelopeCrypto'
import { getValidatorSigner, type ValidatorSigner } from '../../utils/signer'
import type { RelayEnvelope } from '../../api/routes/dm-relay'
import { canonicalizeEnvelope } from '../../api/routes/dm-relay'
import crypto from 'crypto'
import { getNetworkId } from '../../utils/networkId'

/**
 * Build a peer fetch URL using `new URL()` so path injection via a
 * maliciously-crafted apiUrl (e.g. "https://evil.com?x=") is blocked.
 *
 * Rules enforced (audit 2026-05-22 M-3):
 *   - apiUrl must not contain a query string or fragment — if it does,
 *     the path would be silently absorbed into the query param, sending
 *     the request to the wrong host.
 *   - The pathname is set (overwritten) explicitly to the given path so
 *     any trailing-path component in apiUrl also can't interfere.
 *
 * Throws on malformed apiUrl or disallowed query/fragment — callers
 * should catch and skip the peer rather than crashing the relay loop.
 */
function buildPeerUrl(apiUrl: string, path: string): string {
  const target = new URL(apiUrl)
  if (target.search || target.hash) {
    throw new Error(`peer apiUrl must have no query string or fragment: ${apiUrl}`)
  }
  target.pathname = path
  return target.toString()
}

function requireClientId(): number {
  const raw = getNetworkId()
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('DmRelayService: NETWORK_ID is required (set it in client/.env)')
  }
  return n
}


interface RelayParams {
  encryptedPayload: string
  senderId: number
  recipientId: number
  conversationId: string
  contentType?: string
  /**
   * Optional caller-supplied relayId. Defaults to a fresh UUID. Pass
   * one through if the caller wants to dedupe their own retries.
   */
  relayId?: string
  /**
   * Inner sender sig forwarded to peer mirrors. Distinct from the
   * outer relay sig (which authenticates this NODE). The senderSig
   * authenticates the ORIGINAL SENDER's wallet — it travels through
   * relay hops unchanged so peer mirrors can verify against their
   * cached DmIdentity.publicKey for senderId. Audit fix 2026-05-09
   * (Round 7 #1b).
   */
  senderSig?: string | null
  /**
   * Caller-supplied timestamp, MUST match what was passed to the FE
   * canonicalizer. We don't generate it here — it's part of the
   * canonical envelope the user signed.
   */
  timestamp?: number
}

let cachedSigner: ValidatorSigner | null = null
let signerInitTried = false
// One-shot address-mismatch guard. Fires on the first relay attempt after
// both the signer and ownInstanceId are resolved. If DM_RELAY_PRIVATE_KEY
// derives a different address than the on-chain validatorAddress for this
// instance, peers will reject our envelopes — so we hard-error and disable
// the relay loop rather than silently waste relay attempts.
let addressCheckDone = false
function getSigner(): ValidatorSigner | null {
  if (cachedSigner) return cachedSigner
  if (signerInitTried) return null
  signerInitTried = true
  try {
    // No provider needed — relay only calls signDigest, never sends txs.
    // Prefer DM_RELAY_PRIVATE_KEY so the DM signing key is isolated from
    // the chain-submission key. Falls back to VALIDATOR_PRIVATE_KEY for
    // back-compat (logs a startup warning below).
    const hasDmKey = Boolean(process.env.DM_RELAY_PRIVATE_KEY)
    if (!hasDmKey) {
      console.warn(
        '[DmRelay] DM_RELAY_PRIVATE_KEY not set — falling back to VALIDATOR_PRIVATE_KEY. ' +
        'Key compromise on chain validator now extends to DM forge surface. ' +
        'See messages/audit-2026-05-22/dm-relay-validator-trust.md.'
      )
    }
    cachedSigner = getValidatorSigner({
      privateKeyEnv: hasDmKey ? 'DM_RELAY_PRIVATE_KEY' : 'VALIDATOR_PRIVATE_KEY',
    })
    return cachedSigner
  } catch (err: any) {
    console.error('[DmRelay] Signer init failed:', err.message)
    return null
  }
}

/**
 * Relay a DM message to all peer instances. Fire-and-forget.
 *
 * Returns a count of attempted relays. Errors per peer are logged but
 * do not throw — the local message is already persisted, and the relay
 * is best-effort. If we don't yet know our own instanceId (registry
 * service hasn't finished selfRegister), we skip the relay; the next
 * message will pick it up.
 */
export async function relayDmToPeers(params: RelayParams): Promise<{ attempted: number }> {
  const signer = getSigner()
  if (!signer) {
    // No validator key — can't sign envelopes. Silent skip; this
    // matches frontend-only / api-only-without-validator nodes that
    // simply don't relay.
    return { attempted: 0 }
  }

  const sourceInstanceId = getOwnInstanceId()
  if (sourceInstanceId == null) {
    console.warn('[DmRelay] Skipping relay — own instanceId not yet resolved (registry still booting?)')
    return { attempted: 0 }
  }

  const clientId = requireClientId()

  // Address-mismatch guard (one-shot). Verifies the signing address derived
  // from DM_RELAY_PRIVATE_KEY (or fallback VALIDATOR_PRIVATE_KEY) matches
  // the on-chain validatorAddress registered for this instance. If they
  // differ, peers will reject every envelope we send, so we disable the
  // relay loop and log a hard error to force operator action.
  if (!addressCheckDone) {
    addressCheckDone = true
    const signingAddress = signer.getAddress().toLowerCase()
    const allPeers = getPeers(clientId)
    const ownEntry = allPeers.find(p => p.instanceId === sourceInstanceId)
    if (ownEntry) {
      const registeredAddress = ownEntry.validatorAddress.toLowerCase()
      const match = signingAddress === registeredAddress
      console.log(
        `[DmRelay] Address check — signing: ${signingAddress} | on-chain: ${registeredAddress} | ${match ? 'OK' : 'MISMATCH'}`
      )
      if (!match) {
        console.error(
          '[DmRelay] HARD ERROR: DM signing address does not match on-chain validatorAddress for this instance. ' +
          'Peers will reject all relay envelopes. Relay loop DISABLED. ' +
          'Register the DM_RELAY_PRIVATE_KEY address on-chain via CawNetworkManager.updateInstance() then restart.'
        )
        // Poison the cache so future calls skip without re-checking.
        cachedSigner = null
        return { attempted: 0 }
      }
    } else {
      // Own entry not in cache yet — selfRegister may still be in progress.
      // Reset the flag so the check runs again on the next relay attempt.
      addressCheckDone = false
    }
  }

  const peers = getPeers(clientId).filter(p => p.active && p.instanceId !== sourceInstanceId)
  if (peers.length === 0) return { attempted: 0 }

  const envelope: RelayEnvelope = {
    encryptedPayload: params.encryptedPayload,
    senderId: params.senderId,
    recipientId: params.recipientId,
    conversationId: params.conversationId,
    contentType: params.contentType ?? 'text',
    // Use the caller's timestamp if supplied — that's the timestamp
    // the inner sender sig commits to. Falling back to Date.now() is
    // the legacy path where senderSig is missing.
    timestamp: params.timestamp ?? Date.now(),
    relayId: params.relayId ?? crypto.randomUUID(),
    sourceInstanceId,
  }

  let signature: string
  try {
    signature = await signCanonicalWithSigner(canonicalizeEnvelope(envelope), signer)
  } catch (err: any) {
    console.error('[DmRelay] Signing failed (continuing without relay):', err.message)
    return { attempted: 0 }
  }

  const body = JSON.stringify({
    ...envelope,
    signature,
    senderSig: params.senderSig ?? null,
  })

  for (const peer of peers) {
    let peerUrl: string
    try {
      peerUrl = buildPeerUrl(peer.apiUrl, '/api/dm/relay')
    } catch (urlErr: any) {
      console.warn(`[DmRelay] Skipping peer ${peer.instanceId} — invalid apiUrl: ${urlErr.message}`)
      continue
    }
    fetch(peerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(err => {
      // Fire-and-forget. Network errors are routine (peer down,
      // unreachable). Don't spam the log on every failure.
      if (process.env.DM_RELAY_VERBOSE === '1') {
        console.warn(`[DmRelay] Failed to relay to ${peer.apiUrl}:`, err.message)
      }
    })
  }

  return { attempted: peers.length }
}

/**
 * Get the deterministic conversation ID for two users.
 */
export function deterministicConversationId(userA: number, userB: number): string {
  const min = Math.min(userA, userB)
  const max = Math.max(userA, userB)
  return `dm:${min}:${max}`
}

/**
 * Identity-relay envelope. The DmIdentity row contents (userId,
 * walletAddress, publicKey) are non-secret — anyone can fetch them
 * via /api/dm/identity/:userId — but the cross-instance relay still
 * needs validator-key authentication so a peer can't spoof someone
 * else's pubkey across the network. Receivers verify the sig matches
 * the source's registered validatorAddress AND that the relayed
 * walletAddress matches User.address[userId] in the receiver's DB
 * (the same wallet-binding check the local register endpoint applies).
 */
export interface IdentityRelayEnvelope {
  userId: number
  walletAddress: string
  publicKey: string
  timestamp: number
  sourceInstanceId: number
}

export function canonicalizeIdentityEnvelope(env: IdentityRelayEnvelope): string {
  return JSON.stringify({
    userId: env.userId,
    walletAddress: env.walletAddress,
    publicKey: env.publicKey,
    timestamp: env.timestamp,
    sourceInstanceId: env.sourceInstanceId,
  })
}

/**
 * Fan out a freshly-registered DmIdentity to peer instances. Mirrors
 * relayDmToPeers but for the identity row instead of the message body.
 * Fire-and-forget; failures don't block the user's local registration.
 */
export async function relayDmIdentityToPeers(params: {
  userId: number
  walletAddress: string
  publicKey: string
}): Promise<{ attempted: number }> {
  const signer = getSigner()
  if (!signer) return { attempted: 0 }

  const sourceInstanceId = getOwnInstanceId()
  if (sourceInstanceId == null) {
    console.warn('[DmRelay] Skipping identity relay — own instanceId not yet resolved')
    return { attempted: 0 }
  }

  const clientId = requireClientId()
  const peers = getPeers(clientId).filter(p => p.active && p.instanceId !== sourceInstanceId)
  if (peers.length === 0) return { attempted: 0 }

  const envelope: IdentityRelayEnvelope = {
    userId: params.userId,
    walletAddress: params.walletAddress,
    publicKey: params.publicKey,
    timestamp: Date.now(),
    sourceInstanceId,
  }

  let signature: string
  try {
    signature = await signCanonicalWithSigner(canonicalizeIdentityEnvelope(envelope), signer)
  } catch (err: any) {
    console.error('[DmRelay] Identity signing failed (continuing without relay):', err.message)
    return { attempted: 0 }
  }

  const body = JSON.stringify({ ...envelope, signature })

  for (const peer of peers) {
    let peerUrl: string
    try {
      peerUrl = buildPeerUrl(peer.apiUrl, '/api/dm/identity/relay')
    } catch (urlErr: any) {
      console.warn(`[DmRelay] Skipping peer ${peer.instanceId} — invalid apiUrl: ${urlErr.message}`)
      continue
    }
    fetch(peerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(err => {
      if (process.env.DM_RELAY_VERBOSE === '1') {
        console.warn(`[DmRelay] Failed to relay identity to ${peer.apiUrl}:`, err.message)
      }
    })
  }

  return { attempted: peers.length }
}
