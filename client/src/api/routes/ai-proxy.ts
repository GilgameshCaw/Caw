import { Router, Request, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { originGate } from '../middleware/originGate'

/**
 * BYOK (bring-your-own-key) AI image generation proxy.
 *
 * Why this exists: the FE talks to Gemini directly because Google's
 * Generative Language API serves permissive CORS. OpenAI and xAI
 * deliberately do NOT — browser-direct fetches are blocked before the
 * response reaches user code. This proxy gives those two providers the
 * same browser-direct-feel by forwarding server-to-server while keeping
 * the BYOK model intact: the user's key arrives in the request body,
 * is used once for the upstream call, and is then discarded. We do not
 * persist, log, or echo it back in error responses.
 *
 * Patterned after routes/rpc-proxy.ts:
 *   - Shares the same originGate middleware (middleware/originGate.ts).
 *   - Uses express-rate-limit per-IP with a lower ceiling — image gen
 *     is heavier and slower than RPC reads.
 *   - One handler factory per provider so adding new ones is a one-line
 *     route registration plus an upstream descriptor.
 *
 * Endpoints:
 *   POST /api/ai-proxy/openai/image  → OpenAI gpt-image-1 (see note inside)
 *   POST /api/ai-proxy/grok/image    → xAI grok-2-image
 *   GET  /api/ai-proxy/health        → liveness probe (no key required)
 *
 * Request body (both providers):
 *   { apiKey: string, prompt: string }
 *
 * Success response (200):
 *   { b64Json: string, mimeType: string }
 *
 * Error response (4xx/5xx):
 *   { error: { kind: 'auth' | 'safety' | 'quota' | 'network' | 'empty', message: string } }
 *
 * The error `kind` mirrors AIImageError in utils/aiImage.ts so the FE
 * can keep using a single catch-and-map code path across providers.
 */

const router = Router()

// Origin gate scoped to this router's response contract. Same allowlist
// logic as rpc-proxy but the 403 body matches what the FE expects from
// every ai-proxy endpoint — { error: { kind, message } } — so the FE's
// existing AIImageError mapping handles it uniformly.
const gate = originGate(() => ({
  error: { kind: 'network' as const, message: 'AI proxy: origin not allowed' },
}))

// Per-IP rate limit. Image gen is expensive on the upstream side and we
// don't want a runaway tab burning a user's quota or hammering our box.
// 30 req/min sustained (≈ 1 every 2s) is plenty for a human; bots get cut
// off fast. Tighten via env later if abuse appears.
const aiProxyRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { kind: 'quota', message: 'AI proxy: rate limited' } },
})

// Upstream timeout. OpenAI/Grok image gen typically returns in 5–15s; we
// give a generous ceiling so a slow upstream doesn't cause a false-fail,
// but cap it so a stuck connection can't hold a worker forever.
const UPSTREAM_TIMEOUT_MS = 60_000

interface ProviderSpec {
  url: string
  buildBody: (prompt: string) => Record<string, unknown>
}

// Hardcoded params (n=1, 1024x1024) mirror the Gemini call in utils/aiImage.ts
// to keep the surface uniform across providers — the modal expects one
// square image per generation. If/when we expose size/count to the user,
// thread them through the FE request body and validate here.
const PROVIDERS: Record<string, ProviderSpec> = {
  openai: {
    url: 'https://api.openai.com/v1/images/generations',
    // We use gpt-image-1. dall-e-3 is no longer accessible via the API
    // for most accounts (OpenAI started returning "model does not exist"
    // after the gpt-image-1 rollout). dall-e-2 still works but is much
    // lower quality.
    //
    // Caveat: gpt-image-1 may require OpenAI "organization verification"
    // depending on the account's tier. If a BYOK user hits 403 with a
    // verification code, the response parser surfaces the literal
    // upstream message so the modal can point them at the OpenAI
    // dashboard. (If we see this in practice we can add an automatic
    // fallback to dall-e-2.)
    //
    // We do NOT pass `response_format` — the current API rejects it as
    // unknown. gpt-image-1 returns b64_json by default; if a future
    // change makes it return `url` instead, the response parser fetches
    // the URL server-side and converts to b64, so the FE keeps a single
    // rendering path.
    buildBody: (prompt) => ({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1024x1024',
    }),
  },
  grok: {
    url: 'https://api.x.ai/v1/images/generations',
    buildBody: (prompt) => ({
      model: 'grok-2-image',
      prompt,
      n: 1,
      response_format: 'b64_json',
    }),
  },
}

type ErrorKind = 'auth' | 'safety' | 'quota' | 'network' | 'empty'

function errorResponse(res: Response, status: number, kind: ErrorKind, message: string) {
  // NOTE: we deliberately do NOT include the upstream's raw error body —
  // it sometimes echoes parts of the request (including the prompt) and
  // we want to keep the response shape predictable for the FE. The kind
  // is enough for the modal to pick the right localized message.
  res.status(status).json({ error: { kind, message } })
}

function classifyHttpStatus(status: number): { kind: ErrorKind; message: string } {
  if (status === 400) return { kind: 'safety', message: 'Prompt rejected by upstream (likely safety filter).' }
  if (status === 401 || status === 403) return { kind: 'auth', message: 'Invalid or unauthorized API key.' }
  if (status === 429) return { kind: 'quota', message: 'Upstream rate limit / quota reached.' }
  return { kind: 'network', message: `Upstream HTTP ${status}.` }
}

