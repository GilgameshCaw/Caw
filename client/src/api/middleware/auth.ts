import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getSession, SessionData } from '../sessionStore'
import { prisma } from '../../prismaClient'

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: any
      sessionData?: SessionData | null
      sessionToken?: string | null
      // Set by requireAuth({ verifyOwnership: true }) — the lowercased
      // current owner of the requested token. Handlers can use it
      // directly instead of re-querying.
      tokenOwnerAddress?: string
      // Set by requireModerator on success. Identifies WHICH of the
      // user's authorized tokens holds the moderator role, so audit
      // logs can attribute the action.
      moderatorActorTokenId?: number | null
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.warn('[Auth] WARNING: JWT_SECRET not set. JWT authentication will reject all tokens.')
}

// Explicit opt-in for Secure cookie flag. Set COOKIE_SECURE=true in prod.env.
// Gating on NODE_ENV is unreliable — operators often leave it unset on VPS,
// which would silently send caw_session over plaintext HTTP on port 4000.
// Hard-warn (not hard-fail) at boot so a missing flag surfaces in logs
// immediately rather than being discovered during a security review.
// Audit fix 2026-05-23 (fe-headers H-1).
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'
if (!COOKIE_SECURE && process.env.NODE_ENV === 'production') {
  console.warn(
    '[Auth] WARNING: COOKIE_SECURE is not set to "true" but NODE_ENV=production. ' +
    'Session cookies will be sent without the Secure flag. Set COOKIE_SECURE=true in client/.env for production deploys.'
  )
}

// --- Wallet session cookie ---
// The wallet session token (from sessionStore.ts, created in /api/auth/verify)
// can now also ride on an HttpOnly cookie. JS can't read it, so an XSS payload
// in our frontend can't exfiltrate the token for replay; it can only make
// authenticated requests while the page is open (which it could do regardless).
//
// We keep the x-session-token header path during a migration window so
// existing browser sessions don't all get kicked out. Once the cookie path is
// in production for a while, the header path can be removed.
// __Host- prefix forces Secure + forbids Domain attribute + requires path=/.
// This closes the subdomain-set cookie attack (e.g. uploads.caw.social
// overwriting caw_session for the parent). BREAKING: existing caw_session
// cookies on test.caw.social are invalidated; users must re-sign-in.
// Fix: audit M-4.
//
// Dev caveat: the __Host- prefix REQUIRES Secure per the browser spec, so
// browsers silently reject any __Host- Set-Cookie sent over plain HTTP.
// Local dev runs HTTP (with COOKIE_SECURE unset), so we fall back to the
// plain name there. Prod (HTTPS + COOKIE_SECURE=true) keeps the prefix.
export const SESSION_COOKIE_NAME = COOKIE_SECURE ? '__Host-caw_session' : 'caw_session'
// 1 year — matches SESSION_TTL in sessionStore.ts so cookie and Redis entry
// expire together.
const SESSION_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000

/**
 * Cookie options for the wallet session.
 *
 * SameSite=Lax (not Strict like admin): the wallet session needs to survive
 * top-level navigations back from external redirects (X OAuth, on-ramp
 * checkout, payment-provider returns). Strict would drop the cookie on those
 * cross-site navigations and force a re-auth on every return-from-X flow.
 * Lax still defeats the typical CSRF vector — requests initiated by another
 * site's JS don't carry the cookie; only top-level GETs do, and our session-
 * required endpoints are POST/PATCH/DELETE.
 *
 * HttpOnly so JS can't read or exfiltrate it on XSS. Secure in production.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Gate on explicit COOKIE_SECURE=true, not NODE_ENV. An operator running
    // with NODE_ENV unset (or =development) on a prod VPS would otherwise get
    // cookies sent without Secure over plain HTTP on port 4000. COOKIE_SECURE
    // must be set to "true" in client/.env for production deploys.
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE,
  }
}

/**
 * Manually parse a single named cookie from the Cookie header — avoids adding cookie-parser as a dep.
 */
function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim())
      } catch {
        // Malformed percent-encoding — treat as absent rather than throwing a
        // 500 or, worse, letting the caller's catch block silently treat auth
        // as passed. Audit fix 2026-05-23 (fe-headers M-4).
        return undefined
      }
    }
  }
  return undefined
}

