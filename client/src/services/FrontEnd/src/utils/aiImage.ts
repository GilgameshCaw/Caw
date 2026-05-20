// Client-side AI image generation (BYOK). Two transport modes depending on
// the provider's CORS posture:
//
//   - Gemini: browser → Google directly. Google's Generative Language API
//     serves permissive CORS and accepts the key in an `x-goog-api-key`
//     header. We use the header form deliberately: Sentry's default fetch
//     instrumentation captures URLs in breadcrumbs/Replay but does NOT
//     capture request headers, so the key never lands in Sentry payloads.
//
//   - OpenAI / Grok: browser → our backend → upstream. These providers
//     do NOT serve permissive CORS, so direct browser fetches are blocked
//     before the response reaches user code. We forward through
//     /api/ai-proxy/{provider}/image with the user's key in the JSON body;
//     the backend uses it for the upstream call and discards it (no
//     persistence, no logging). See api/routes/ai-proxy.ts for the
//     server-side contract.
//
// Either way the key stays the user's (BYOK) — we never custody it.

export type AIProvider = 'gemini' | 'openai' | 'grok'

export interface AIImageResult {
  blob: Blob
  mimeType: string
}

export class AIImageError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'safety' | 'quota' | 'network' | 'empty') {
    super(message)
    this.name = 'AIImageError'
  }
}

// Imagen 3 via the Gemini API. NOTE: Google renames these model ids / endpoint
// versions periodically — if generation starts 404'ing, this constant is the
// single place to update (verify against ai.google.dev/gemini-api docs).
const GEMINI_IMAGE_MODEL = 'imagen-3.0-generate-002'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

function base64ToBlob(b64: string, mimeType: string): Blob {
  const bytes = atob(b64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mimeType })
}

async function generateGemini(prompt: string, apiKey: string): Promise<AIImageResult> {
  const url = `${GEMINI_BASE}/${GEMINI_IMAGE_MODEL}:predict`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: '1:1' },
      }),
    })
  } catch {
    throw new AIImageError('Network error reaching the provider.', 'network')
  }

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new AIImageError('Invalid or unauthorized API key.', 'auth')
  }
  if (res.status === 429) {
    throw new AIImageError('Provider rate limit / quota reached.', 'quota')
  }
  if (!res.ok) {
    throw new AIImageError(`Provider error (${res.status}).`, 'network')
  }

  const data = await res.json().catch(() => null) as
    | { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> }
    | null

  const pred = data?.predictions?.[0]
  if (!pred?.bytesBase64Encoded) {
    // Imagen returns no prediction when the prompt is blocked by safety.
    throw new AIImageError('No image returned (prompt may have been blocked).', 'safety')
  }
  const mimeType = pred.mimeType || 'image/png'
  return { blob: base64ToBlob(pred.bytesBase64Encoded, mimeType), mimeType }
}

// OpenAI and Grok go through our backend proxy (see header). Both share
// the same proxy response shape — { b64Json, mimeType } on success, or
// { error: { kind, message } } with a non-2xx status. We re-map the kind
// straight into AIImageError so the modal's existing catch path works
// uniformly across providers.
type ProxyErrorKind = AIImageError['kind']

async function generateViaProxy(
  proxyPath: '/api/ai-proxy/openai/image' | '/api/ai-proxy/grok/image',
  prompt: string,
  apiKey: string,
): Promise<AIImageResult> {
  let res: Response
  try {
    res = await fetch(proxyPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Body-only auth: the key never appears in URL/query (Sentry safe)
      // and is consumed once by the backend, never persisted there.
      body: JSON.stringify({ apiKey, prompt }),
    })
  } catch {
    throw new AIImageError('Network error reaching the AI proxy.', 'network')
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: { kind?: ProxyErrorKind; message?: string } } | null
    const kind = data?.error?.kind || 'network'
    const message = data?.error?.message || `AI proxy error (${res.status}).`
    throw new AIImageError(message, kind)
  }

  const data = await res.json().catch(() => null) as { b64Json?: string; mimeType?: string } | null
  if (!data?.b64Json) {
    throw new AIImageError('No image returned by AI proxy.', 'empty')
  }
  const mimeType = data.mimeType || 'image/png'
  return { blob: base64ToBlob(data.b64Json, mimeType), mimeType }
}

/**
 * Generate one image from a prompt using the connected provider. Throws
 * AIImageError with a typed `kind` so the modal can show an actionable message.
 */
export async function generateAIImage(
  provider: AIProvider,
  prompt: string,
  apiKey: string,
): Promise<AIImageResult> {
  switch (provider) {
    case 'gemini':
      return generateGemini(prompt, apiKey)
    case 'openai':
      return generateViaProxy('/api/ai-proxy/openai/image', prompt, apiKey)
    case 'grok':
      return generateViaProxy('/api/ai-proxy/grok/image', prompt, apiKey)
    default: {
      // Exhaustiveness check: if AIProvider grows and we forget to handle
      // it here, tsc flags this assignment.
      const _exhaustive: never = provider
      void _exhaustive
      throw new AIImageError('Unsupported provider.', 'network')
    }
  }
}
