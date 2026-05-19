// Client-side AI image generation (BYOK). Calls the provider directly from
// the browser with the user's own key — same rationale as utils/translate.ts
// (no backend, no key custody). Gemini's Generative Language API accepts the
// key as an x-goog-api-key request header (not ?key= query param). We use the
// header form deliberately: Sentry's default fetch instrumentation captures
// URLs in breadcrumbs/Replay but does NOT capture request headers, so the
// header form prevents the key from appearing in Sentry payloads.
// OpenAI does NOT support permissive CORS and would need a backend proxy —
// intentionally not added here.

export type AIProvider = 'gemini'

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
    default:
      throw new AIImageError('Unsupported provider.', 'network')
  }
}
