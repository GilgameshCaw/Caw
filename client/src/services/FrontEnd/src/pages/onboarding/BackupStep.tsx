/**
 * BackupStep.tsx
 *
 * Step 5 of /onboarding — two phases:
 *
 * Phase 'mint':
 *   Show title, warning, repay disclosure, and a "Create my account" button.
 *   On success: stash BootstrapResult, POST /api/wallet/blob (no email),
 *   advance to phase 'backup'.
 *
 * Phase 'backup':
 *   Three explicit backup actions (download, email, host status-line).
 *   Continue / Skip-backup link with a warning modal if no user-chosen
 *   backup was completed.
 *
 * Error handling:
 *   USERNAME_TAKEN     → onUsernameTaken() callback (parent returns to username step)
 *   INSUFFICIENT_FUNDS → show inline error + Retry
 *   RATE_LIMITED       → show inline error with hours hint + Retry
 *   Other              → generic error + Retry (state is preserved for retry)
 *
 * Loading states:
 *   'sponsor'  → spinner + "Waiting for sponsor server…"
 *   'chain'    → spinner + "Confirming on-chain…"
 */

import { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { bootstrapNewUser, type BootstrapResult, type BootstrapParams } from '~/services/identity/bootstrap'
import { downloadBackupBlob } from '~/services/identity/cloudBackup'
import { apiFetch } from '~/api/client'
import {
  getSponsorApiClient,
  isSponsorSuccess,
} from '~/services/identity/sponsorApiClient'
import { signWithPasskey, type PasskeyPubkey } from '~/services/identity/passkey'
import { CAW_NAMES_MINTER_ADDRESS, SMART_EOA_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { usePublicClient } from 'wagmi'

export interface BackupStepProps {
  /**
   * Sponsor invite code, read from /onboarding?code=... and threaded down
   * through Onboarding state. Required: the sponsor server rejects bootstrap
   * requests without a code. See client/src/api/middleware/validateSponsorCode.ts.
   */
  code: string
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
  onNext: (result: BootstrapResult) => void
  onUsernameTaken: () => void
  onBack: () => void
}

type LoadingPhase = 'sponsor' | 'chain' | null

type ErrorKind =
  | 'INSUFFICIENT_FUNDS'
  | 'RATE_LIMITED'
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

interface BootstrapError {
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

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Compact wei → "1.5M CAW" style label for the repay disclosure. */
function formatCawWei(wei: bigint): string {
  const whole = Number(wei / 10n ** 18n)
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(whole % 1_000_000 === 0 ? 0 : 1)}M CAW`
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(whole % 1_000 === 0 ? 0 : 1)}K CAW`
  return `${whole.toLocaleString()} CAW`
}

export default function BackupStep({
  code,
  username,
  depositAmount,
  repayAmount,
  sponsorTokenId,
  vaultPassword,
  passkey,
  onNext,
  onUsernameTaken,
  onBack,
}: BackupStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const publicClient = usePublicClient()

  // Which phase we're in
  const [phase, setPhase] = useState<'mint' | 'backup'>('mint')
  // Stash the result across phases
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null)

  // Mint-phase state
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>(null)
  const [error, setError] = useState<BootstrapError>({ kind: null })

  // Backup-phase state
  const [didDownload, setDidDownload] = useState(false)
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailResult, setEmailResult] = useState<'sent' | 'sent_spam' | 'unavailable' | null>(null)
  const [didEmail, setDidEmail] = useState(false)

  // Host copy is stored automatically in phase 'mint' — always-on status line.
  const didHost = bootstrapResult !== null

  // Skip-warning modal
  const [showSkipWarning, setShowSkipWarning] = useState(false)

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const isLoading = loadingPhase !== null

  const emailFormatValid = recoveryEmail === '' || EMAIL_REGEX.test(recoveryEmail.trim())
  const canSendEmail = recoveryEmail.trim() !== '' && EMAIL_REGEX.test(recoveryEmail.trim()) && !emailSending && emailResult === null

  // ── Phase 'mint' ──────────────────────────────────────────────────────────

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
          const req = {
            code: params.code,
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
        code,
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
      // the user picks email explicitly in phase 'backup'.
      // Fire-and-forget: a store failure must not block onboarding.
      try {
        void apiFetch('/api/wallet/blob', {
          method: 'POST',
          body: JSON.stringify({
            address: result.ecdsaAddress,
            blob: JSON.stringify(result.backupBlob),
            username,
            // email omitted — sent separately if the user chooses in phase 'backup'
          }),
        }).catch(() => { /* non-fatal */ })
      } catch { /* non-fatal */ }

      // Stash result and advance to backup phase.
      setBootstrapResult(result)
      setPhase('backup')
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
        detail = (err as Error & { detail?: string })?.detail
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

  // ── Phase 'backup' helpers ────────────────────────────────────────────────

  const handleDownload = () => {
    if (!bootstrapResult) return
    downloadBackupBlob(bootstrapResult.backupBlob, `caw-recovery-${username}.json`)
    setDidDownload(true)
  }

  const handleSendEmail = async () => {
    if (!bootstrapResult || !canSendEmail) return
    setEmailSending(true)
    setEmailResult(null)
    try {
      const raw = await apiFetch('/api/wallet/blob', {
        method: 'POST',
        body: JSON.stringify({
          address: bootstrapResult.ecdsaAddress,
          blob: JSON.stringify(bootstrapResult.backupBlob),
          username,
          email: recoveryEmail.trim(),
        }),
      })
      const json = await (raw as Response).json() as {
        ok: boolean
        emailed: boolean
        usedFallback?: boolean
        mailerConfigured?: boolean
      }
      if (json.emailed) {
        setEmailResult(json.usedFallback ? 'sent_spam' : 'sent')
        setDidEmail(true)
      } else {
        setEmailResult('unavailable')
      }
    } catch {
      setEmailResult('unavailable')
    } finally {
      setEmailSending(false)
    }
  }

  const handleContinue = () => {
    if (!bootstrapResult) return
    onNext(bootstrapResult)
  }

  const handleSkipClick = () => {
    // didHost doesn't count as a user-chosen backup.
    if (!didDownload && !didEmail) {
      setShowSkipWarning(true)
    } else {
      handleContinue()
    }
  }

  // ── Error renderer (mint phase) ───────────────────────────────────────────

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

  // ── Skip-warning modal ────────────────────────────────────────────────────

  const renderSkipWarning = () => {
    if (!showSkipWarning) return null
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className={`mx-4 max-w-sm w-full rounded-2xl p-6 space-y-4 ${isDark ? 'bg-gray-900 border border-white/10' : 'bg-white border border-gray-200'}`}>
          <h3 className={`text-lg font-bold ${strongClass}`}>
            {t('onboarding.backup.skip_warn_title')}
          </h3>
          <p className={`text-sm ${mutedClass}`}>
            {t('onboarding.backup.skip_warn_body')}
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => setShowSkipWarning(false)}
              className={`flex-1 py-2.5 rounded-full font-semibold text-sm transition-all border cursor-pointer ${isDark ? 'border-white/20 text-white/70 hover:bg-white/5' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
            >
              {t('onboarding.backup.skip_go_back')}
            </button>
            <button
              onClick={() => {
                setShowSkipWarning(false)
                if (bootstrapResult) onNext(bootstrapResult)
              }}
              className="flex-1 py-2.5 rounded-full font-semibold text-sm bg-red-500 text-white hover:bg-red-600 transition-all cursor-pointer"
            >
              {t('onboarding.backup.skip_confirm')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render: phase 'mint' ──────────────────────────────────────────────────

  if (phase === 'mint') {
    return (
      <div className="space-y-6">
        {renderSkipWarning()}

        <div>
          <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
            {t('onboarding.backup.title')}
          </h2>
          <p className={`text-sm ${mutedClass}`}>
            {t('onboarding.backup.subtitle')}
          </p>
        </div>

        {/* Warning about importance */}
        <div className={`rounded-xl p-4 border ${isDark ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'}`}>
          <div className="flex gap-3">
            <svg className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <p className={`text-sm font-semibold ${isDark ? 'text-yellow-400' : 'text-yellow-800'}`}>
                {t('onboarding.backup.warning_title')}
              </p>
              <p className={`text-sm mt-1 ${isDark ? 'text-yellow-300/80' : 'text-yellow-700'}`}>
                {t('onboarding.backup.warning_body')}
              </p>
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
                : t('onboarding.backup.cta_create')}
          </button>
        </div>
      </div>
    )
  }

  // ── Render: phase 'backup' ────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {renderSkipWarning()}

      <div>
        <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
          {t('onboarding.backup.ready_title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.backup.ready_subtitle')}
        </p>
      </div>

      {/* Storage suggestions */}
      <div className={`rounded-xl p-4 space-y-2 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <p className={`text-sm font-medium ${strongClass}`}>
          {t('onboarding.backup.save_to')}
        </p>
        <ul className={`text-sm space-y-1 ${mutedClass} list-disc list-inside`}>
          <li>{t('onboarding.backup.save_icloud')}</li>
          <li>{t('onboarding.backup.save_google')}</li>
          <li>{t('onboarding.backup.save_usb')}</li>
        </ul>
      </div>

      {/* ── Action 1: Download ── */}
      <div className={`rounded-xl p-4 border ${isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'}`}>
        <div className="flex items-center justify-between gap-3">
          <p className={`text-sm font-medium ${strongClass}`}>
            {t('onboarding.backup.action_download_label')}
          </p>
          {didDownload ? (
            <span className="flex items-center gap-1 text-green-500 text-sm font-medium shrink-0">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {t('onboarding.backup.action_saved')}
            </span>
          ) : (
            <button
              onClick={handleDownload}
              className="shrink-0 px-4 py-2 rounded-full font-semibold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-all cursor-pointer"
            >
              {t('onboarding.backup.action_download')}
            </button>
          )}
        </div>
      </div>

      {/* ── Action 2: Email ── */}
      <div className={`rounded-xl p-4 border ${isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'} space-y-3`}>
        <p className={`text-sm font-medium ${strongClass}`}>
          {t('onboarding.backup.email_to_label')}
        </p>
        <div className="flex gap-2 items-center">
          <input
            type="email"
            value={recoveryEmail}
            onChange={e => { setRecoveryEmail(e.target.value); setEmailResult(null) }}
            placeholder={t('onboarding.backup.email_placeholder')}
            autoComplete="email"
            disabled={emailSending || emailResult === 'sent' || emailResult === 'sent_spam'}
            className={`flex-1 min-w-0 px-4 py-2.5 rounded-xl border text-sm outline-none transition-colors ${
              isDark
                ? 'bg-white/5 border-white/20 text-white placeholder-white/30'
                : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
            } ${!emailFormatValid ? 'border-red-500' : 'focus:border-yellow-500'} disabled:opacity-50`}
          />
          <button
            onClick={handleSendEmail}
            disabled={!canSendEmail}
            className={`shrink-0 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all flex items-center gap-2 ${
              canSendEmail
                ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
                : 'bg-yellow-500/40 text-black/50 cursor-not-allowed'
            }`}
          >
            {emailSending && (
              <span className="w-4 h-4 border-2 border-black/40 border-t-black rounded-full animate-spin" />
            )}
            {t('onboarding.backup.email_send')}
          </button>
        </div>
        {!emailFormatValid && recoveryEmail !== '' && (
          <p className="text-xs text-red-500">{t('onboarding.backup.email_invalid')}</p>
        )}
        {emailResult === 'sent' && (
          <p className="text-xs text-green-500">{t('onboarding.backup.email_sent')}</p>
        )}
        {emailResult === 'sent_spam' && (
          <p className="text-xs text-green-500">{t('onboarding.backup.email_sent_spam')}</p>
        )}
        {emailResult === 'unavailable' && (
          <p className={`text-xs ${mutedClass}`}>{t('onboarding.backup.email_unavailable')}</p>
        )}
        <p className={`text-xs ${mutedClass}`}>{t('onboarding.backup.email_privacy')}</p>
      </div>

      {/* ── Action 3: Host on this domain — always-on status line ── */}
      <div className={`rounded-xl p-4 border ${
        didHost
          ? isDark ? 'bg-green-500/10 border-green-500/20' : 'bg-green-50 border-green-200'
          : isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'
      }`}>
        <div className="flex items-center gap-3">
          <svg className={`w-4 h-4 shrink-0 ${didHost ? 'text-green-500' : mutedClass}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <div>
            <p className={`text-sm font-medium ${didHost ? (isDark ? 'text-green-400' : 'text-green-700') : strongClass}`}>
              {t('onboarding.backup.action_host')}
            </p>
            <p className={`text-xs mt-0.5 ${mutedClass}`}>
              {t('onboarding.backup.host_hint')}
            </p>
          </div>
        </div>
      </div>

      {/* Continue / Skip */}
      <div className="space-y-2">
        <button
          onClick={handleContinue}
          className="w-full py-3 rounded-full font-semibold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-all cursor-pointer"
        >
          {t('onboarding.backup.done')}
        </button>
        <div className="flex justify-center">
          <button
            onClick={handleSkipClick}
            className={`text-sm underline transition-opacity hover:opacity-70 cursor-pointer ${mutedClass}`}
          >
            {t('onboarding.backup.skip')}
          </button>
        </div>
      </div>
    </div>
  )
}
