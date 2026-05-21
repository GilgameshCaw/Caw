/**
 * HTTP client for the /api/sponsor/* endpoints (Step 4b server).
 *
 * The sponsor server is a SINGLE operator-controlled service — NOT a
 * multi-instance fan-out target. We do NOT use apiFetch here because:
 *   - apiFetch is wired to the user's home CAW node (session/auth headers).
 *   - The sponsor server may be a different host from the CAW API.
 *   - Sponsor requests carry their own ERC-1271 sig, not a session token.
 *
 * Base URL resolves as:
 *   VITE_SPONSOR_API_URL  →  explicit operator config (production)
 *   VITE_API_HOST         →  fall back to home CAW node (dev / single-host deploy)
 *   ''                    →  relative (vite dev proxy)
 *
 * The endpoints are stubbed in 4b. This client is mock-friendly: callers
 * in tests supply their own `fetch` implementation.
 */

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

export interface SponsorBootstrapRequest {
  /** P-256 passkey X coordinate (32 bytes, 0x-prefixed hex) */
  passkeyPubkeyX: `0x${string}`
  /** P-256 passkey Y coordinate (32 bytes, 0x-prefixed hex) */
  passkeyPubkeyY: `0x${string}`
  /** User's secp256k1 EOA address — stored as ecdsaFallback in SmartEOA */
  ecdsaFallbackAddr: `0x${string}`
  /** Desired CAW username */
  username: string
  /** CAW token amount to deposit, serialized as decimal string (bigint-safe) */
  depositAmountCAW: string
  /** CAW network ID */
  networkId: number
  /** LayerZero destination chain ID */
  lzDestId: number
  /** LZ ZRO token amount (pass '0' for ETH-only) */
  lzTokenAmount: string
  /** EIP-7702 auth tuple sig from the user's secp256k1 key */
  authTupleSignature: { yParity: number; r: `0x${string}`; s: `0x${string}` }
  /** EIP-7702 auth tuple nonce (the EOA's tx nonce at time of signing) */
  authTupleNonce: string
  /** WebAuthn sig blob (ABI-encoded) covering the EIP-712 mintAndDeposit digest */
  permitSig: `0x${string}`
  /** Current nonce from SmartEOA.nonceOf(minterAddress, ACTION_MINT_DEPOSIT) */
  permitNonce: string
}

export interface SponsorDepositRequest {
  /** Token ID to top up */
  tokenId: number
  /** CAW network ID */
  networkId: number
  /** CAW amount to deposit (decimal string) */
  amount: string
  /** LayerZero destination chain ID */
  lzDestId: number
  /** LZ ZRO token amount (decimal string) */
  lzTokenAmount: string
  /** Current nonce from SmartEOA.nonceOf(minterAddress, ACTION_DEPOSIT_FOR) */
  permitNonce: string
  /** ERC-1271 sig blob (WebAuthn or 65-byte secp256k1) over the EIP-712 depositFor digest */
  sig: `0x${string}`
}

export interface SponsorAuthenticateRequest {
  /** Token ID to authenticate */
  tokenId: number
  /** CAW network ID to authenticate to */
  networkId: number
  /** LayerZero destination chain ID */
  lzDestId: number
  /** LZ ZRO token amount (decimal string) */
  lzTokenAmount: string
  /** Current nonce from SmartEOA.nonceOf(minterAddress, ACTION_AUTHENTICATE) */
  permitNonce: string
  /** ERC-1271 sig blob (WebAuthn or 65-byte secp256k1) over the EIP-712 authenticate digest */
  sig: `0x${string}`
}

/** Successful sponsor response */
export interface SponsorSuccessResponse {
  txHash: `0x${string}`
}

/** Structured sponsor error response */
export interface SponsorErrorResponse {
  error:
    | 'USERNAME_TAKEN'
    | 'BAD_SIG'
    | 'NONCE_MISMATCH'
    | 'DEPOSIT_TOO_LARGE'
    | 'LZ_FEE_TOO_LARGE'
    | 'INSUFFICIENT_FUNDS'
    | 'RATE_LIMITED'
    | 'SERVER_ERROR'
  detail?: string
}

