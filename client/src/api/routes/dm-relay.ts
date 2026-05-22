// src/api/routes/dm-relay.ts
//
// Cross-instance DM relay endpoint. Other instances POST encrypted DM
// payloads here so messages reach users regardless of which instance
// they're connected to.
//
// Trust model: server-to-server with validator-key signatures. The
// source instance's home node signs the relay envelope with its
// VALIDATOR_PRIVATE_KEY (same key it uses for on-chain submissions);
// receivers verify against the source's registered validatorAddress
// from CawNetworkManager via instanceRegistryService.getPeers(). This
// authenticates which node operator emitted a relay — DM body
// confidentiality is independent of the relay layer (AES-GCM
// auth-tag rejection means a malicious relayer can never put words
// in a user's mouth, only surface phantom conversation entries).
//
// Spam controls:
//   - Per-source-IP rate limit mounted at the route level (server.ts).
//   - Per-(senderId, recipientId) bucket applied in dm.ts on the SEND
//     path; the receiver here trusts that the source instance enforced
//     it. A misbehaving source surfaces as repeated rejections / 429s
//     and gets blacklisted at the host-trust layer (future work).

import { Router } from 'express'
import dmWebSocketService from '../../services/DmService/websocket'
import { prisma } from '../../prismaClient'
import { getPeers } from '../../services/InstanceRegistryService'
import { recoverAddressFromCanonical } from '../../services/InstanceRegistryService/envelopeCrypto'
import { verifyDmSenderSig } from '../dmSenderSig'
import { getNetworkId } from '../../utils/networkId'

const router = Router()

const CLIENT_ID = (() => {
  const raw = getNetworkId()
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('dm-relay: NETWORK_ID is required (set it in client/.env)')
  }
  return n
})()

/**
 * Canonical byte form of the relay envelope. Both signing (DmRelayService
 * on the source) and verification (this route) compute the same SHA-256
 * over this exact serialization. Field order is fixed; JSON.stringify
 * with the exact key order below produces a stable canonical bytes.
 */
export interface RelayEnvelope {
  encryptedPayload: string
  senderId: number
  recipientId: number
  conversationId: string
  contentType: string
  timestamp: number
  relayId: string
  sourceInstanceId: number
}

export function canonicalizeEnvelope(env: RelayEnvelope): string {
  return JSON.stringify({
    encryptedPayload: env.encryptedPayload,
    senderId: env.senderId,
    recipientId: env.recipientId,
    conversationId: env.conversationId,
    contentType: env.contentType,
    timestamp: env.timestamp,
    relayId: env.relayId,
    sourceInstanceId: env.sourceInstanceId,
  })
}