async function forwardToProvider(spec: ProviderSpec, apiKey: string, prompt: string): Promise<
  | { ok: true; b64Json: string; mimeType: string }
  | { ok: false; status: number; kind: ErrorKind; message: string }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  let upstream: globalThis.Response
  try {
    upstream = await fetch(spec.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // BYOK: the user's key authorizes the upstream call. We never
        // log it, never echo it, never persist it.
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(spec.buildBody(prompt)),
      signal: controller.signal,
    })
  } catch (err: unknown) {
    clearTimeout(timer)
    const aborted = (err as { name?: string })?.name === 'AbortError'
    return {
      ok: false,
      status: 504,
      kind: 'network',
      message: aborted ? 'Upstream timed out.' : 'Network error reaching the provider.',
    }
  }
  clearTimeout(timer)

  if (!upstream.ok) {
    // Parse the upstream error body so we can surface an actionable
    // reason (e.g. content_policy_violation, billing). Both OpenAI and
    // xAI return { error: { message, code, type } } on failure. We
    // include the message for 4xx (user-fixable) but NOT for 5xx
    // (provider-side, would just confuse the user). The full body is
    // also logged server-side for operator debugging.
    const text = await upstream.text().catch(() => '')
    let upstreamMessage = ''
    let upstreamCode = ''
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } }
      upstreamMessage = parsed?.error?.message || ''
      upstreamCode = parsed?.error?.code || ''
    } catch {
      /* upstream returned non-JSON */
    }
    console.warn(`[ai-proxy] upstream ${upstream.status} ${spec.url} code=${upstreamCode || 'n/a'} message=${upstreamMessage || text.slice(0, 200)}`)

    const base = classifyHttpStatus(upstream.status)
    // For 4xx, prefer the upstream's specific message — it tells the
    // user what to fix (e.g. "Your request was rejected by safety
    // system"). For 5xx, stick with the generic mapping.
    const message = upstream.status >= 400 && upstream.status < 500 && upstreamMessage
      ? upstreamMessage
      : base.message
    // Content-policy violations sometimes come back as 400 generic —
    // upgrade those to kind:'safety' so the modal renders the right
    // icon/copy.
    const isPolicy = /policy|moderation|safety|content/i.test(upstreamMessage) || /content_policy|moderation/i.test(upstreamCode)
    const kind = isPolicy ? 'safety' : base.kind
    return { ok: false, status: upstream.status, kind, message }
  }

  const data = await upstream.json().catch(() => null) as
    | { data?: Array<{ b64_json?: string; url?: string }> }
    | null

  const first = data?.data?.[0]
  if (!first) {
    // Upstream returned 200 OK but no image entry — typically a silent
    // safety block on Gemini-like providers; rare on OpenAI/xAI.
    return {
      ok: false,
      status: 502,
      kind: 'empty',
      message: 'No image returned by upstream (prompt may have been blocked).',
    }
  }

  // Preferred path: upstream gave us b64 directly.
  if (first.b64_json) {
    return { ok: true, b64Json: first.b64_json, mimeType: 'image/png' }
  }

  // Fallback path: OpenAI may return a temporary URL (when response_format
  // is omitted, which we now do because the API rejects it as unknown).
  // Fetch the bytes server-side and convert to b64 so the FE keeps a
  // single rendering path regardless of provider.
  if (first.url) {
    try {
      const imgRes = await fetch(first.url)
      if (!imgRes.ok) {
        return { ok: false, status: 502, kind: 'network', message: `Failed to fetch generated image (${imgRes.status}).` }
      }
      const buf = Buffer.from(await imgRes.arrayBuffer())
      const mimeType = imgRes.headers.get('content-type') || 'image/png'
      return { ok: true, b64Json: buf.toString('base64'), mimeType }
    } catch {
      return { ok: false, status: 502, kind: 'network', message: 'Failed to download generated image.' }
    }
  }

  return {
    ok: false,
    status: 502,
    kind: 'empty',
    message: 'Upstream response contained no image data.',
  }
}

function makeImageHandler(providerKey: string) {
  const spec = PROVIDERS[providerKey]
  return async (req: Request, res: Response): Promise<void> => {
    if (!spec) {
      errorResponse(res, 404, 'network', `Unknown provider: ${providerKey}`)
      return
    }
    const body = (req.body || {}) as { apiKey?: unknown; prompt?: unknown }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!apiKey) { errorResponse(res, 400, 'auth', 'Missing API key.'); return }
    if (!prompt) { errorResponse(res, 400, 'empty', 'Missing prompt.'); return }

    try {
      const result = await forwardToProvider(spec, apiKey, prompt)
      if (result.ok) {
        res.json({ b64Json: result.b64Json, mimeType: result.mimeType })
        return
      }
      errorResponse(res, result.status, result.kind, result.message)
    } catch {
      // Defensive: we don't surface stack/details (might contain the
      // prompt or upstream-echoed body). The FE only needs the kind.
      errorResponse(res, 500, 'network', 'AI proxy: internal error.')
    }
  }
}

router.post('/openai/image', gate, aiProxyRateLimit, makeImageHandler('openai'))
router.post('/grok/image',   gate, aiProxyRateLimit, makeImageHandler('grok'))

router.get('/health', (_req, res) => {
  res.json({ providers: Object.keys(PROVIDERS) })
})

export default router