export type SponsorResponse = SponsorSuccessResponse | SponsorErrorResponse

/** Type guard — narrows to success */
export function isSponsorSuccess(r: SponsorResponse): r is SponsorSuccessResponse {
  return 'txHash' in r
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const SPONSOR_API_URL =
  (import.meta.env.VITE_SPONSOR_API_URL as string | undefined) ??
  (import.meta.env.VITE_API_HOST as string | undefined) ??
  ''

export class SponsorApiClient {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch

  constructor(opts?: { baseUrl?: string; fetch?: typeof fetch }) {
    this.baseUrl = opts?.baseUrl ?? SPONSOR_API_URL
    this.fetchFn = opts?.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * POST /api/sponsor/bootstrap
   * Submits a single EIP-7702 type-0x04 tx that:
   *   1. Delegates user EOA to SmartEOA
   *   2. Calls SmartEOA.initialize (enrolls passkey + sets ecdsaFallback)
   *   3. Calls CawProfileMinter.mintAndDepositSponsored
   * Returns the tx hash or a structured error.
   */
  async sponsorBootstrap(req: SponsorBootstrapRequest): Promise<SponsorResponse> {
    return this._post('/api/sponsor/bootstrap', req)
  }

  /**
   * POST /api/sponsor/deposit
   * Calls CawProfileMinter.depositForSponsored on behalf of the token owner.
   * The sponsor holds the CAW and pre-approves the Minter for at least `amount`.
   * If the token is not yet authenticated, depositForSponsored implicitly authenticates.
   */
  async sponsorDeposit(req: SponsorDepositRequest): Promise<SponsorResponse> {
    return this._post('/api/sponsor/deposit', req)
  }

  /**
   * POST /api/sponsor/authenticate
   * Calls CawProfileMinter.authenticateSponsored for already-deposited users
   * who want to authenticate to a second CAW network with sponsored gas.
   */
  async sponsorAuthenticate(req: SponsorAuthenticateRequest): Promise<SponsorResponse> {
    return this._post('/api/sponsor/authenticate', req)
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async _post<B>(path: string, body: B): Promise<SponsorResponse> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      return {
        error: 'SERVER_ERROR',
        detail: err instanceof Error ? err.message : String(err),
      }
    }

    let data: unknown
    try {
      data = await res.json()
    } catch {
      return { error: 'SERVER_ERROR', detail: `HTTP ${res.status} with non-JSON body` }
    }

    if (res.ok && isObject(data) && typeof (data as Record<string, unknown>).txHash === 'string') {
      return { txHash: (data as Record<string, unknown>).txHash as `0x${string}` }
    }

    if (isObject(data) && typeof (data as Record<string, unknown>).error === 'string') {
      const typed = data as Record<string, unknown>
      const errCode = typed.error as string
      if (isKnownErrorCode(errCode)) {
        return {
          error: errCode,
          detail: typeof typed.detail === 'string' ? typed.detail : undefined,
        }
      }
    }

    return {
      error: 'SERVER_ERROR',
      detail: `HTTP ${res.status}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const KNOWN_ERROR_CODES = new Set<string>([
  'USERNAME_TAKEN',
  'BAD_SIG',
  'NONCE_MISMATCH',
  'DEPOSIT_TOO_LARGE',
  'LZ_FEE_TOO_LARGE',
  'INSUFFICIENT_FUNDS',
  'RATE_LIMITED',
  'SERVER_ERROR',
])

function isKnownErrorCode(s: string): s is SponsorErrorResponse['error'] {
  return KNOWN_ERROR_CODES.has(s)
}

// ---------------------------------------------------------------------------
// Singleton (lazily constructed so tests can supply their own instance)
// ---------------------------------------------------------------------------

let _client: SponsorApiClient | null = null

/** Return the shared sponsor API client for the current install. */
export function getSponsorApiClient(): SponsorApiClient {
  if (!_client) _client = new SponsorApiClient()
  return _client
}
