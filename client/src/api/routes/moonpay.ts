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
 * What gets signed. The operator's signature tells Moonpay that the operator
 * vouches for every parameter in the URL, the destination walletAddress
 * included. So this endpoint only signs:
 *   - URLs on the Moonpay widget hosts (the same list the FE builder allows), and
 *   - URLs whose walletAddress the caller controls: the body must carry
 *     `walletSignature`, an EIP-191 personal_sign by that address over
 *     moonpaySignMessage(queryString). The onramp flow holds that address's
 *     key in the browser, so this works before the user has a profile or a
 *     session, and a caller can only get signed URLs that pay into their own
 *     address.
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
import { ethers } from 'ethers'
import { z, ZodError } from 'zod'

const router = Router()

// Keep in sync with ALLOWED_MOONPAY_HOSTS in the FE's services/onramp/moonpay.ts.
const ALLOWED_MOONPAY_HOSTS = new Set([
  'buy.moonpay.com',
  'buy-sandbox.moonpay.com',
  'buy-staging.moonpay.com',
])

/**
 * The message the destination wallet signs (personal_sign) to ask for an
 * operator signature. It covers the whole query string, so no parameter can
 * be changed after the wallet signed it. The FE must build the same string.
 */
export function moonpaySignMessage(queryString: string): string {
  return `CAW Moonpay onramp\n${queryString}`
}

const signSchema = z.object({
  url: z.string().url('must be a valid URL'),
  walletSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'must be a 65-byte hex signature'),
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

  if (parsed.protocol !== 'https:' || !ALLOWED_MOONPAY_HOSTS.has(parsed.hostname)) {
    res.status(400).json({ error: 'URL is not a Moonpay widget URL' })
    return
  }

  // Moonpay signs only the query string (the part starting with '?').
  const queryString = parsed.search  // includes the leading '?', or '' if absent
  const walletAddress = parsed.searchParams.get('walletAddress')
  if (!queryString || !walletAddress || !ethers.isAddress(walletAddress)) {
    res.status(400).json({ error: 'URL must carry a valid walletAddress' })
    return
  }

  let signer: string
  try {
    signer = ethers.verifyMessage(moonpaySignMessage(queryString), body.walletSignature)
  } catch {
    res.status(400).json({ error: 'Invalid walletSignature' })
    return
  }
  if (signer.toLowerCase() !== walletAddress.toLowerCase()) {
    res.status(403).json({ error: 'walletSignature is not from walletAddress' })
    return
  }

  const signature = createHmac('sha256', secretKey)
    .update(queryString)
    .digest('base64url')

  // Rebuilt from the parsed parts (not body.url) so a trailing #fragment can't
  // end up in front of the signature.
  const signedUrl = `${parsed.origin}${parsed.pathname}${queryString}&signature=${encodeURIComponent(signature)}`
  res.json({ signedUrl })
})

export default router
