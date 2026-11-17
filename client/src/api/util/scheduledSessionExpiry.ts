// Refuses a scheduled post whose session key is revoked, or expires before the
// post is due.
//
// A scheduled post is stored as a pre-signed action. When the scheduler
// publishes it, the action is checked against the session key that signed it;
// if that key has been revoked or has expired, the chain rejects it, which the
// user cannot act on. Checking at creation tells the user why, while they can
// still sign again.
//
// Only a session key that is recorded in the DB is checked. A signer that is
// not in the DB yet, or cannot be recovered, is allowed through (the same
// fail-open as the action route's early check; the contract still enforces the
// session at submission). The table is kept in step with chain events by the
// ChainSync indexer, so a session renewed a moment ago may still show its old
// expiry for a short while.

import { ethers } from 'ethers'
import { prisma } from '../../prismaClient'

export interface SessionRow {
  expirySec: number   // SessionKey.expiry, unix seconds (0 = not registered)
  revoked: boolean
}

export interface SessionConflict {
  sessionAddress: string
  expiresAt: number   // unix seconds
  reason: 'revoked' | 'expired'
}

/**
 * The address that signed a pre-signed action (`{ data, domain, types, signature }`),
 * lower-cased, or null when it cannot be recovered: the signature is not a
 * 65-byte ECDSA signature (a passkey blob is longer), or it does not parse.
 */
export function recoverSigner(signedAction: any): string | null {
  const { data, domain, types, signature } = signedAction ?? {}
  if (!data || !domain || !types?.ActionData || typeof signature !== 'string') return null
  try {
    if (ethers.dataLength(signature) !== 65) return null
    return ethers.verifyTypedData(domain, { ActionData: types.ActionData }, data, signature).toLowerCase()
  } catch {
    return null
  }
}

/**
 * The conflict, if any. A conflict is a signer that is a recorded session key of
 * `owner` and either revoked, or expiring at or before `scheduledSec`.
 * Owner signatures, unknown sessions and unregistered ones (expiry 0) return null.
 */
export function sessionExpiryConflict(input: {
  owner: string
  signer: string | null
  session: SessionRow | null
  scheduledSec: number
}): SessionConflict | null {
  const { owner, signer, session, scheduledSec } = input
  if (!signer || !session) return null
  if (signer === owner.toLowerCase()) return null
  if (session.revoked) return { sessionAddress: signer, expiresAt: session.expirySec, reason: 'revoked' }
  if (session.expirySec === 0) return null
  if (session.expirySec > scheduledSec) return null
  return { sessionAddress: signer, expiresAt: session.expirySec, reason: 'expired' }
}

/** Looks up the owner and the session row for a pre-signed action, then applies the rule. */
export async function checkScheduledSession(signedAction: any, scheduledAt: Date): Promise<SessionConflict | null> {
  const senderId = signedAction?.data?.senderId
  if (typeof senderId !== 'number') return null
  const sender = await prisma.user.findUnique({ where: { tokenId: senderId }, select: { address: true } })
  if (!sender?.address) return null
  const owner = sender.address.toLowerCase()
  const signer = recoverSigner(signedAction)
  if (!signer || signer === owner) return null
  const row = await prisma.sessionKey.findUnique({
    where: { ownerAddress_sessionAddress: { ownerAddress: owner, sessionAddress: signer } },
    select: { expiry: true, revokedAt: true },
  })
  return sessionExpiryConflict({
    owner,
    signer,
    session: row ? { expirySec: Number(row.expiry), revoked: row.revokedAt !== null } : null,
    scheduledSec: Math.floor(scheduledAt.getTime() / 1000),
  })
}
