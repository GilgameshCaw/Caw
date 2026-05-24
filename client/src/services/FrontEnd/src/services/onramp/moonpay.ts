/**
 * Moonpay URL builder for the card-onramp flow.
 *
 * Uses the URL-based widget (no SDK dependency). The widget is rendered
 * in an <iframe> inside OnrampOnboarding.tsx.
 *
 * Production requirement: URLs must be HMAC-signed server-side before
 * presenting them to Moonpay. Sandbox accepts unsigned URLs, so MVP
 * skips the signing step. When you're ready to go to production:
 *
 *   1. Add a backend endpoint `POST /api/moonpay/sign` that accepts the
 *      unsigned URL and returns `{ signedUrl: string }`.
 *   2. Call that endpoint from OnrampOnboarding.tsx before rendering the
 *      iframe. The signing key is `MOONPAY_SECRET_KEY` in the API .env
 *      and must NEVER be shipped in the FE bundle.
 *
 * See: https://dev.moonpay.com/docs/on-ramp-link-creation
 *
 * TODO (pre-prod): add the /api/moonpay/sign call before launching with
 * real API keys.
 */

/** Brand yellow used throughout the CAW UI. */
const BRAND_COLOR_HEX = '%23f7b72b' // URL-encoded '#f7b72b'

export interface MoonpayWidgetParams {
  /** Destination EOA for the purchased ETH. */
  walletAddress: `0x${string}`
  /**
   * USD amount to pre-fill. Should equal the user's cost estimate
   * (profile price in USD + generous gas headroom) × 1.05 safety buffer.
   */
  baseCurrencyAmountUsd: number
  /** Where Moonpay should send the user after a successful purchase. */
  redirectUrl: string
}

/**
 * Build the unsigned Moonpay widget URL.
 *
 * In sandbox mode (VITE_MOONPAY_BASE_URL = https://buy-sandbox.moonpay.com)
 * the URL works without a signature. In production the caller is responsible
 * for signing the query string — see the TODO comment at the top of this file.
 */
const ALLOWED_MOONPAY_HOSTS = new Set([
  'buy.moonpay.com',
  'buy-sandbox.moonpay.com',
  'buy-staging.moonpay.com',
])

export function buildMoonpayUrl(params: MoonpayWidgetParams): string {
  const baseUrl =
    (import.meta.env.VITE_MOONPAY_BASE_URL as string | undefined) ??
    'https://buy-sandbox.moonpay.com'

  // Validate: only accept known Moonpay domains. A malicious operator
  // (or compromised env var) could point this at an attacker-controlled
  // URL that loads inside our iframe — even though the sandbox attribute
  // blocks top-frame navigation, an attacker page could still phish
  // card details or show a convincing fake UI.
  try {
    const host = new URL(baseUrl).hostname
    if (!ALLOWED_MOONPAY_HOSTS.has(host)) {
      console.error(`[Moonpay] VITE_MOONPAY_BASE_URL points at disallowed host "${host}". Refusing to build URL.`)
      return ''
    }
  } catch {
    console.error('[Moonpay] VITE_MOONPAY_BASE_URL is not a valid URL. Refusing to build URL.')
    return ''
  }

  const apiKey =
    (import.meta.env.VITE_MOONPAY_API_KEY as string | undefined) ?? ''

  if (!apiKey && import.meta.env.DEV) {
    // Sandbox + the consumer prod URL both accept an empty apiKey — the
    // raw flow loads and the user can complete a purchase. Production
    // deployments should still register with Moonpay (free for sandbox
    // keys, biz registration required for live keys) so attribution +
    // branding work. Log once at iframe load time to keep the warning
    // out of normal runtime.
    // eslint-disable-next-line no-console
    console.warn(
      '[Moonpay] VITE_MOONPAY_API_KEY is unset. Widget will load in raw consumer mode (no dApp branding, no attribution). Get a free sandbox key at https://moonpay.com/business.'
    )
  }

  const args = new URLSearchParams({
    // Empty apiKey is intentional when the operator has only set the
    // base URL. Moonpay's URL parser accepts it.
    apiKey,
    currencyCode: 'eth',
    defaultCurrencyCode: 'eth',
    baseCurrencyCode: 'usd',
    baseCurrencyAmount: params.baseCurrencyAmountUsd.toFixed(2),
    lockAmount: 'true',
    walletAddress: params.walletAddress,
    redirectURL: params.redirectUrl,
    colorCode: BRAND_COLOR_HEX,
    // Disable email collection — the user has no Moonpay account and we
    // don't want them to create one if they can avoid it.
    showWalletAddressForm: 'false',
  })

  return `${baseUrl}?${args.toString()}`
}

/**
 * Convert a USD profile-cost estimate into the Moonpay baseCurrencyAmount
 * that includes gas headroom and a 5% safety buffer against price movement.
 *
 * Gas headroom: 2× a conservative L1 mint gas estimate in USD.
 * Safety buffer: multiply the total by 1.05.
 *
 * @param profileCostUsd  USD cost of the profile mint (from the quoter).
 * @param gasCostUsd      Estimated gas cost in USD for the mint + deposit tx.
 * @returns               Recommended USD purchase amount (rounded up to $0.01).
 */
export function estimateMoonpayAmount(
  profileCostUsd: number,
  gasCostUsd: number
): number {
  const raw = (profileCostUsd + gasCostUsd * 2) * 1.05
  // Round up to 2 decimal places so Moonpay always gets an amount >= estimate.
  return Math.ceil(raw * 100) / 100
}