// --- Wallet-bound admin/moderator auth ---
//
// Bootstrap admins — comma-separated list of tokenIds treated as ADMIN
// even if their User.role is still 'USER' in the DB. Lets a fresh
// deploy promote the first admin without a manual SQL update.
// Empty list means no env-admins; token must have role=ADMIN in DB.
const ADMIN_TOKEN_IDS = (() => {
  return (process.env.ADMIN_TOKEN_IDS ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
})()

/**
 * Resolve the first authorized tokenId that qualifies as an admin,
 * first checking ADMIN_TOKEN_IDS env list then the DB role.
 * Returns the matching tokenId or null.
 */
async function resolveAdminTokenId(authorized: number[]): Promise<number | null> {
  if (authorized.length === 0) return null
  const bootstrapHit = authorized.find(id => ADMIN_TOKEN_IDS.includes(id))
  if (bootstrapHit !== undefined) return bootstrapHit
  const elevated = await prisma.user.findFirst({
    where: { tokenId: { in: authorized }, role: 'ADMIN' },
    select: { tokenId: true },
  })
  return elevated?.tokenId ?? null
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  await extractSession(req)
  if (!req.sessionData) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Session token required' })
    return
  }
  const authorized = req.sessionData.authorizedTokenIds || []
  const tokenId = await resolveAdminTokenId(authorized)
  if (tokenId === null) {
    res.status(403).json({ error: 'NOT_ADMIN', message: 'Account is not authorized for this action' })
    return
  }
  req.moderatorActorTokenId = tokenId
  next()
}

// --- Wallet-bound moderator auth ---
//
// Accepts a wallet session whose authorizedTokenIds includes a User with
// role MODERATOR or ADMIN (or is in ADMIN_TOKEN_IDS env list).
//
// On success, sets req.moderatorActorTokenId to the tokenId that holds
// the role. Audit-log writers should use it as the actor.
export async function requireModerator(req: Request, res: Response, next: NextFunction): Promise<void> {
  await extractSession(req)
  if (!req.sessionData) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Session token required' })
    return
  }

  const authorized = req.sessionData.authorizedTokenIds || []
  if (authorized.length === 0) {
    res.status(403).json({ error: 'NOT_MODERATOR', message: 'Account is not authorized to moderate' })
    return
  }

  // Bootstrap fast path: ADMIN_TOKEN_IDS skips the DB read.
  const bootstrapHit = authorized.find(id => ADMIN_TOKEN_IDS.includes(id))
  if (bootstrapHit !== undefined) {
    req.moderatorActorTokenId = bootstrapHit
    next()
    return
  }

  // Find any authorized token whose User has role MODERATOR or ADMIN.
  const elevated = await prisma.user.findFirst({
    where: { tokenId: { in: authorized }, role: { in: ['MODERATOR', 'ADMIN'] } },
    select: { tokenId: true },
  })
  if (!elevated) {
    res.status(403).json({ error: 'NOT_MODERATOR', message: 'Account is not authorized to moderate' })
    return
  }

  req.moderatorActorTokenId = elevated.tokenId
  next()
}

// Stricter sibling: rejects MODERATOR — wallet must have role=ADMIN
// (or be in ADMIN_TOKEN_IDS env list). Used for role assignment and
// other admin-only knobs.
export async function requireWalletAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  await extractSession(req)
  if (!req.sessionData) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Session token required' })
    return
  }

  const authorized = req.sessionData.authorizedTokenIds || []
  const tokenId = await resolveAdminTokenId(authorized)
  if (tokenId === null) {
    res.status(403).json({ error: 'NOT_ADMIN', message: 'Account is not authorized for this action' })
    return
  }

  req.moderatorActorTokenId = tokenId
  next()
}

// --- Session-based wallet auth ---

export async function extractSession(req: Request): Promise<void> {
  // Prefer the HttpOnly cookie (added 2026-05-14); fall back to the legacy
  // x-session-token header for the migration window. Once the cookie has
  // been in production long enough that all live FE sessions are using it,
  // the header fallback can be removed.
  const token =
    readCookie(req, SESSION_COOKIE_NAME) ||
    (req.headers['x-session-token'] as string | undefined)

  if (!token) {
    req.sessionData = null
    req.sessionToken = null
    return
  }

  req.sessionToken = token
  req.sessionData = await getSession(token)
}