router.post('/', async (req, res) => {
  try {
    const {
      encryptedPayload,
      senderId,
      recipientId,
      conversationId,
      contentType = 'text',
      timestamp,
      relayId,
      sourceInstanceId,
      signature,
      senderSig,
    } = req.body

    // Single source-IP for diagnostic purposes — every 400 below logs
    // this so operators can grep nginx → app logs by source.
    const remote = req.ip || req.headers['x-real-ip'] || 'unknown'

    if (
      !encryptedPayload || senderId == null || recipientId == null ||
      !conversationId || !timestamp || !relayId || sourceInstanceId == null || !signature
    ) {
      const present = {
        encryptedPayload: !!encryptedPayload, senderId: senderId != null,
        recipientId: recipientId != null, conversationId: !!conversationId,
        timestamp: !!timestamp, relayId: !!relayId,
        sourceInstanceId: sourceInstanceId != null, signature: !!signature,
      }
      console.warn(`[DM Relay] 400 missing fields from ${remote}:`, JSON.stringify(present))
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Replay window. ±5min covers clock skew between operators; -1min
    // tolerance also accepts envelopes timestamped slightly in the
    // future (NTP drift) without going crazy.
    const age = Date.now() - Number(timestamp)
    if (age > 5 * 60 * 1000 || age < -60 * 1000) {
      console.warn(`[DM Relay] 400 timestamp out of range from ${remote} (sourceInstance=${sourceInstanceId}): age=${age}ms (envelope ts=${timestamp}, now=${Date.now()})`)
      return res.status(400).json({ error: 'Message timestamp out of range' })
    }

    // Deterministic conversationId. Both sides compute it the same way,
    // so a mismatch means the source got the senders/recipients wrong
    // (or is trying to inject into the wrong conversation).
    const minId = Math.min(Number(senderId), Number(recipientId))
    const maxId = Math.max(Number(senderId), Number(recipientId))
    const expectedConvId = `dm:${minId}:${maxId}`
    if (conversationId !== expectedConvId) {
      console.warn(`[DM Relay] 400 invalid conversationId from ${remote} (sourceInstance=${sourceInstanceId}): got=${conversationId} expected=${expectedConvId} (sender=${senderId}, recipient=${recipientId})`)
      return res.status(400).json({ error: 'Invalid conversation ID format' })
    }

    // Look up the source instance's registered validator address from
    // the on-chain registry cache. We require an active registration —
    // a deactivated instance loses relay privileges immediately.
    const peers = getPeers(CLIENT_ID)
    const source = peers.find(p => p.instanceId === Number(sourceInstanceId))
    if (!source || !source.active) {
      console.warn(`[DM Relay] 403 unknown/inactive source from ${remote}: sourceInstance=${sourceInstanceId} (active peers: ${peers.filter(p => p.active).map(p => p.instanceId).join(',') || 'none'})`)
      return res.status(403).json({ error: 'Unknown or inactive source instance' })
    }

    // Verify the validator-key signature against the source's
    // registered address. ecrecover-style: recover the signing address
    // from (r,s,v) over SHA-256(canonical envelope), then compare.
    const envelope: RelayEnvelope = {
      encryptedPayload, senderId: Number(senderId), recipientId: Number(recipientId),
      conversationId, contentType, timestamp: Number(timestamp),
      relayId, sourceInstanceId: Number(sourceInstanceId),
    }
    let recoveredAddr: string
    try {
      recoveredAddr = await recoverAddressFromCanonical(canonicalizeEnvelope(envelope), signature)
    } catch (err: any) {
      console.warn(`[DM Relay] 403 sig recover failed from ${remote} (sourceInstance=${sourceInstanceId}): ${err.message}`)
      return res.status(403).json({ error: 'Signature verification failed' })
    }
    if (recoveredAddr.toLowerCase() !== source.validatorAddress.toLowerCase()) {
      console.warn(`[DM Relay] 403 sig mismatch from ${remote} (sourceInstance=${sourceInstanceId}): recovered=${recoveredAddr} expected=${source.validatorAddress}`)
      return res.status(403).json({ error: 'Signature does not match source instance validator' })
    }

    // Block check (either direction). If the recipient blocked the sender
    // they shouldn't see the message; if the sender blocked the recipient
    // we still drop it on this side since cross-block is a hard wall.
    const blocked = await prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: Number(recipientId), blockedId: Number(senderId) },
          { blockerId: Number(senderId), blockedId: Number(recipientId) },
        ]
      }
    })
    if (blocked) {
      return res.status(403).json({ error: 'Blocked' })
    }

    // Privacy gate. EVERYONE accepts; FOLLOWERS / FOLLOWING only accept
    // if the consent baseline is met. Once a conversation exists, the
    // recipient already accepted (or replied), so privacy reduces to
    // first-contact rules only.
    const recipientIdentity = await prisma.dmIdentity.findUnique({
      where: { userId: Number(recipientId) }
    })
    const existingConv = await prisma.conversation.findUnique({
      where: { id: conversationId }
    })
    const isFirstContact = !existingConv
    if (recipientIdentity?.dmPrivacy && recipientIdentity.dmPrivacy !== 'EVERYONE' && isFirstContact) {
      if (recipientIdentity.dmPrivacy === 'FOLLOWERS') {
        const follows = await prisma.follow.findFirst({
          where: { followerId: Number(recipientId), followingId: Number(senderId), action: 'FOLLOW' }
        })
        if (!follows) return res.status(403).json({ error: 'DM_PRIVACY', reason: 'FOLLOWERS' })
      } else if (recipientIdentity.dmPrivacy === 'FOLLOWING') {
        const follower = await prisma.follow.findFirst({
          where: { followerId: Number(senderId), followingId: Number(recipientId), action: 'FOLLOW' }
        })
        if (!follower) return res.status(403).json({ error: 'DM_PRIVACY', reason: 'FOLLOWING' })
      }
    }

    // Dedup. Message.relayId is partial-unique; the same envelope
    // arriving twice (legitimate retry, or a malicious replay inside
    // the 5-min window) hits the unique index and we 200-noop with
    // the existing message id. The caller treats both the same way.
    const existing = await prisma.message.findUnique({
      where: { relayId },
      select: { id: true },
    })
    if (existing) {
      return res.json({ status: 'duplicate', messageId: existing.id })
    }

    // Determine the recipient's inbox status for this conversation:
    //   - First contact + sender doesn't follow recipient + recipient
    //     doesn't follow sender → REQUEST. Lands in the Requests tab.
    //   - Otherwise (existing conversation, or mutual-follow baseline) →
    //     ACCEPTED. The send-side participant always gets ACCEPTED.
    let recipientStatus: 'ACCEPTED' | 'REQUEST' = 'ACCEPTED'
    if (isFirstContact) {
      const [senderFollowsRecipient, recipientFollowsSender] = await Promise.all([
        prisma.follow.findFirst({
          where: { followerId: Number(senderId), followingId: Number(recipientId), action: 'FOLLOW' }
        }),
        prisma.follow.findFirst({
          where: { followerId: Number(recipientId), followingId: Number(senderId), action: 'FOLLOW' }
        }),
      ])
      if (!senderFollowsRecipient && !recipientFollowsSender) {
        recipientStatus = 'REQUEST'
      }
    }

    // Get-or-create the conversation. On first contact we set the
    // recipient's participant.status per the rule above; the sender's
    // is always ACCEPTED.
    let conversation = existingConv
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          id: conversationId,
          type: 'DM',
          creatorId: Number(senderId),
          participants: {
            create: [
              { userId: Number(senderId), status: 'ACCEPTED' },
              { userId: Number(recipientId), status: recipientStatus },
            ]
          }
        }
      })
    } else {
      // Existing conversation — make sure the sender is a participant.
      // Idempotent upsert; status only set on insert.
      await prisma.conversationParticipant.upsert({
        where: { conversationId_userId: { conversationId, userId: Number(senderId) } },
        create: { conversationId, userId: Number(senderId), status: 'ACCEPTED' },
        update: {},
      })
    }

    // Verify the inner sender sig (Round 7 #1b). The sig is signed
    // over the canonical envelope by the user's DmIdentity secp256k1
    // private key, which itself is wallet-derived. We look up the
    // recipient's record of senderId's publicKey — if it doesn't
    // exist (e.g. cross-instance identity not yet relayed), we leave
    // `verifiedSender = null` and the FE filters it out of the badge.
    let verifiedSender: boolean | null = null
    if (senderSig && typeof senderSig === 'string') {
      const senderIdentity = await prisma.dmIdentity.findUnique({
        where: { userId: Number(senderId) },
        select: { publicKey: true },
      })
      if (senderIdentity?.publicKey) {
        verifiedSender = verifyDmSenderSig(
          { encryptedPayload, senderId: Number(senderId), recipientId: Number(recipientId),
            conversationId, contentType, timestamp: Number(timestamp) },
          senderSig, senderIdentity.publicKey,
        )
      }
    }

    // Write the message. relayId is the dedup key; on race (concurrent
    // duplicate inbound) Postgres rejects with P2002, we catch and
    // re-fetch.
    let messageRecord
    try {
      messageRecord = await prisma.message.create({
        data: {
          conversationId,
          senderId: Number(senderId),
          encryptedPayload,
          contentType,
          relayId,
          senderSig: senderSig || null,
          verifiedSender,
        },
        include: {
          sender: {
            include: {
              user: { select: { username: true, displayName: true, avatarUrl: true, defaultAvatarId: true, tokenId: true } }
            }
          }
        }
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const existingAfterRace = await prisma.message.findUnique({ where: { relayId }, select: { id: true } })
        return res.json({ status: 'duplicate', messageId: existingAfterRace?.id })
      }
      throw err
    }

    // Conversation metadata + recipient unread count.
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: messageRecord.createdAt, lastMessageId: messageRecord.id }
    })
    await prisma.conversationParticipant.updateMany({
      where: { conversationId, userId: Number(recipientId) },
      data: { unreadCount: { increment: 1 } }
    })

    // WS push to anyone connected to this node's `conversation:${id}`
    // room. Cross-node WS bridging is a separate problem (deferred);
    // recipients connected to a different node will see the message
    // when their FE next polls / refetches.
    dmWebSocketService.broadcastMessage(messageRecord)

    return res.json({ status: 'relayed', messageId: messageRecord.id })
  } catch (error: any) {
    console.error('[DM Relay] Error:', error.message)
    return res.status(500).json({ error: 'Relay failed' })
  }
})

export default router
