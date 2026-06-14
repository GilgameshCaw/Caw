/**
 * CreateAccountStep.tsx
 *
 * Step 5 of /onboarding — the actual on-chain account creation, split out of
 * BackupStep (#236) so the mint and the recovery-file backup are two distinct
 * steps with their own framing:
 *
 *   - This step: "your digital identity is ready" → a single "Create my account"
 *     button that fires bootstrapNewUser(). It pulls a SECOND WebAuthn ceremony
 *     (signWithPasskey) to sign the mint permit. The user's raw EOA address is
 *     never shown — the identity is referred to via a "digital identity" link +
 *     tooltip instead (it's a phone-first / passkey audience; an 0x… string is
 *     noise to them and a footgun if they think they must copy it).
 *   - Next step (BackupStep): pure recovery-file backup of the now-minted wallet.
 *
 * On success it stashes nothing locally — it hands the BootstrapResult up via
 * onCreated() and the parent advances to 'backup'. USERNAME_TAKEN bounces back
 * to the username step via onUsernameTaken().
 *
 * The bootstrap wiring (rpcProvider / passkeySigner / sponsorApi adapters, the
 * smartEoaAddress + permit-nonce landmines) is lifted VERBATIM from the old
 * BackupStep mint phase — do NOT re-thread it carelessly. See
 * project_sponsored_mint_failure_decoder + project_sponsored_mint_digest_recipient.
 */

import { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { bootstrapNewUser, type BootstrapResult, type BootstrapParams } from '~/services/identity/bootstrap'
import { apiFetch } from '~/api/client'
import {
  getSponsorApiClient,
  isSponsorSuccess,
} from '~/services/identity/sponsorApiClient'
import { signWithPasskey, type PasskeyPubkey } from '~/services/identity/passkey'
import { CAW_NAMES_MINTER_ADDRESS, SMART_EOA_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { usePublicClient } from 'wagmi'

export interface CreateAccountStepProps {
  /**
   * Gate: provide EXACTLY ONE of `code` or `xQualifiedToken`. `code` is the
   * sponsor invite code (/onboarding?code=...); `xQualifiedToken` is the proof
   * from the open X-signup flow. The sponsor server enforces exactly-one.
   */
  code: string
  /** X-qualified token from the open X-signup gate (alternative to code). */
  xQualifiedToken?: string
  username: string
  depositAmount: bigint
  /**
   * Sponsor-Repay (Phase 2): the CAW the user must repay on first withdrawal,
   * derived in Onboarding as depositAmount * repayBps / 10000. 0 = plain gift.
   * Folded into the signed permit digest AND sent as signedRepayAmount so the
   * server can confirm it matches the code's policy before submitting.
   */
  repayAmount: bigint
  /** Profile that collects the repayment (0 when repayAmount is 0). */
  sponsorTokenId: number
  vaultPassword: string
  passkey: PasskeyPubkey
  /** Hand the minted wallet up; parent stashes it and advances to backup. */
  onCreated: (result: BootstrapResult) => void
  onUsernameTaken: () => void
  onBack: () => void
}

type LoadingPhase = 'sponsor' | 'chain' | null

type ErrorKind =
  | 'INSUFFICIENT_FUNDS'
  | 'RATE_LIMITED'
  | 'CODE_RATE_LIMITED'
  | 'CODE_REJECTED'
  | 'generic'
  | null

/**
 * Sponsor-code error codes from the server. All collapse to a single
 * "code rejected" UI to avoid leaking which kind of failure occurred
 * (defeats brute-force probing — see validateSponsorCode.ts).
 */
const SPONSOR_CODE_ERROR_CODES = new Set<string>([
  'INVALID_CODE',
  'CODE_EXPIRED',
  'CODE_EXHAUSTED',
  'BUDGET_EXCEEDED',
  'IP_BANNED',
  'USERNAME_TOO_SHORT',
  'INVALID_CODE_LOCKDOWN',
])

interface AccountError {
  kind: ErrorKind
  detail?: string
}

// Default placeholder values for network parameters.
// In a full integration these would come from the CAW network config.
const DEFAULT_NETWORK_ID = 1
const DEFAULT_LZ_DEST_ID = chains.l2?.layerZero ?? 40245 // Base Sepolia LZ ID
const DEFAULT_LZ_TOKEN_AMOUNT = 0n

// Bootstrap-only path: the SmartEOA is freshly initialized in the same tx,
// so its nonceOf(minter, ACTION_MINT_DEPOSIT) is guaranteed to be 0. Subsequent
// deposit / authenticate / addPasskey calls use a live nonce read at sign time
// (see useSponsorDeposit / useSponsorAuthenticate). Do NOT reuse this constant
// outside the bootstrap flow — those flows are NOT freshly-initialized.
const BOOTSTRAP_PERMIT_NONCE = 0n

/** Compact wei → "1.5M CAW" style label for the repay disclosure. */
function formatCawWei(wei: bigint): string {
  const whole = Number(wei / 10n ** 18n)
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(whole % 1_000_000 === 0 ? 0 : 1)}M CAW`
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(whole % 1_000 === 0 ? 0 : 1)}K CAW`
  return `${whole.toLocaleString()} CAW`
}

export default function CreateAccountStep({
  code,
  xQualifiedToken,
  username,
  depositAmount,
  repayAmount,
  sponsorTokenId,
  vaultPassword,
  passkey,
  onCreated,
  onUsernameTaken,
  onBack,
}: CreateAccountStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const publicClient = usePublicClient()

  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>(null)
  const [error, setError] = useState<AccountError>({ kind: null })
  const [showIdentityTip, setShowIdentityTip] = useState(false)

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const isLoading = loadingPhase !== null

  // ── Mint ───────────────────────────────────────────────────────────────────
  // Lifted verbatim from the old BackupStep 'mint' phase. The wiring landmines
  // (smartEoaAddress must be the SmartEOA not the Minter; the permit digest is
  // built INSIDE bootstrapNewUser binding recipient to the recovered EOA; the
  // BOOTSTRAP_PERMIT_NONCE = 0 fresh-SmartEOA assumption) are unchanged.

  const handleBootstrap = async () => {
    setLoadingPhase('sponsor')
    setError({ kind: null })

    try {
      // Build the RPC provider adapter from the wagmi public client.
      // If no public client is available (SSR or unconnected), use stubs.
      const rpcProvider = publicClient
        ? {
            getChainId: () => publicClient.getChainId(),
            getTransactionCount: (params: { address: `0x${string}` }) =>
              publicClient.getTransactionCount(params),
          }
        : {
            getChainId: async () => chains.l1?.chainId ?? 11155111,
            getTransactionCount: async () => 0,
          }

      // The address the EIP-7702 auth tuple delegates the user's EOA to — this
      // MUST be the deployed SmartEOA implementation, NOT the Minter. Getting it
      // wrong delegates the EOA to the wrong contract, so the sponsor server
      // recovers a different/phantom authority from the auth tuple and the
      // permit digest's recipient no longer matches (→ MinterCallFailed).
      // Generated into addresses.ts at deploy time; the env var is an optional
      // override. The old `?? CAW_NAMES_MINTER_ADDRESS` fallback was the bug:
      // VITE_SMART_EOA_ADDRESS is usually unset, so it silently delegated to
      // the Minter.
      const smartEoaAddress = (
        (import.meta.env.VITE_SMART_EOA_ADDRESS as string | undefined) ??
        SMART_EOA_ADDRESS
      ) as `0x${string}`

      // The permit digest is built INSIDE bootstrapNewUser — it binds
      // `recipient` to the freshly-generated EOA (unknown until then) and must
      // include the deployed Minter's repay/kyc fields. Building it here with a
      // placeholder recipient is what produced the MinterCallFailed revert.

      // Passkey signer adapter: wraps signWithPasskey() to match the
      // PasskeyPermitSigner callback shape expected by bootstrapNewUser().
      const passkeySigner = async (digest: `0x${string}`) => {
        const rpId = typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social'
        const result = await signWithPasskey({
          credentialId: passkey.credentialId,
          digest,
          rpId,
        })
        return {
          permitSig: result.sig,
          clientDataJSON: result.clientDataJSON,
          authenticatorData: result.authenticatorData,
        }
      }

      // Sponsor API adapter: wraps SponsorApiClient.sponsorBootstrap to match
      // the SponsorApiClient interface expected by bootstrapNewUser().
      const sponsorClientRaw = getSponsorApiClient()
      const sponsorApi = {
        sponsorBootstrap: async (params: BootstrapParams) => {
          // Build the full SponsorBootstrapRequest from the BootstrapParams.
          // Exactly one of code / xQualifiedToken is present (server enforces).
          const req = {
            ...(params.code ? { code: params.code } : {}),
            ...(params.xQualifiedToken ? { xQualifiedToken: params.xQualifiedToken } : {}),
            passkeyPubkeyX: params.passkeyPubkeyX,
            passkeyPubkeyY: params.passkeyPubkeyY,
            ecdsaFallbackAddr: params.ecdsaFallbackAddr,
            username: params.username,
            depositAmountCAW: params.depositAmountCAW.toString(),
            networkId: params.networkId,
            lzDestId: params.lzDestId,
            lzTokenAmount: DEFAULT_LZ_TOKEN_AMOUNT.toString(),
            authTupleSignature: {
              yParity: params.authTupleSignature.yParity,
              r: params.authTupleSignature.r,
              s: params.authTupleSignature.s,
            },
            authTupleNonce: params.authTupleSignature.nonce.toString(),
            permitSig: params.permitSig,
            permitNonce: BOOTSTRAP_PERMIT_NONCE.toString(),
            // Sponsor-Repay (Phase 2): tell the server the repayAmount we folded
            // into the signed digest so it can confirm it matches the code's
            // policy. Omit when 0 (plain gift) for byte-identical legacy behaviour.
            ...(repayAmount > 0n ? { signedRepayAmount: repayAmount.toString() } : {}),
          }
          const response = await sponsorClientRaw.sponsorBootstrap(req)
          if (isSponsorSuccess(response)) {
            return { txHash: response.txHash }
          }
          // Map sponsor error to a JS Error so bootstrapNewUser's catch picks it up.
          const err = new Error(response.detail ?? response.error)
          ;(err as Error & { code: string }).code = response.error
          throw err
        },
      }

      const result = await bootstrapNewUser({
        ...(code ? { code } : {}),
        ...(xQualifiedToken ? { xQualifiedToken } : {}),
        vaultPassword,
        username,
        depositAmountCAW: depositAmount,
        networkId: DEFAULT_NETWORK_ID,
        lzDestId: DEFAULT_LZ_DEST_ID,
        passkeyPubkeyX: passkey.pubkeyX,
        passkeyPubkeyY: passkey.pubkeyY,
        smartEoaAddress,
        rpcProvider,
        passkeySigner,
        sponsorApi,
        minterAddress: CAW_NAMES_MINTER_ADDRESS as `0x${string}`,
        permitNonce: BOOTSTRAP_PERMIT_NONCE,
        lzTokenAmount: DEFAULT_LZ_TOKEN_AMOUNT,
        // Sponsor-Repay (Phase 2): fold the code-derived repay obligation into
        // the signed digest. kycLevel stays 0 (repay-only, no KYC gate). These
        // MUST match the server's code-derived values (it recomputes from the
        // same code + depositAmount) or the on-chain ERC-1271 check fails.
        kycLevel: 0,
        sponsorTokenId,
        repayAmount,
      })

      // Server-hosted convenience copy (passkey-gated). No email at this stage —
      // the user picks email explicitly in the backup step.
      // Fire-and-forget: a store failure must not block onboarding.
      try {
        void apiFetch('/api/wallet/blob', {
          method: 'POST',
          body: JSON.stringify({
            address: result.ecdsaAddress,
            blob: JSON.stringify(result.backupBlob),
            username,
            // email omitted — sent separately if the user chooses in BackupStep
          }),
        }).catch(() => { /* non-fatal */ })
      } catch { /* non-fatal */ }

      // Hand the minted wallet up; parent advances to the backup step.
      onCreated(result)
    } catch (err: unknown) {
      const errCode = (err as Error & { code?: string })?.code
      if (errCode === 'USERNAME_TAKEN') {
        // Return to username step so the user can pick a different name.
        onUsernameTaken()
        return
      }

      let kind: ErrorKind = 'generic'
      let detail: string | undefined

      if (errCode === 'INSUFFICIENT_FUNDS') {
        kind = 'INSUFFICIENT_FUNDS'
      } else if (errCode === 'RATE_LIMITED') {
        kind = 'RATE_LIMITED'
        detail = (err as Error & { detail?: string })?.detail ?? (err instanceof Error ? err.message : undefined)
      } else if (errCode === 'CODE_RATE_LIMITED') {
        // Throttle on attempt VOLUME, not code validity — safe to surface the
        // actionable "try again in an hour" detail instead of the opaque
        // "code rejected" bucket. The detail rides in the Error message. (#238)
        kind = 'CODE_RATE_LIMITED'
        detail = (err as Error & { detail?: string })?.detail ?? (err instanceof Error ? err.message : undefined)
      } else if (errCode && SPONSOR_CODE_ERROR_CODES.has(errCode)) {
        // Collapse all sponsor-code errors into one generic UI. Surfacing
        // the specific error (e.g. CODE_EXPIRED vs INVALID_CODE) would let
        // an attacker probe code validity. The server-side response is
        // already constant-time; FE-side message has to match.
        kind = 'CODE_REJECTED'
      } else {
        detail = err instanceof Error ? err.message : undefined
      }

      setError({ kind, detail })
    } finally {
      setLoadingPhase(null)
    }
  }

  // ── Error renderer ──────────────────────────────────────────────────────────

  const renderError = () => {
    if (!error.kind) return null

    let msg: string
    switch (error.kind) {
      case 'INSUFFICIENT_FUNDS':
        msg = t('onboarding.backup.error_no_funds')
        break
      case 'RATE_LIMITED':
        msg = error.detail
          ? t('onboarding.backup.error_rate_limited_detail', { detail: error.detail })
          : t('onboarding.backup.error_rate_limited')
        break
      case 'CODE_RATE_LIMITED':
        msg = error.detail || t('onboarding.backup.error_code_rate_limited')
        break
      case 'CODE_REJECTED':
        msg = t('onboarding.backup.error_code_rejected')
        break
      default:
        msg = error.detail
          ? `${t('onboarding.backup.error_generic')}: ${error.detail}`
          : t('onboarding.backup.error_generic')
    }

    return (
      <div className={`rounded-xl p-4 border ${isDark ? 'bg-red-500/10 border-red-500/30' : 'bg-red-50 border-red-200'}`}>
        <p className={`text-sm ${isDark ? 'text-red-400' : 'text-red-700'}`}>
          {msg}
        </p>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
          {t('onboarding.create.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.create.subtitle')}
        </p>
      </div>

      {/* "Digital identity ready" card — a passkey + recovery key are enrolled;
          the on-chain account does not exist until the user taps create. We never
          show the raw EOA address (noise + footgun for a phone-first audience);
          the "digital identity" link reveals an explanatory tooltip instead. */}
      <div className={`rounded-xl p-4 border ${isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-200'}`}>
        <div className="flex gap-3">
          <svg className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="min-w-0">
            <p className={`text-sm font-semibold ${isDark ? 'text-green-400' : 'text-green-800'}`}>
              {t('onboarding.create.ready_title')}
            </p>
            <p className={`text-sm mt-1 ${isDark ? 'text-green-300/80' : 'text-green-700'}`}>
              {/* "Your digital identity is ready." — the linked phrase opens a
                  tooltip explaining what it is, without ever printing the 0x… */}
              <button
                type="button"
                onClick={() => setShowIdentityTip(v => !v)}
                className="underline decoration-dotted underline-offset-2 hover:opacity-80 cursor-pointer font-medium"
              >
                {t('onboarding.create.identity_link')}
              </button>{' '}
              {t('onboarding.create.ready_body')}
            </p>
            {showIdentityTip && (
              <p className={`text-xs mt-2 rounded-lg p-2 ${isDark ? 'bg-black/30 text-white/70' : 'bg-white/70 text-gray-600'}`}>
                {t('onboarding.create.identity_tooltip')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Sponsor-Repay disclosure — only when this code carries a repay
          obligation. Makes the repay-at-withdrawal terms explicit BEFORE the
          user signs the mint permit (your gift includes a repayment clause). */}
      {repayAmount > 0n && (
        <div className={`rounded-xl p-4 border ${isDark ? 'bg-orange-500/10 border-orange-500/30' : 'bg-orange-50 border-orange-200'}`}>
          <div className="flex gap-3">
            <svg className="w-5 h-5 text-orange-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className={`text-sm font-semibold ${isDark ? 'text-orange-400' : 'text-orange-800'}`}>
                {t('onboarding.backup.repay_title')}
              </p>
              <p className={`text-sm mt-1 ${isDark ? 'text-orange-300/80' : 'text-orange-700'}`}>
                {t('onboarding.backup.repay_body', { amount: formatCawWei(repayAmount) })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className={`flex items-center gap-3 p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="w-5 h-5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <p className={`text-sm ${mutedClass}`}>
            {loadingPhase === 'sponsor'
              ? t('onboarding.backup.loading_sponsor')
              : t('onboarding.backup.loading_chain')}
          </p>
        </div>
      )}

      {/* Error */}
      {renderError()}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          disabled={isLoading}
          className={`
            flex-1 py-3 rounded-full font-semibold text-sm transition-all border
            ${isLoading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
            ${isDark
              ? 'border-white/20 text-white/70 hover:bg-white/5'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }
          `}
        >
          {t('common.back')}
        </button>
        <button
          onClick={handleBootstrap}
          disabled={isLoading}
          className={`
            flex-1 py-3 rounded-full font-semibold text-sm transition-all
            ${isLoading
              ? 'bg-yellow-500/50 text-black/60 cursor-not-allowed'
              : 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
            }
          `}
        >
          {isLoading
            ? t('onboarding.backup.loading_sponsor')
            : error.kind
              ? t('common.try_again')
              : t('onboarding.create.cta_create')}
        </button>
      </div>
    </div>
  )
}
