import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { randomBytes, timingSafeEqual, createHash } from 'crypto'
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
      // logs can attribute the action. NULL means the request was
      // authorized via the admin password cookie (no wallet identity).
      moderatorActorTokenId?: number | null
      // Set by requireModerator. True iff the request was authorized
      // via the admin password cookie. Used by handlers that gate
      // certain actions to admins only (e.g. role assignment).
      isAdminCookie?: boolean
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.warn('[Auth] WARNING: JWT_SECRET not set. JWT authentication will reject all tokens.')
}

// --- Admin token auth ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
if (!ADMIN_PASSWORD) {
  console.warn('[Auth] WARNING: ADMIN_PASSWORD not set. Admin login will be disabled.')
}
const adminTokens = new Map<string, number>() // token -> expiry timestamp
const ADMIN_TOKEN_TTL = 24 * 60 * 60 * 1000 // 24 hours
export const ADMIN_COOKIE_NAME = 'caw_admin'

// --- Wallet session cookie ---
// The wallet session token (from sessionStore.ts, created in /api/auth/verify)
// can now also ride on an HttpOnly cookie. JS can't read it, so an XSS payload
// in our frontend can't exfiltrate the token for replay; it can only make
// authenticated requests while the page is open (which it could do regardless).
//
// We keep the x-session-token header path during a migration window so
// existing browser sessions don't all get kicked out. Once the cookie path is
// in production for a while, the header path can be removed.
export const SESSION_COOKIE_NAME = 'caw_session'
// 1 year — matches SESSION_TTL in sessionStore.ts so cookie and Redis entry
// expire together.
const SESSION_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000

export function generateAdminToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Verify the password and create a session. Returns the token (for cookie) and its expiry.
 *
 * Constant-time compare via SHA-256 hashing both sides to fixed-length
 * 32-byte buffers — `password !== ADMIN_PASSWORD` leaks length and a
 * prefix-match timing signal. Audit fix 2026-05-09 (Round 5 VPS M-9).
 */
export function loginAdmin(password: string): { token: string; expiresAt: number } | null {
  if (!ADMIN_PASSWORD) return null
  if (typeof password !== 'string') return null
  const a = createHash('sha256').update(password).digest()
  const b = createHash('sha256').update(ADMIN_PASSWORD).digest()
  if (!timingSafeEqual(a, b)) return null
  const token = generateAdminToken()
  const expiresAt = Date.now() + ADMIN_TOKEN_TTL
  adminTokens.set(token, expiresAt)
  return { token, expiresAt }
}

export function revokeAdminToken(token: string | undefined): void {
  if (token) adminTokens.delete(token)
}

/**
 * Build the Set-Cookie options string used for admin auth.
 * HttpOnly so JS can't read it (XSS can't exfiltrate).
 * SameSite=Strict defeats CSRF.
 * Secure in production.
 */
export function adminCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: isProd,
    path: '/',
    maxAge: ADMIN_TOKEN_TTL,
  }
}

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
  const isProd = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProd,
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
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}

/**
 * Extract the admin token from either the HttpOnly cookie (preferred) or
 * the legacy Authorization: Bearer header (kept temporarily so in-flight
 * admin sessions created before this change don't all get kicked out).
 *
 * TODO: drop the Bearer fallback once the old localStorage tokens have aged out (24h TTL).
 */
