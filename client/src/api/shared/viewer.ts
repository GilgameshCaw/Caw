import type { Request } from 'express'
import { prisma } from '../../prismaClient'
import { extractSession } from '../middleware/auth'

/**
 * Resolve the viewer for a public GET that personalises its response
 * (liked / bookmarked / poll vote).
 *
 * `x-user-id` is only a selector the client can set to anything, so it is never
 * trusted on its own. The same two checks as GET /api/bookmarks:
 *   1. The session must list this tokenId in authorizedTokenIds.
 *   2. The token's CURRENT owner on record must be one of the session's
 *      authorizedAddresses (closes the stale-session window after a transfer).
 *
 * Returns undefined when there is no header, no session, or either check fails,
 * so the caller serves the anonymous (non-personalised) response.
 */
export async function getVerifiedViewerId(req: Request): Promise<number | undefined> {
  const requestedId = Number(req.headers['x-user-id'])
  if (!requestedId || isNaN(requestedId)) return undefined

  await extractSession(req)
  if (!req.sessionData) return undefined
  if (!req.sessionData.authorizedTokenIds.includes(requestedId)) return undefined

  const user = await prisma.user.findUnique({
    where: { tokenId: requestedId },
    select: { address: true },
  })
  if (!user || !user.address) return undefined
  const ownerAddress = user.address.toLowerCase()
  const authedAddresses = (req.sessionData.authorizedAddresses || []).map((a: string) => a.toLowerCase())
  return authedAddresses.includes(ownerAddress) ? requestedId : undefined
}
