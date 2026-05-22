/**
 * BackupStep.tsx
 *
 * Step 5 of /onboarding: run bootstrapNewUser() and trigger a backup blob
 * download.
 *
 * What happens here:
 *   1. bootstrapNewUser() → secp256k1 keygen + Argon2id encrypt + sponsor submit
 *   2. On success, downloadBackupBlob() triggers the OS save dialog
 *   3. Call onNext({ txHash, ecdsaAddress }) to advance to confirm step
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
 *   (not used in Wave 2 — receipt polling is Wave 3; tx hash is returned immediately)
 */

import { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { bootstrapNewUser, type BootstrapResult } from '~/services/identity/bootstrap'
import { downloadBackupBlob } from '~/services/identity/cloudBackup'
import {
  getSponsorApiClient,
  isSponsorSuccess,
} from '~/services/identity/sponsorApiClient'
import { buildMintDepositPermitDigest } from '~/services/identity/eip712Permits'
import { signWithPasskey, type PasskeyPubkey } from '~/services/identity/passkey'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
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

export default function BackupStep({
  code,
  username,
  depositAmount,
  vaultPassword,
  passkey,
  onNext,
  onUsernameTaken,
  onBack,
}: BackupStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const publicClient = usePublicClient()

  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>(null)
  const [error, setError] = useState<BootstrapError>({ kind: null })

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const isLoading = loadingPhase !== null

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

      // Derive the SmartEOA address from config.
      // The minter address is a reasonable proxy until a dedicated SMART_EOA_ADDRESS
      // constant exists in the addresses file.
      const smartEoaAddress = (
        (import.meta.env.VITE_SMART_EOA_ADDRESS as string | undefined) ??
        CAW_NAMES_MINTER_ADDRESS
      ) as `0x${string}`

      const chainId = await rpcProvider.getChainId()

      // Build the permit digest the passkey will sign over.
      // In production the sponsor server provides the nonce; here we use a
      // placeholder that matches the sponsor stub's expectation.
      const permitDigest = buildMintDepositPermitDigest({
        minterAddress: CAW_NAMES_MINTER_ADDRESS as `0x${string}`,
        chainId,
        networkId: DEFAULT_NETWORK_ID,
        recipient: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        username,
        depositAmount,
        lzDestId: DEFAULT_LZ_DEST_ID,
        lzTokenAmount: DEFAULT_LZ_TOKEN_AMOUNT,
        nonce: BOOTSTRAP_PERMIT_NONCE,
      })

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
        sponsorBootstrap: async (params: Parameters<typeof sponsorClientRaw.sponsorBootstrap>[0]) => {
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
        permitDigest,
      })

      // Trigger the file download while still in "sponsor" phase — it is a
      // synchronous DOM operation and does not need a separate loading state.
      downloadBackupBlob(result.backupBlob, `caw-recovery-${username}.json`)

      // Advance to confirm step.
      onNext(result)
    } catch (err: unknown) {
      const code = (err as Error & { code?: string })?.code
      if (code === 'USERNAME_TAKEN') {
        // Return to username step so the user can pick a different name.
        onUsernameTaken()
        return
      }

      let kind: ErrorKind = 'generic'
      let detail: string | undefined

      if (code === 'INSUFFICIENT_FUNDS') {
        kind = 'INSUFFICIENT_FUNDS'
      } else if (code === 'RATE_LIMITED') {
        kind = 'RATE_LIMITED'
        detail = (err as Error & { detail?: string })?.detail
      } else if (code && SPONSOR_CODE_ERROR_CODES.has(code)) {
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
          {t('onboarding.backup.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.backup.subtitle')}
        </p>
      </div>

      {/* Recovery file icon */}
      <div className="flex justify-center py-4">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center ${isDark ? 'bg-blue-500/15' : 'bg-blue-50'}`}>
          <svg className="w-10 h-10 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
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
              : t('onboarding.backup.cta')}
        </button>
      </div>
    </div>
  )
}