interface RequireAuthFieldOpts {
  field: string
  /**
   * Re-verify the token's CURRENT on-chain owner against the session's
   * authorized addresses before allowing the write. Closes the
   * stale-session hole where a previous owner's session still claims a
   * tokenId after a transfer:
   *   - NftTransferWatcher prunes the tokenId out of session
   *     authorizedTokenIds within ~60s of the L1 Transfer event.
   *   - This flag covers the in-between window AND the prune-failed
   *     case (Redis hiccup, watcher down).
   * Costs one indexed `prisma.user.findUnique({ where: { tokenId } })`
   * per request — cheap relative to the write itself.
   */
  verifyOwnership?: boolean
  anySession?: never
  lookup?: never
}

interface RequireAuthLookupOpts {
  lookup: (req: Request) => Promise<number | undefined | null>
  /** See RequireAuthFieldOpts.verifyOwnership. */
  verifyOwnership?: boolean
  field?: never
  anySession?: never
}

interface RequireAuthAnySessionOpts {
  anySession: true
  field?: never
  lookup?: never
  verifyOwnership?: never
}

type RequireAuthOpts = RequireAuthFieldOpts | RequireAuthLookupOpts | RequireAuthAnySessionOpts

export function requireAuth(opts: RequireAuthOpts) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await extractSession(req)

    if (!req.sessionData) {
      res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Session token required' })
      return
    }

    // Authenticated responses must not be stored by any shared cache
    // (CDN, corporate proxy, bfcache). Without this a cached session-token
    // response served to a second user is a full session-hijack. Set it
    // before any early-return below so every authenticated path gets it.
    // Audit fix 2026-05-23 (fe-headers H-3).
    res.set('Cache-Control', 'no-store')

    // If only requiring any valid session, we're done
    if ('anySession' in opts && opts.anySession) {
      next()
      return
    }

    // Determine the required tokenId
    let requiredTokenId: number | undefined | null

    if ('field' in opts && opts.field) {
      // Extract from body or query
      const raw = req.body?.[opts.field] ?? req.query?.[opts.field]
      requiredTokenId = raw !== undefined ? Number(raw) : undefined
    } else if ('lookup' in opts && opts.lookup) {
      requiredTokenId = await opts.lookup(req)
    }

    if (requiredTokenId === undefined || requiredTokenId === null || isNaN(requiredTokenId)) {
      res.status(400).json({ error: 'MISSING_TOKEN_ID', message: 'Could not determine the target user for authorization' })
      return
    }

    if (!req.sessionData.authorizedTokenIds.includes(requiredTokenId)) {
      res.status(401).json({
        error: 'TOKEN_NOT_AUTHORIZED',
        message: 'Session not authorized for this token',
        tokenId: requiredTokenId
      })
      return
    }

    // Defense-in-depth: confirm the token's CURRENT on-chain owner is
    // among the session's authorized addresses. NftTransferWatcher's
    // session prune handles the systemic case; this catches the small
    // window between transfer and prune, plus prune failures.
    if (opts.verifyOwnership) {
      const user = await prisma.user.findUnique({
        where:  { tokenId: requiredTokenId },
        select: { address: true },
      })
      if (!user || !user.address) {
        res.status(400).json({
          error: 'MISSING_OWNER',
          message: 'Token has no owner address on record',
          tokenId: requiredTokenId,
        })
        return
      }
      const ownerAddress = user.address.toLowerCase()
      const authedAddresses = (req.sessionData.authorizedAddresses || []).map(a => a.toLowerCase())
      if (!authedAddresses.includes(ownerAddress)) {
        res.status(403).json({
          error: 'TOKEN_OWNER_CHANGED',
          message: 'This token is no longer owned by an address authorized on this session. Re-sign in to refresh.',
          tokenId: requiredTokenId,
        })
        return
      }
      // Stash so handlers don't have to re-query.
      ;(req as Request & { tokenOwnerAddress?: string }).tokenOwnerAddress = ownerAddress
    }

    next()
  }
}

// --- JWT auth (existing) ---

export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'JWT not configured' })
  }

  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Access token required' })
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' })
    }

    req.user = user
    next()
  })
}

export function generateToken(payload: any): string {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not configured')
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' })
}
