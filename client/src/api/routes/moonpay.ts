/**
 * /api/moonpay — Moonpay URL signing endpoint.
 *
 * Endpoint:
 *   POST /api/moonpay/sign  — signs a Moonpay widget URL with HMAC-SHA256
 *
 * Moonpay requires the query string of the widget URL to be signed with the
 * operator's secret key so that the hosted widget knows the request originated
 * from an authorized server. The FE builds the unsigned URL (with publishable
 * key, currency codes, wallet address, etc.) and calls this endpoint to get
 * the signed version.
 *
 * Signing spec (Moonpay docs):
 *   signature = base64url( HMAC-SHA256( secretKey, queryString ) )
 *   signedUrl = url + '&signature=' + signature
 *
 * Where `queryString` is the raw query string including the leading '?'.
 *
 * Gate: returns 503 when MOONPAY_SECRET_KEY is not configured. The FE falls
 * back to an unsigned URL when this endpoint returns 503 — acceptable for
 * sandbox / dev mode where Moonpay skips signature verification.
 *
 * Env vars:
 *   MOONPAY_SECRET_KEY  — operator secret key from Moonpay dashboard (sk_*)
 */

import { Router, Request, Response } from 'express'
import { createHmac } from 'crypto'
import { z, ZodError } from 'zod'

const router = Router()

const signSchema = z.object({
  url: z.string().url('must be a valid URL'),
})

// ── POST /api/moonpay/sign ────────────────────────────────────────────────────

router.post('/sign', async (req: Request, res: Response): Promise<void> => {
  const secretKey = process.env.MOONPAY_SECRET_KEY
  if (!secretKey) {
    res.status(503).json({ error: 'Moonpay is not configured on this instance.' })
    return
  }

  let body: z.infer<typeof signSchema>
  try {
    body = signSchema.parse(req.body)
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors })
      return
    }
    throw err
  }

  let parsed: URL
  try {
    parsed = new URL(body.url)
  } catch {
    res.status(400).json({ error: 'Could not parse URL' })
    return
  }

  // Moonpay signs only the query string (the part starting with '?').
  // If the URL has no query string, return it unsigned (nothing to sign).
  const queryString = parsed.search  // includes the leading '?', or '' if absent
  if (!queryString) {
    res.json({ signedUrl: body.url })
    return
  }

  const signature = createHmac('sha256', secretKey)
    .update(queryString)
    .digest('base64url')

  const signedUrl = `${body.url}&signature=${encodeURIComponent(signature)}`
  res.json({ signedUrl })
})

export default router
