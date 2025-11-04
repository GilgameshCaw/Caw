import { Router, Request, Response } from 'express'

const router = Router()

/**
 * XMTP Backend Proxy
 *
 * IMPORTANT: This proxy ONLY forwards encrypted payloads.
 * Messages are encrypted on the client-side before being sent here.
 * The server CANNOT decrypt or read message contents.
 *
 * This proxy exists solely to bypass CORS restrictions when
 * communicating with XMTP network from browsers.
 */

// XMTP API endpoints
const XMTP_API_BASE = 'https://grpc.production.xmtp.network'

/**
 * Proxy all requests to XMTP network
 * The client sends already-encrypted payloads
 */
router.all('/*', async (req: Request, res: Response) => {
  try {
    // Get the XMTP endpoint path from the request
    // Remove the /api/xmtp-proxy prefix to get the actual path
    const xmtpPath = req.originalUrl.replace('/api/xmtp-proxy', '').replace(/^\//, '')
    const xmtpUrl = xmtpPath ? `${XMTP_API_BASE}/${xmtpPath}` : XMTP_API_BASE

    console.log(`Proxying ${req.method} request to: ${xmtpUrl}`)

    // Build the options for the fetch request
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        // Forward any XMTP-specific headers
        ...Object.fromEntries(
          Object.entries(req.headers).filter(([key]) =>
            key.toLowerCase().startsWith('x-xmtp-')
          )
        )
      }
    }

    // Add body for POST/PUT/PATCH requests
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body)
    }

    // Add query parameters for GET requests
    let finalUrl = xmtpUrl
    if (req.method === 'GET' && Object.keys(req.query).length > 0) {
      const queryString = new URLSearchParams(req.query as any).toString()
      finalUrl = `${xmtpUrl}?${queryString}`
    }

    // Forward the request to XMTP
    // Note: req.body contains encrypted data that we cannot read
    const xmtpResponse = await fetch(finalUrl, fetchOptions)

    // Get the response (also encrypted)
    const responseData = await xmtpResponse.json()

    // Forward the encrypted response back to client
    res.status(xmtpResponse.status).json(responseData)

  } catch (error) {
    console.error('XMTP proxy error:', error)
    res.status(500).json({
      error: 'Failed to proxy XMTP request',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

export default router