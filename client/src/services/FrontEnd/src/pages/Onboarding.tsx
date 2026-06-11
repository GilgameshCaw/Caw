/**
 * Onboarding.tsx
 *
 * Multi-step onboarding for new users who arrive via the "I don't have a
 * wallet" link on the connect modal. Builds a phone-first (EIP-7702 /
 * Population B) identity without requiring the user to already own a wallet.
 *
 * Steps:
 *  1. username       — pick & verify username availability (gift info shown inline)
 *  2. vault-password — set vault password protecting the backup blob
 *  3. passkey        — enroll WebAuthn passkey (Face ID / Touch ID / Windows Hello)
 *  4. backup         — bootstrapNewUser() + download recovery file
 *  5. confirm        — success + txHash + navigate to feed
 *
 * The deposit amount is NOT chosen by the user. The invite code defines a fixed
 * CAW gift (fetched from GET /api/sponsor/code/:code). The username burn cost is
 * deducted from giftCaw; the remainder is auto-deposited. No deposit step.
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useNavigate } from '~/utils/localizedRouter'
import UsernameStep from './onboarding/UsernameStep'
import VaultPasswordStep from './onboarding/VaultPasswordStep'
import PasskeyStep from './onboarding/PasskeyStep'
import BackupStep from './onboarding/BackupStep'
import ConfirmStep from './onboarding/ConfirmStep'
import BoidsBg from '~/components/BoidsBg3D'
import LanguageSwitcher from '~/components/LanguageSwitcher'
import {
  HiAtSymbol,
  HiLockClosed,
  HiFingerPrint,
  HiCloudDownload,
  HiCheck,
} from 'react-icons/hi'
import type { PasskeyPubkey } from '~/services/identity/passkey'
import type { BootstrapResult } from '~/services/identity/bootstrap'
import { apiFetch, retryOnIndexing } from '~/api/client'
import { useAuthStore } from '~/store/authStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import type { TokenData } from '~/types'
import { baseSepolia } from 'wagmi/chains'

type OnboardingStep =
  | 'username'
  | 'vault-password'
  | 'passkey'
  | 'backup'
  | 'confirm'

interface OnboardingState {
  step: OnboardingStep
  username: string
  usernameAvailable: boolean | null
  usernameError: string | null
  vaultPassword: string
  vaultPasswordConfirm: string
  enrolledPasskey: PasskeyPubkey | null
  bootstrapResult: BootstrapResult | null
}

/** Gift code metadata fetched from /api/sponsor/code/:code */
interface SponsorCodeInfo {
  valid: boolean
  giftCaw?: bigint          // total CAW gifted, in wei
  minUsernameLength?: number
  expiresAt?: string
  /**
   * Sponsor-Repay policy (Phase 2). repayBps is basis points of the deposit
   * the user must repay on first withdrawal (0 = plain gift, 20000 = 2x cap).
   * sponsorTokenId is the profile that collects the repayment. Both must be
   * folded into the signed permit digest, so they're fetched up-front.
   */
  repayBps?: number
  sponsorTokenId?: number
}

const INITIAL_STATE: OnboardingState = {
  step: 'username',
  username: '',
  usernameAvailable: null,
  usernameError: null,
  vaultPassword: '',
  vaultPasswordConfirm: '',
  enrolledPasskey: null,
  bootstrapResult: null,
}

// Steps that show in the segmented stepper (exclude the confirm step).
const PROGRESS_STEPS: OnboardingStep[] = [
  'username',
  'vault-password',
  'passkey',
  'backup',
]

const ALL_STEPS: OnboardingStep[] = [
  'username',
  'vault-password',
  'passkey',
  'backup',
  'confirm',
]

// Username burn cost schedule (whole CAW, length → cost). Mirrors UsernameStep
// and pages/Profile/New.tsx — keep in sync.
const COST_SCHEDULE: Record<number, number> = {
  1: 1_000_000_000_000,
  2:   240_000_000_000,
  3:    60_000_000_000,
  4:     6_000_000_000,
  5:       200_000_000,
  6:        20_000_000,
  7:        10_000_000,
}
const DEFAULT_COST = 1_000_000  // 8+ chars

