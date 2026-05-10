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
//     in CawClientManager, looked up via the sourceInstanceId field
//     and the receiver's instanceRegistryService.getPeers cache.
//
// Peers come from instanceRegistryService.getPeers — same cache the
// /api/instances HTTP route reads from, so deactivations on chain
// flow through (per commit 26b1e60). We don't maintain a duplicate
// scan anymore.

import 'dotenv/config'
import { getPeers, getOwnInstanceId } from '../InstanceRegistryService'
import { signCanonical, hexToBytes } from '../InstanceRegistryService/envelopeCrypto'
import type { RelayEnvelope } from '../../api/routes/dm-relay'
import { canonicalizeEnvelope } from '../../api/routes/dm-relay'
import crypto from 'crypto'

function requireClientId(): number {
  const raw = process.env.CLIENT_ID
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('DmRelayService: CLIENT_ID is required (set it in client/.env)')
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

let cachedPrivateKey: Uint8Array | null = null
function getPrivateKey(): Uint8Array | null {
  if (cachedPrivateKey) return cachedPrivateKey
  const raw = process.env.VALIDATOR_PRIVATE_KEY
  if (!raw) return null
  try {
    cachedPrivateKey = hexToBytes(raw)
    return cachedPrivateKey
  } catch {
    console.error('[DmRelay] VALIDATOR_PRIVATE_KEY is not a valid hex string')
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
  const privateKey = getPrivateKey()
  if (!privateKey) {
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
    signature = signCanonical(canonicalizeEnvelope(envelope), privateKey)
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
    fetch(`${peer.apiUrl}/api/dm/relay`, {
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
  /**
   * Wallet-signed proof of the (userId, publicKey, walletAddress)
   * triple. Forwarded unchanged so peer mirrors can verify directly
   * against the wallet rather than trusting THIS node's relay-sig
   * claim. Optional during the FE migration window. Audit fix
   * 2026-05-09 (Round 7 #1c).
   */
  walletProof?: string | null
}): Promise<{ attempted: number }> {
  const privateKey = getPrivateKey()
  if (!privateKey) return { attempted: 0 }

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
    signature = signCanonical(canonicalizeIdentityEnvelope(envelope), privateKey)
  } catch (err: any) {
    console.error('[DmRelay] Identity signing failed (continuing without relay):', err.message)
    return { attempted: 0 }
  }

  const body = JSON.stringify({ ...envelope, signature, walletProof: params.walletProof ?? null })

  for (const peer of peers) {
    fetch(`${peer.apiUrl}/api/dm/identity/relay`, {
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