export function extractAdminToken(req: Request): string | undefined {
  const cookieToken = readCookie(req, ADMIN_COOKIE_NAME)
  if (cookieToken) return cookieToken
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  return undefined
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = extractAdminToken(req)
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const expiry = adminTokens.get(token)
  if (!expiry || Date.now() > expiry) {
    adminTokens.delete(token)
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  // Mark this request as admin-cookie-authed so downstream handlers can
  // gate ADMIN-only operations (role assignment, etc.) without a second
  // pass.
  req.isAdminCookie = true
  next()
}

// --- Wallet-bound moderator auth ---
//
// Accepts EITHER:
//   1) a valid admin password cookie (admins remain superusers), OR
//   2) a wallet session whose authorizedTokenIds includes a User with
//      role MODERATOR or ADMIN.
//
// On success, sets req.moderatorActorTokenId to the tokenId that holds
// the role (NULL when authorized via cookie). Audit-log writers should
// use it as the actor.
//
// Bootstrap admins — comma-separated list of tokenIds treated as ADMIN
// even if their User.role is still 'USER' in the DB. Lets a fresh
// deploy promote the first admin without a manual SQL update.
//
// Default: VALIDATOR_ID. The operator running the validator is the
// natural "node-runner" identity, so on a fresh install they're admin
// without any extra config. Override with BOOTSTRAP_ADMIN_TOKEN_IDS
// when you want a different person (or additional people) bootstrapped
// — e.g. the operator runs the node but a separate account does the
// moderation.
const BOOTSTRAP_ADMIN_TOKEN_IDS = (() => {
  const explicit = (process.env.BOOTSTRAP_ADMIN_TOKEN_IDS ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
  if (explicit.length > 0) return explicit
  const validatorId = Number(process.env.VALIDATOR_ID)
  return Number.isFinite(validatorId) && validatorId > 0 ? [validatorId] : []
})()

export async function requireModerator(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Admin password path first — cheaper than a DB read.
  const adminToken = extractAdminToken(req)
  if (adminToken) {
    const expiry = adminTokens.get(adminToken)
    if (expiry && Date.now() <= expiry) {
      req.moderatorActorTokenId = null
      req.isAdminCookie = true
      next()
      return
    }
    if (expiry) adminTokens.delete(adminToken)
  }

  // Wallet session path.
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

  // Bootstrap fast path: BOOTSTRAP_ADMIN_TOKEN_IDS skips the DB read.
  const bootstrapHit = authorized.find(id => BOOTSTRAP_ADMIN_TOKEN_IDS.includes(id))
  if (bootstrapHit !== undefined) {
    req.moderatorActorTokenId = bootstrapHit
    req.isAdminCookie = false
    next()
    return
  }

  // Find any authorized token whose User has role MODERATOR or ADMIN.
  // tokenId is unique on User, so a tokenId-in list query is the right
  // shape — no separate by-tokenId lookups.
  const elevated = await prisma.user.findFirst({
    where: { tokenId: { in: authorized }, role: { in: ['MODERATOR', 'ADMIN'] } },
    select: { tokenId: true },
  })
  if (!elevated) {
    res.status(403).json({ error: 'NOT_MODERATOR', message: 'Account is not authorized to moderate' })
    return
  }

  req.moderatorActorTokenId = elevated.tokenId
  req.isAdminCookie = false
  next()
}

// Stricter sibling: same flow, but rejects MODERATOR — wallet must have
// role=ADMIN, OR the request is admin-cookie-authed. Used for role
// assignment and other admin-only knobs.
export async function requireWalletAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Admin cookie still satisfies.
  const adminToken = extractAdminToken(req)
  if (adminToken) {
    const expiry = adminTokens.get(adminToken)
    if (expiry && Date.now() <= expiry) {
      req.moderatorActorTokenId = null
      req.isAdminCookie = true
      next()
      return
    }
    if (expiry) adminTokens.delete(adminToken)
  }

  await extractSession(req)
  if (!req.sessionData) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Session token required' })
    return
  }

  const authorized = req.sessionData.authorizedTokenIds || []
  const bootstrapHit = authorized.find(id => BOOTSTRAP_ADMIN_TOKEN_IDS.includes(id))
  if (bootstrapHit !== undefined) {
    req.moderatorActorTokenId = bootstrapHit
    req.isAdminCookie = false
    next()
    return
  }

  const elevated = await prisma.user.findFirst({
    where: { tokenId: { in: authorized }, role: 'ADMIN' },
    select: { tokenId: true },
  })
  if (!elevated) {
    res.status(403).json({ error: 'NOT_ADMIN', message: 'Account is not authorized for this action' })
    return
  }

  req.moderatorActorTokenId = elevated.tokenId
  req.isAdminCookie = false
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