function cawCostForLength(len: number): number {
  if (len === 0) return 0
  return COST_SCHEDULE[len] ?? DEFAULT_COST
}

interface StepMeta {
  id: OnboardingStep
  icon: React.ReactNode
  shortLabel: string
}

// Icon size matches PostMintOnboarding (w-4 h-4 inside the label row)
const STEP_META: StepMeta[] = [
  { id: 'username',       icon: <HiAtSymbol className="w-4 h-4" />,     shortLabel: '@' },
  { id: 'vault-password', icon: <HiLockClosed className="w-4 h-4" />,   shortLabel: 'Vault' },
  { id: 'passkey',        icon: <HiFingerPrint className="w-4 h-4" />,  shortLabel: 'Key' },
  { id: 'backup',         icon: <HiCloudDownload className="w-4 h-4" />,shortLabel: 'Save' },
]

function stepIndex(step: OnboardingStep): number {
  return ALL_STEPS.indexOf(step)
}

/**
 * Normalize a user-provided invite code: uppercase, strip dashes/whitespace.
 * Matches the server's normalization in validateSponsorCode.ts so HMAC lines up.
 */
function normalizeCode(raw: string): string {
  return raw.replace(/[-\s]/g, '').toUpperCase()
}

/**
 * Loose client-side format gate. Tighter validation happens server-side
 * (HMAC + DB lookup, constant-time). 8–64 chars of alphanumeric after
 * normalization is the broadest accepting filter.
 */
function isPlausibleCodeFormat(raw: string | null): boolean {
  if (!raw) return false
  const n = normalizeCode(raw)
  return /^[A-Z0-9]{8,64}$/.test(n)
}

function stepLabel(step: OnboardingStep, t: (k: string) => string): string {
  switch (step) {
    case 'username':       return t('onboarding.step.username')
    case 'vault-password': return t('onboarding.step.vault_password')
    case 'passkey':        return t('onboarding.step.passkey')
    case 'backup':         return t('onboarding.step.backup')
    case 'confirm':        return t('onboarding.step.confirm')
  }
}

