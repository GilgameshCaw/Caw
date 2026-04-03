import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { randomBytes } from 'crypto'
import { getSession, SessionData } from '../sessionStore'

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: any
      sessionData?: SessionData | null
      sessionToken?: string | null
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

export function generateAdminToken(): string {
  return randomBytes(32).toString('hex')
}

export function loginAdmin(password: string): string | null {
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) return null
  const token = generateAdminToken()
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL)
  return token
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const token = authHeader.slice(7)
  const expiry = adminTokens.get(token)
  if (!expiry || Date.now() > expiry) {
    adminTokens.delete(token)
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}

// --- Session-based wallet auth ---

export async function extractSession(req: Request): Promise<void> {
  const token = req.headers['x-session-token'] as string | undefined
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
  anySession?: never
  lookup?: never
}

interface RequireAuthLookupOpts {
  lookup: (req: Request) => Promise<number | undefined | null>
  field?: never
  anySession?: never
}

interface RequireAuthAnySessionOpts {
  anySession: true
  field?: never
  lookup?: never
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