export default function Onboarding() {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()
  const [state, setState] = useState<OnboardingState>(INITIAL_STATE)
  const setSession = useAuthStore(s => s.setSession)
  // True while the post-mint /api/auth/verify sign-in is in flight (shown on
  // the confirm step so "Go to feed" waits for the session).
  const [signingIn, setSigningIn] = useState(false)

  // Invite-code gate.
  const [searchParams] = useSearchParams()
  const rawCode = searchParams.get('code')
  const normalizedCode = useMemo(
    () => (rawCode ? normalizeCode(rawCode) : ''),
    [rawCode],
  )
  const codeValid = isPlausibleCodeFormat(rawCode)

  // ── Gift code fetch ────────────────────────────────────────────────────────
  // Fetched once on mount (when the code passes the loose format check).
  // While loading, giftInfo is null — UsernameStep disables Next.
  const [giftInfo, setGiftInfo] = useState<SponsorCodeInfo | null>(null)
  const [giftLoading, setGiftLoading] = useState(false)

  useEffect(() => {
    if (!codeValid || !normalizedCode) return
    let cancelled = false
    setGiftLoading(true)
    apiFetch<{
      valid: boolean
      giftCaw?: string
      minUsernameLength?: number
      expiresAt?: string
      repayBps?: number
      sponsorTokenId?: number
    }>(`/api/sponsor/code/${encodeURIComponent(normalizedCode)}`)
      .then((json) => {
        if (cancelled) return
        if (json.valid && json.giftCaw) {
          setGiftInfo({
            valid: true,
            giftCaw: BigInt(json.giftCaw),
            minUsernameLength: json.minUsernameLength,
            expiresAt: json.expiresAt,
            repayBps: json.repayBps ?? 0,
            sponsorTokenId: json.sponsorTokenId ?? 0,
          })
        } else {
          // Server says invalid — treat like bad code format.
          setGiftInfo({ valid: false })
        }
      })
      .catch(() => {
        if (!cancelled) setGiftInfo({ valid: false })
      })
      .finally(() => {
        if (!cancelled) setGiftLoading(false)
      })
    return () => { cancelled = true }
  }, [codeValid, normalizedCode])

  // ── Derived deposit amount ─────────────────────────────────────────────────
  // giftCaw - (username burn cost in wei). Computed at render time from live
  // username; never stored in state — always fresh from giftInfo.
  const derivedDepositAmount = useMemo((): bigint => {
    if (!giftInfo?.valid || !giftInfo.giftCaw) return 0n
    const burnCostWei = BigInt(cawCostForLength(state.username.length)) * 10n ** 18n
    const remainder = giftInfo.giftCaw - burnCostWei
    return remainder > 0n ? remainder : 0n
  }, [giftInfo, state.username])

  // ── Derived repay obligation (Sponsor-Repay Phase 2) ───────────────────────
  // repayAmount = depositAmount * repayBps / 10000, computed from the SAME
  // depositAmount that gets signed and sent — the server recomputes identically
  // from the code, so the signed digest matches the on-chain call. 0 = plain gift.
  const repayBps = giftInfo?.valid ? (giftInfo.repayBps ?? 0) : 0
  const repaySponsorTokenId = giftInfo?.valid ? (giftInfo.sponsorTokenId ?? 0) : 0
  const derivedRepayAmount = useMemo((): bigint => {
    if (repayBps <= 0) return 0n
    return (derivedDepositAmount * BigInt(repayBps)) / 10000n
  }, [derivedDepositAmount, repayBps])

  const showProgress = PROGRESS_STEPS.includes(state.step as typeof PROGRESS_STEPS[number])
  const progressIndex = PROGRESS_STEPS.indexOf(state.step as typeof PROGRESS_STEPS[number])

  // Theme helpers — mirrors PostMintOnboarding tc object pattern
  const outerBg = isDark ? 'bg-black' : 'bg-white'
  const textPrimary = isDark ? 'text-white' : 'text-gray-900'
  const textFaint = isDark ? 'text-white/40' : 'text-gray-500'
  const stepperInactive = isDark ? 'bg-[#1A1A1A]/85' : 'bg-black/10'

  // ── Navigation ────────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    const nextIndex = stepIndex(state.step) + 1
    if (nextIndex < ALL_STEPS.length) {
      setState(s => ({ ...s, step: ALL_STEPS[nextIndex] }))
    }
  }, [state.step])

  const goBack = useCallback(() => {
    const prevIndex = stepIndex(state.step) - 1
    if (prevIndex >= 0) {
      setState(s => ({ ...s, step: ALL_STEPS[prevIndex] }))
    } else {
      navigate('/')
    }
  }, [state.step, navigate])

  // ── State setters ─────────────────────────────────────────────────────────

  const handleUsernameChange = useCallback((username: string) => {
    setState(s => ({ ...s, username, usernameAvailable: null, usernameError: null }))
  }, [])

  const handleAvailabilityChange = useCallback((available: boolean | null) => {
    setState(s => ({ ...s, usernameAvailable: available }))
  }, [])

  const handlePasswordChange = useCallback((vaultPassword: string) => {
    setState(s => ({ ...s, vaultPassword }))
  }, [])

  const handleConfirmChange = useCallback((vaultPasswordConfirm: string) => {
    setState(s => ({ ...s, vaultPasswordConfirm }))
  }, [])

  // PasskeyStep → advances to 'backup' after successful enrollment
  const handlePasskeyEnrolled = useCallback((passkey: PasskeyPubkey) => {
    setState(s => ({ ...s, enrolledPasskey: passkey, step: 'backup' }))
  }, [])

  // BackupStep → advances to 'confirm' after successful bootstrap, then
  // establishes an auth session so "Go to feed" lands the user signed-in
  // (without this they bounce to /welcome as a brand-new user).
  const handleBootstrapDone = useCallback((result: BootstrapResult) => {
    setState(s => ({
      ...s,
      bootstrapResult: result,
      step: 'confirm',
      vaultPassword: '',
      vaultPasswordConfirm: '',
    }))

    // Post-mint sign-in. The minted profile is owned by result.ecdsaAddress;
    // sign the standard /api/auth/verify message with that key (held only in
    // the result's one-shot closure) — same flow as useVerifyWallet, but no
    // wagmi wallet is connected. Mirror its message format EXACTLY (host +
    // hardcoded chainId + unix-seconds timestamp) so the server's host/chain
    // binding matches. Best-effort: if it fails (e.g. indexer not caught up
    // after retries) we still let the user reach the confirm screen.
    // TEMP DIAGNOSTIC (#209): trace every step of the post-mint sign-in so we
    // can see in the console exactly where it fails (it currently dumps the user
    // to /welcome with no session and no server-side verify request). Remove
    // once the auto-sign-in is confirmed working.
    // eslint-disable-next-line no-console
    console.log('[signin:diag] handleBootstrapDone fired', {
      hasResult: !!result,
      ecdsaAddress: result?.ecdsaAddress,
      hasSigner: typeof result?.signVerifyMessage === 'function',
      txHash: result?.txHash,
    })
    void (async () => {
      setSigningIn(true)
      try {
        const timestamp = Math.floor(Date.now() / 1000)
        const host = window.location.host.toLowerCase()
        const message =
          `Verify wallet ownership for CAW\n` +
          `Host: ${host}\n` +
          `ChainId: ${baseSepolia.id}\n` +
          `Timestamp: ${timestamp}`
        // eslint-disable-next-line no-console
        console.log('[signin:diag] about to sign verify message', { host, message })
        const signature = await result.signVerifyMessage(message)
        // eslint-disable-next-line no-console
        console.log('[signin:diag] signed OK, posting /api/auth/verify', {
          sigPrefix: signature?.slice(0, 14),
          expectedOwner: result?.ecdsaAddress,
        })
        // /api/auth/verify returns 202 while the fresh mint isn't indexed yet;
        // retryOnIndexing backs off and re-tries the SAME (message, signature)
        // — safe because the server's one-time-sig guard runs after the 202
        // branch (see auth.ts).
        const data = await retryOnIndexing(() =>
          apiFetch<{
            sessionToken: string
            authorizedTokenIds: number[]
            authorizedAddresses: string[]
            expiresAt: number
          }>('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, signature }),
          })
        )
        // eslint-disable-next-line no-console
        console.log('[signin:diag] verify SUCCESS, setting session', {
          tokenIds: data?.authorizedTokenIds,
          addresses: data?.authorizedAddresses,
        })
        setSession(
          data.sessionToken,
          data.authorizedTokenIds,
          data.authorizedAddresses,
          data.expiresAt,
        )

        // Make the FE recognize this profile as the ACTIVE logged-in profile.
        // A sponsored Population-B user has NO connected wagmi wallet, so the
        // tokenDataStore (which is normally populated from on-chain token data
        // for the connected address) stays empty → useActiveToken() returns
        // nothing → AuthGate redirects to the bare /welcome captive splash
        // ("sign in" button, looks logged-out). We must inject the minted
        // profile into tokenDataStore and mark it active for the owner address.
        // Pick the token owned by THIS user (recoveredRecipient), not just the
        // first authorized id (the session may carry several).
        try {
          const owner = (result.ecdsaAddress).toLowerCase()
          // Find the minted tokenId: the authorized address that matches the
          // profile owner, paired by index with authorizedTokenIds.
          const idx = data.authorizedAddresses.findIndex(
            a => a.toLowerCase() === owner,
          )
          const mintedTokenId =
            idx >= 0 ? data.authorizedTokenIds[idx] : data.authorizedTokenIds[0]
          if (mintedTokenId != null) {
            // NOTE: /api/users/by-token returns the DB row shape — it does NOT
            // carry the on-chain bigint fields TokenData declares
            // (withdrawable / ownerBalance / stakedAmount). Casting the raw JSON
            // to TokenData leaves those undefined, and any component doing
            // `activeToken.stakedAmount > 0n` then throws "Cannot mix BigInt and
            // other types" — crashing the feed + /welcome render. Build a
            // properly-typed TokenData with real bigints (0n for a fresh mint;
            // the on-chain refresh updates them once the deposit confirms).
            const row = await apiFetch<{ username?: string; address?: string }>(
              `/api/users/by-token/${mintedTokenId}`,
            )
            if (row?.username) {
              const ownerAddr = result.ecdsaAddress as `0x${string}`
              const token: TokenData = {
                tokenId: mintedTokenId,
                username: row.username,
                address: ownerAddr,
                owner: ownerAddr,
                withdrawable: 0n,
                ownerBalance: 0n,
                stakedAmount: 0n,
                cawonce: 0,
              }
              const tds = useTokenDataStore.getState()
              tds.setTokensForAddress(ownerAddr, [token])
              tds.setActiveTokenIdForAddress(ownerAddr, mintedTokenId)
              tds.setLastAddress(ownerAddr)
              // eslint-disable-next-line no-console
              console.log('[signin:diag] active profile set, navigating to feed', {
                username: token.username,
                tokenId: mintedTokenId,
              })
              navigate('/home', { replace: true })
            }
          }
        } catch (e) {
          // Non-fatal: session is set; the user can reach their profile via the
          // confirm screen's button. Log for diagnostics.
          // eslint-disable-next-line no-console
          console.warn('[signin:diag] active-token set failed (non-fatal):', e)
        }
      } catch (err) {
        // Non-fatal: the mint succeeded; the user can sign in later via the
        // passkey/recovery path. Log for diagnostics.
        console.warn('[onboarding] post-mint sign-in failed (mint OK):', err)
        // eslint-disable-next-line no-console
        console.warn('[signin:diag] FAILED detail', {
          name: (err as Error)?.name,
          message: (err as Error)?.message,
          stack: (err as Error)?.stack?.split('\n').slice(0, 4).join(' | '),
        })
      } finally {
        setSigningIn(false)
      }
    })()
  }, [setSession])

  // BackupStep → USERNAME_TAKEN: return to username step with error hint
  const handleUsernameTaken = useCallback(() => {
    setState(s => ({
      ...s,
      step: 'username',
      usernameAvailable: false,
      usernameError: t('onboarding.username.taken_retry'),
    }))
  }, [t])

  // Invite-only stub — no code in URL, code fails format check, or server
  // says invalid.
  const codeInvalid = !codeValid || (giftInfo !== null && !giftInfo.valid)
  if (codeInvalid) {
    return (
      <div className={`fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden ${outerBg}`}>
        <BoidsBg isDark={isDark} />
        <div className="absolute top-3 right-3 z-[110]">
          <LanguageSwitcher />
        </div>
        <div className="relative z-10 px-4 py-8 min-h-screen flex items-center justify-center">
          <div className={`w-full max-w-md rounded-2xl border p-6 text-center ${
            isDark ? 'border-white/10 bg-black/60' : 'border-gray-200 bg-white/90'
          }`}>
            <h2 className={`text-xl font-bold mb-2 ${textPrimary}`}>
              {t('onboarding.invite_only.title')}
            </h2>
            <p className={`text-sm ${textFaint}`}>
              {t('onboarding.invite_only.body')}
            </p>
            <button
              onClick={() => navigate('/')}
              className={`mt-4 px-4 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer ${
                isDark
                  ? 'bg-white/10 text-white hover:bg-white/15'
                  : 'bg-black/5 text-gray-900 hover:bg-black/10'
              }`}
            >
              {t('common.back_home')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden ${outerBg}`}>
      <BoidsBg isDark={isDark} />

      {/* Language picker — top-right, matches PostMintOnboarding */}
      <div className="absolute top-3 right-3 z-[110]">
        <LanguageSwitcher />
      </div>

      <div className="relative z-10 px-4 py-8 min-h-screen flex items-start justify-center">
        <div className="w-full max-w-lg">

          {/* Slim segmented stepper — hidden on the confirm success screen */}
          {showProgress && (
            <>
              {/* Back chevron inline above the stepper */}
              <button
                onClick={goBack}
                className={`mb-3 flex items-center gap-1 text-sm transition-colors cursor-pointer ${textFaint} hover:${textPrimary}`}
                aria-label={t('common.back')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                <span>{t('common.back')}</span>
              </button>

              {/* Segmented stepper bar */}
              <div className="flex items-center justify-center gap-2 mb-6">
                {STEP_META.map((meta, i) => {
                  const done = i < progressIndex
                  const active = i === progressIndex
                  const label = stepLabel(meta.id, t)
                  return (
                    <button
                      key={meta.id}
                      onClick={() => {
                        if (i < progressIndex) {
                          const targetStep = ALL_STEPS[i]
                          setState(s => ({ ...s, step: targetStep }))
                        }
                      }}
                      className={`flex-1 min-w-[56px] flex flex-col items-center gap-2 transition-opacity duration-300 ${
                        done && !active ? 'opacity-70 cursor-pointer hover:opacity-100' : active ? 'opacity-100 cursor-default' : 'opacity-50 cursor-default'
                      }`}
                    >
                      <div className={`w-full h-2 rounded-full transition-all duration-300 ${
                        done ? 'bg-green-500'
                        : active ? 'bg-yellow-500'
                        : stepperInactive
                      }`} />
                      <div className="flex items-center gap-1 whitespace-nowrap">
                        <span className={`transition-colors duration-300 ${
                          done ? 'text-green-400'
                          : active ? 'text-yellow-500'
                          : textFaint
                        }`}>
                          {done ? <HiCheck className="w-4 h-4" /> : meta.icon}
                        </span>
                        <span className={`text-sm font-medium transition-colors duration-300 ${
                          done ? 'text-green-400'
                          : active ? textPrimary
                          : textFaint
                        }`}>
                          <span className="min-[480px]:hidden">{meta.shortLabel}</span>
                          <span className="hidden min-[480px]:inline">{label}</span>
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {/* Step content */}
          {state.step === 'username' && (
            <UsernameStep
              username={state.username}
              usernameAvailable={state.usernameAvailable}
              onUsernameChange={handleUsernameChange}
              onAvailabilityChange={handleAvailabilityChange}
              onNext={goNext}
              giftCaw={giftInfo?.valid ? giftInfo.giftCaw : undefined}
              minUsernameLength={giftInfo?.valid ? giftInfo.minUsernameLength : undefined}
              giftLoading={giftLoading}
            />
          )}

          {state.step === 'vault-password' && (
            <VaultPasswordStep
              vaultPassword={state.vaultPassword}
              vaultPasswordConfirm={state.vaultPasswordConfirm}
              onPasswordChange={handlePasswordChange}
              onConfirmChange={handleConfirmChange}
              onNext={goNext}
              onBack={goBack}
            />
          )}

          {state.step === 'passkey' && (
            <PasskeyStep
              username={state.username}
              onNext={handlePasskeyEnrolled}
              onBack={goBack}
            />
          )}

          {state.step === 'backup' && state.enrolledPasskey && (
            <BackupStep
              code={normalizedCode}
              username={state.username}
              depositAmount={derivedDepositAmount}
              repayAmount={derivedRepayAmount}
              sponsorTokenId={repaySponsorTokenId}
              vaultPassword={state.vaultPassword}
              passkey={state.enrolledPasskey}
              onNext={handleBootstrapDone}
              onUsernameTaken={handleUsernameTaken}
              onBack={goBack}
            />
          )}

          {state.step === 'confirm' && state.bootstrapResult && (
            <ConfirmStep
              username={state.username}
              txHash={state.bootstrapResult.txHash}
              signingIn={signingIn}
            />
          )}

        </div>
      </div>
    </div>
  )
}
