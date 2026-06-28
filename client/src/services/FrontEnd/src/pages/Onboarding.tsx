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

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { registerSponsoredSession, getDefaultSpendLimit, getDefaultTipCeiling, useNetworkTipTargetAsCAW, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { useXSignupVerification } from '~/hooks/useXSignupVerification'
import { getTipTiers } from '~/api/actions'
import { usePriceStore } from '~/store/tokenDataStore'
import { cawCostForLength } from '~/utils/cawCostSchedule'
import { useT } from '~/i18n/I18nProvider'
import { useNavigate } from '~/utils/localizedRouter'
import UsernameStep from './onboarding/UsernameStep'
import VaultPasswordStep from './onboarding/VaultPasswordStep'
import PasskeyStep from './onboarding/PasskeyStep'
import CreateAccountStep from './onboarding/CreateAccountStep'
import BackupStep from './onboarding/BackupStep'
import ConfirmStep from './onboarding/ConfirmStep'
import BoidsBg from '~/components/BoidsBg3D'
import cawLogo from '~/assets/images/caw-logo.png'
import LanguageSwitcher from '~/components/LanguageSwitcher'
import { evaluatePasskeyGate } from '~/utils/inAppBrowser'
import { probePrivateWindow, type PrivateProbe } from '~/utils/privateMode'
import {
  HiAtSymbol,
  HiLockClosed,
  HiFingerPrint,
  HiCloudDownload,
  HiCheck,
} from 'react-icons/hi'
import type { PasskeyPubkey } from '~/services/identity/passkey'
import { persistPasskeyIdentity } from '~/constants/passkeyStorage'
import type { BootstrapResult } from '~/services/identity/bootstrap'
import { apiFetch, retryOnIndexing } from '~/api/client'
import { useAuthStore } from '~/store/authStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import type { TokenData } from '~/types'
import { baseSepolia } from 'wagmi/chains'
import { deriveKeyPair } from '~/services/DmCryptoService'

type OnboardingStep =
  | 'welcome'        // gifted-access splash; shown only when arriving with a valid invite code
  | 'username'
  | 'vault-password'
  | 'passkey'
  | 'create-account' // the on-chain mint (#236 split this out of 'backup')
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
  /**
   * Why an invalid code is invalid, so onboarding can say "this code was already
   * used" / "expired" instead of bouncing to the X-signup gate as if it never
   * existed. Only set when valid === false. 'invalid' = unknown/bad/rate-limited.
   */
  reason?: 'used' | 'expired' | 'invalid'
  giftCaw?: bigint          // total CAW gifted (the pot), in wei
  gasCaw?: bigint           // live redeem-gas the server deducts from the gift, in WHOLE CAW
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
  'create-account',
  'backup',
]

const ALL_STEPS: OnboardingStep[] = [
  'username',
  'vault-password',
  'passkey',
  'create-account',
  'backup',
  'confirm',
]

interface StepMeta {
  id: OnboardingStep
  icon: React.ReactNode
  shortLabel: string
}

// Icon size matches PostMintOnboarding (w-4 h-4 inside the label row)
const STEP_META: StepMeta[] = [
  { id: 'username',       icon: <HiAtSymbol className="w-4 h-4" />,     shortLabel: 'Name' },
  { id: 'vault-password', icon: <HiLockClosed className="w-4 h-4" />,   shortLabel: 'Vault' },
  { id: 'passkey',        icon: <HiFingerPrint className="w-4 h-4" />,  shortLabel: 'Key' },
  { id: 'create-account', icon: <HiCheck className="w-4 h-4" />,        shortLabel: 'Create' },
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
    case 'welcome':        return ''  // splash — never rendered in the stepper
    case 'username':       return t('onboarding.step.username')
    case 'vault-password': return t('onboarding.step.vault_password')
    case 'passkey':        return t('onboarding.step.passkey')
    case 'create-account': return t('onboarding.step.create_account')
    case 'backup':         return t('onboarding.step.backup')
    case 'confirm':        return t('onboarding.step.confirm')
  }
}

export default function Onboarding() {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()
  // Initial step: the gifted-access 'welcome' splash when arriving with a plausible
  // invite code, otherwise straight to 'username' (X-signup / code-entry paths).
  const [state, setState] = useState<OnboardingState>(() => ({
    ...INITIAL_STATE,
    step: isPlausibleCodeFormat(new URLSearchParams(window.location.search).get('code'))
      ? 'welcome'
      : 'username',
  }))

  // Passkey capability gate, evaluated once on mount. Population-B onboarding
  // REQUIRES creating a WebAuthn passkey at the 'passkey' step; an iOS in-app
  // webview (Telegram/IG/etc.) or a browser with no platform authenticator
  // simply can't do it. Detecting that up-front lets us warn the user on the
  // FIRST screen ("you've been invited") and disable the "Choose your username"
  // CTA, instead of letting them fill in name + vault and hit a dead wall at
  // step 3 with an opaque WebAuthn error.
  const [passkeyGate, setPasskeyGate] = useState<{ blocked: boolean; messageKey: string | null }>(
    { blocked: false, messageKey: null },
  )
  useEffect(() => {
    let cancelled = false
    evaluatePasskeyGate().then(g => {
      if (!cancelled) setPasskeyGate({ blocked: g.blocked, messageKey: g.messageKey })
    }).catch(() => { /* probe failed — don't block on an error */ })
    return () => { cancelled = true }
  }, [])

  // Private/incognito windows AND in-app webviews can't keep the user logged
  // in — the session, Quick Sign key, and passkey backup all need persistent
  // storage that those contexts wipe or partition away. We CAN'T reliably
  // detect iOS Safari private mode (Apple closed every probe), so the advisory
  // below is always shown; the probe only drives a stronger, detected warning
  // (and the temporary on-device debug readout).
  const [privateProbe, setPrivateProbe] = useState<PrivateProbe | null>(null)
  useEffect(() => {
    let cancelled = false
    probePrivateWindow().then(p => {
      if (!cancelled) setPrivateProbe(p)
    }).catch(() => { /* detection is best-effort — never block on an error */ })
    return () => { cancelled = true }
  }, [])
  const setSession = useAuthStore(s => s.setSession)
  // True while the post-mint /api/auth/verify sign-in is in flight (shown on
  // the confirm step so "Go to feed" waits for the session).
  const [signingIn, setSigningIn] = useState(false)

  // Latest enrolled-passkey, mirrored into a ref so handleBootstrapDone (a
  // useCallback deliberately closed over the INITIAL state to keep its identity
  // stable — see the result.username note) can read the up-to-date credentialId
  // when it persists per-account passkey identity at mint-complete.
  const enrolledPasskeyRef = useRef<PasskeyPubkey | null>(null)
  useEffect(() => { enrolledPasskeyRef.current = state.enrolledPasskey }, [state.enrolledPasskey])

  // Invite-code gate.
  const [searchParams] = useSearchParams()
  const rawCode = searchParams.get('code')
  const normalizedCode = useMemo(
    () => (rawCode ? normalizeCode(rawCode) : ''),
    [rawCode],
  )
  const codeValid = isPlausibleCodeFormat(rawCode)

  // Open X-signup gate: an alternative to an invite code. Anyone who verifies a
  // qualifying X account (age >90d or verified) gets a free sponsored mint. The
  // FE reaches here via /onboarding?signup=x (the "create with X" CTA) or by
  // landing without a code. On success we hold the X-qualified token and thread
  // it into bootstrapNewUser instead of a code.
  const xSignup = useXSignupVerification()
  const [xQualifiedToken, setXQualifiedToken] = useState<string | null>(null)
  useEffect(() => {
    const r = xSignup.result
    if (r?.ok && r.qualified && r.token) setXQualifiedToken(r.token)
  }, [xSignup.result])

  // Ungated free-signup (#229): when the operator enables it (mirrors the
  // server's SPONSOR_UNGATED_ENABLED), a user with no invite code and no X
  // verification can still create a free, zero-deposit profile. The wall offers
  // it as an explicit choice; choosing it lets the user past the gate, and the
  // create step sends no code / no X token / zero deposit (already the default
  // when neither gift source is present).
  const ungatedEnabled = import.meta.env.VITE_SPONSOR_UNGATED_ENABLED === 'true'
  const [ungatedChosen, setUngatedChosen] = useState(false)

  // ── Gift code fetch ────────────────────────────────────────────────────────
  // Fetched once on mount (when the code passes the loose format check).
  // While loading, giftInfo is null — UsernameStep disables Next.
  const [giftInfo, setGiftInfo] = useState<SponsorCodeInfo | null>(null)
  const [giftLoading, setGiftLoading] = useState(false)

  // Quick Sign config — the SAME card as /usernames/new (QuickSignCard),
  // rendered in the username step. Defaults mirror New.tsx. The user can tweak
  // spend limit / tip-per-action / expiry here; the chosen values are threaded
  // into registerSponsoredSession at post-mint auto-derive time (below) so the
  // session honours them instead of silent defaults.
  const [quickSignEnabled, setQuickSignEnabled] = useState(true)
  const [quickSignExpanded, setQuickSignExpanded] = useState(true)
  const [qsSpendLimit, setQsSpendLimit] = useState<bigint>(() => getDefaultSpendLimit())
  const [qsDuration, setQsDuration] = useState<number>(DEFAULT_SESSION_DURATION)
  const [qsTipCeiling, setQsTipCeiling] = useState<bigint>(() => getDefaultTipCeiling(getTipTiers().fast))
  const [qsTipCeilingTouched, setQsTipCeilingTouched] = useState(false)
  const [qsWalletProtect, setQsWalletProtect] = useState(false)
  const cawPriceUsd = usePriceStore(s => s.priceMap['a-hunters-dream']) as number | undefined
  const { tipCeilingCaw: networkTipCaw, tipCeilingFallbackCaw } = useNetworkTipTargetAsCAW()

  // Re-peg the default tip ceiling to the Network's USD-denominated target once
  // loaded (tracks CAW price), unless the user has manually picked a tip value.
  useEffect(() => {
    if (qsTipCeilingTouched) return
    const networkDefault = networkTipCaw ?? tipCeilingFallbackCaw
    setQsTipCeiling(networkDefault)
  }, [networkTipCaw, tipCeilingFallbackCaw, qsTipCeilingTouched])

  useEffect(() => {
    if (!codeValid || !normalizedCode) return
    let cancelled = false
    setGiftLoading(true)
    apiFetch<{
      valid: boolean
      reason?: 'used' | 'expired' | 'invalid'
      giftCaw?: string
      gasCaw?: string
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
            gasCaw: json.gasCaw ? BigInt(json.gasCaw) : 0n,
            minUsernameLength: json.minUsernameLength,
            expiresAt: json.expiresAt,
            repayBps: json.repayBps ?? 0,
            sponsorTokenId: json.sponsorTokenId ?? 0,
          })
        } else {
          // Invalid — carry the server's reason so the stub can show "already
          // used" / "expired" instead of the generic X-signup gate.
          setGiftInfo({ valid: false, reason: json.reason ?? 'invalid' })
        }
      })
      .catch(() => {
        if (!cancelled) setGiftInfo({ valid: false, reason: 'invalid' })
      })
      .finally(() => {
        if (!cancelled) setGiftLoading(false)
      })
    return () => { cancelled = true }
  }, [codeValid, normalizedCode])

  // ── Derived deposit amount ─────────────────────────────────────────────────
  // giftCaw − (username burn) − (live redeem gas). Gas is charged at REDEEM, so
  // the preview subtracts the server-reported gasCaw too (server re-derives it
  // authoritatively at bootstrap). Computed fresh from giftInfo + live username.
  const derivedDepositAmount = useMemo((): bigint => {
    if (!giftInfo?.valid || !giftInfo.giftCaw) return 0n
    const burnCostWei = BigInt(cawCostForLength(state.username.length)) * 10n ** 18n
    // gasCaw arrives in WHOLE CAW (matches the server's redeemGasCostCaw()); the
    // server converts it to wei the same way (× 1e18) at bootstrap, so convert
    // here too to keep this preview byte-identical to the authoritative deduction.
    const gasWei = (giftInfo.gasCaw ?? 0n) * 10n ** 18n
    const remainder = giftInfo.giftCaw - burnCostWei - gasWei
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
    setState(s => ({ ...s, enrolledPasskey: passkey, step: 'create-account' }))
  }, [])

  // CreateAccountStep → stash the freshly-minted wallet and advance to the
  // recovery-file backup step. The post-mint sign-in does NOT fire here — it
  // runs in handleBootstrapDone after the user finishes (or skips) backup.
  const handleAccountCreated = useCallback((result: BootstrapResult) => {
    setState(s => ({ ...s, bootstrapResult: result, step: 'backup' }))
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

    // L2 DELEGATION (Pop-B): delegate the EOA → SmartEOA on L2 + enroll the
    // passkey, so the passkey ROOT signer can act on L2 (post/like/follow/withdraw)
    // WITHOUT a forced Quick Sign session. bootstrap() already signed the L2 auth
    // tuple (result.l2Delegation) while the secp256k1 key was in scope; we POST it.
    //
    // This is NOT fire-and-forget: a dropped L2 delegation leaves the EOA
    // delegated on L1 but NOT L2, which silently breaks passkey WITHDRAW forever
    // (withdraw is Quick-Sign-scope-excluded, so it MUST use the passkey ROOT
    // path, whose server ERC-1271 check runs on L2 — no L2 code ⇒ "Invalid
    // signature"). "Quick Sign covers the gap" is FALSE for withdraw. So we
    // retry on failure and confirm the tx actually landed (the server now awaits
    // the receipt). The signed auth tuple is single-use per nonce but re-POSTing
    // the same tuple is safe (idempotent: if already delegated the tx is a
    // no-op/cheap re-init). We await so the user can't reach withdraw before it
    // lands; a final failure is surfaced, not swallowed.
    if (result.l2Delegation) {
      const d = result.l2Delegation
      const submitDelegation = () => apiFetch('/api/sponsor/delegate-l2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passkeyPubkeyX: d.passkeyPubkeyX,
          passkeyPubkeyY: d.passkeyPubkeyY,
          ecdsaFallbackAddr: d.ecdsaFallbackAddr,
          authTupleNonce: d.authTupleNonce,
          authTupleSignature: d.authTupleSignature,
        }),
      })
      // Async IIFE (handleBootstrapDone is a sync useCallback): we don't block
      // the post-mint sign-in on this, but we DO retry once and surface a loud
      // error if it never lands — a dropped L2 delegation silently breaks
      // withdraw (see the comment above).
      void (async () => {
        try {
          await submitDelegation()
          console.log('[signin:diag] L2 delegation submitted for', d.ecdsaFallbackAddr)
        } catch (e) {
          console.warn('[signin:diag] L2 delegation attempt 1 failed, retrying once:', e)
          try {
            await submitDelegation()
            console.log('[signin:diag] L2 delegation succeeded on retry for', d.ecdsaFallbackAddr)
          } catch (e2) {
            console.error('[signin:diag] L2 delegation FAILED after retry — withdraw will not work until re-delegated:', e2)
          }
        }
      })()
    }

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
        // The sponsor server reactively pokes the indexer with the minted
        // tokenId, so the row usually lands within a second. But if that poke
        // ever misses (Redis blip), fall back to a budget that outlasts a full
        // NftTransferWatcher poll cycle (~60s) instead of the ~25s default —
        // otherwise we'd bounce the user to /welcome for a mint that's fine.
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
          }),
          { maxAttempts: 8, maxDelayMs: 12_000 }
        )
        // eslint-disable-next-line no-console
        console.log('[signin:diag] verify SUCCESS, setting session', {
          tokenIds: data?.authorizedTokenIds,
          addresses: data?.authorizedAddresses,
        })
        // If the user already had a session (e.g. they're onboarding a SECOND
        // passkey account while account #1 is still authorized), MERGE rather
        // than replace — otherwise account #1 loses its UI authorization the
        // moment account #2 lands. The server already accumulates token ids on
        // the shared session cookie (auth.ts addAuthorization), so the new
        // session token is the same; we just mirror that additive behavior
        // client-side. Only on a fresh login (no prior session) do we replace.
        // Mirrors the DM-register merge branch below.
        {
          const prevSession = useAuthStore.getState().sessionToken
          if (prevSession && data.sessionToken === prevSession) {
            useAuthStore.getState().addAuthorization(
              data.authorizedTokenIds,
              data.authorizedAddresses,
            )
          } else {
            setSession(
              data.sessionToken,
              data.authorizedTokenIds,
              data.authorizedAddresses,
              data.expiresAt,
            )
          }
        }

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
            // Build the active TokenData from data WE ALREADY HOLD — do NOT round-
            // trip /api/users/by-token. That row may not be indexed yet on a fresh
            // mint, and the OLD code only set the active token if that fetch
            // returned a username; when it lagged, the active token was never set,
            // so AuthGate (which gates purely on useActiveToken()?.username) bounced
            // the user to /welcome right after a successful mint (#209). The
            // username is exactly what the user just typed (state.username), and the
            // owner is result.ecdsaAddress — no fetch needed. On-chain bigints are
            // 0n for a fresh mint; the periodic on-chain refresh fills them in once
            // the deposit confirms. (Real bigints, not undefined, so components doing
            // `activeToken.stakedAmount > 0n` don't throw "Cannot mix BigInt".)
            {
              const ownerAddr = result.ecdsaAddress as `0x${string}`
              // Use result.username (the value bootstrap actually minted), NOT
              // state.username — this handler is a useCallback closed over a STALE
              // `state` whose username is still '' from initial render, which
              // navigated to /welcome/ (empty) → /home → splash (#209 regression).
              const mintedUsername = result.username
              const token: TokenData = {
                tokenId: mintedTokenId,
                username: mintedUsername,
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

              // Persist per-account passkey identity now that the tokenId exists:
              // credential keyed by tokenId, passkey marker keyed by owner address.
              // The credentialId was captured at enroll (PasskeyStep) and carried
              // in onboarding state; this is the first point the real tokenId is
              // known. Read from the ref, not the stale closed-over state. See
              // passkeyStorage.ts for why these are per-account.
              const enrolledCredentialId = enrolledPasskeyRef.current?.credentialId
              if (enrolledCredentialId) {
                persistPasskeyIdentity(mintedTokenId, ownerAddr, enrolledCredentialId)
              }

              // Prime the DM key cache for this device using the recovery key
              // that is still in memory right now (inside result.signVerifyMessage
              // closure). This means the first /messages visit on THIS device will
              // cache-hit deriveKeyPair and require NO signature — no backup file,
              // no vault-password prompt, just the passkey gating the session.
              // Fire-and-forget: cache miss → user sees the vault-password prompt
              // on new devices (expected); a failure here is never fatal.
              void (() => {
                try {
                  // result.signVerifyMessage already wraps the recovery key via
                  // `viem privateKeyToAccount(...).signMessage`. We need a signer
                  // that accepts (message: string) → Promise<string> with a 0x sig.
                  // Re-derive the viem account the same way bootstrap.ts does —
                  // keypair.privateKey is NOT exposed in BootstrapResult, but
                  // result.ecdsaAddress lets us verify it resolves correctly.
                  // We use result.signVerifyMessage as the sign function: it already
                  // signs with the secp256k1 recovery key, which is what deriveKeyPair
                  // needs. The returned sig is 0x-prefixed hex — matching DmCryptoService's
                  // hexToBytes(signature) expectation.
                  const dmSignMessage = (msg: string): Promise<string> =>
                    result.signVerifyMessage(msg).then(sig => sig as string)
                  deriveKeyPair(dmSignMessage, mintedTokenId, mintedUsername)
                    .then(async ({ publicKeyHex, rawSignature, sigMessage }) => {
                      console.log('[onboarding:dm] DM key cache primed for tokenId', mintedTokenId)
                      // PRIMARY FIX: also REGISTER the DM identity with the server
                      // now that the recovery key is still in memory. This means
                      // the welcome stepper's useDmIdentity poll will find
                      // hasIdentity:true immediately and auto-mark the DMs step
                      // complete — no tap, no vault-password prompt for a user who
                      // just finished onboarding on this device.
                      //
                      // rawSignature / sigMessage come from deriveKeyPair when it
                      // had to call signMessage (fresh derive, not a cache restore).
                      // They may be absent on a cache-hit — in that case we have
                      // no signer material here, so fall through silently (the
                      // stepper secondary fix covers that path).
                      if (!rawSignature || !sigMessage) {
                        console.log('[onboarding:dm] Cache hit during prime — skipping server registration (stepper will handle if needed)')
                        return
                      }
                      try {
                        const currentSession = useAuthStore.getState().sessionToken
                        const data = await retryOnIndexing(() =>
                          apiFetch<{
                            sessionToken: string
                            authorizedTokenIds: number[]
                            authorizedAddresses: string[]
                            expiresAt: number
                          }>('/api/auth/verify-dm', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              signature: rawSignature,
                              message: sigMessage,
                              userId: mintedTokenId,
                              publicKey: publicKeyHex,
                            }),
                          })
                        )
                        // Update auth store — same merge logic as useDm initializeClient
                        if (currentSession && data.sessionToken === currentSession) {
                          useAuthStore.getState().addAuthorization(data.authorizedTokenIds, data.authorizedAddresses)
                        } else {
                          useAuthStore.getState().setSession(
                            data.sessionToken,
                            data.authorizedTokenIds,
                            data.authorizedAddresses,
                            data.expiresAt,
                          )
                        }
                        console.log('[onboarding:dm] DM identity registered with server for tokenId', mintedTokenId)
                      } catch (regErr) {
                        // Non-fatal: stepper secondary fix (vault-password prompt)
                        // covers the fallback if server registration fails here.
                        console.warn('[onboarding:dm] DM server registration failed (non-fatal):', regErr)
                      }
                    })
                    .catch(err => console.warn('[onboarding:dm] DM key cache prime failed (non-fatal):', err))
                } catch (err) {
                  console.warn('[onboarding:dm] DM key cache prime failed (non-fatal):', err)
                }
              })()

              // Seed the OPTIMISTIC pending-deposit hint for the gifted deposit.
              // The sponsored bootstrap already deposited derivedDepositAmount CAW
              // (LZ-in-flight to L2), but the on-chain stake reads 0 for a minute
              // or two. Without this hint the post-mint stepper shows the empty
              // DEPOSIT form (nonsense for a gifted user) and treats stake as
              // incomplete ("0 staked") until the chain refresh lands. The stepper
              // + ProfileChooser read `caw:pendingDeposit:<tokenId>` and credit it
              // against the stake gates immediately (depositPending → skip the
              // deposit step, treat as staked, queue actions optimistically). Same
              // key/shape New.tsx writes for the wallet-mint path; baseline 0 is
              // correct (the tokenId didn't exist on L2 before this mint).
              // [pendingDeposit:diag] Did we write the hint, and for what token/
              // amount? If derivedDepositAmount is 0 here (gift − burn − gas ≈ 0,
              // or giftInfo failed to load) the hint is skipped and the gifted
              // user hits "insufficient CAW". Compare mintedTokenId here with the
              // activeTokenId the gate logs at action time.
              // Use the deposit amount the bootstrap ACTUALLY signed + sent
              // (result.depositAmountCAW), NOT the re-derived derivedDepositAmount
              // — the latter reads 0 once giftInfo has gone stale in this later
              // render, which is exactly what skipped the hint and left a gifted
              // user staring at "0 staked / insufficient" through the L2 index lag.
              // We KNOW the gift was deposited (the receipt confirmed it), so be
              // optimistic: write the hint so the stake gates credit it instantly
              // and reconcile against chain in the background.
              const hintAmount = result.depositAmountCAW
              console.log('[pendingDeposit:diag] onboarding hint write', {
                mintedTokenId,
                hintAmount: hintAmount.toString(),
                derivedDepositAmount: derivedDepositAmount.toString(),
                willWriteHint: mintedTokenId != null && hintAmount > 0n,
                giftCaw: giftInfo?.giftCaw?.toString(),
              })
              if (mintedTokenId != null && hintAmount > 0n) {
                try {
                  localStorage.setItem(
                    `caw:pendingDeposit:${mintedTokenId}`,
                    JSON.stringify({
                      amount: hintAmount.toString(),
                      txHash: result.txHash,
                      at: Date.now(),
                      stakedAtHintTime: '0',
                    }),
                  )
                  window.dispatchEvent(
                    new CustomEvent('caw:pendingDepositChanged', { detail: { tokenId: mintedTokenId } }),
                  )
                } catch { /* localStorage unavailable — stepper falls back to chain reads */ }
              }
              // eslint-disable-next-line no-console
              console.log('[signin:diag] active profile set (from in-hand data), navigating', {
                username: token.username,
                tokenId: mintedTokenId,
                pendingDeposit: derivedDepositAmount.toString(),
              })

              // Phase 3: auto-derive a Quick Sign session using the ecdsaFallback
              // key still in memory (the signVerifyMessage closure signs a 65-byte
              // ECDSA personal_sign that registerSessionPersonal validates). After
              // it lands the user can post without a separate Quick Sign ceremony,
              // and the stepper shows Quick Sign as done.
              //
              // FIRE-AND-FORGET — do NOT await before navigating. registerSponsored-
              // Session polls the on-chain session tx for up to ~240s; awaiting it
              // here would freeze the user on "Signing you in…" for minutes before
              // they reach the stepper. The session store is GLOBAL (not route-
              // scoped) and registerSponsoredSession persists + setEnabled(true) on
              // success, so the session activates correctly even though it resolves
              // after navigation. The signVerifyMessage closure keeps the key alive
              // for the duration. Non-fatal: on failure the user enables Quick Sign
              // manually on the stepper. Honours the QuickSignCard params the user
              // chose; skipped entirely if they toggled Quick Sign OFF.
              if (quickSignEnabled) {
                // eslint-disable-next-line no-console
                console.log('[signin:diag] auto-deriving Quick Sign session (background)…')
                void registerSponsoredSession({
                  signMessage: result.signVerifyMessage,
                  ownerAddress: ownerAddr,
                  spendLimit: qsSpendLimit,
                  durationSeconds: qsDuration,
                  tipCeiling: qsTipCeiling,
                  cawPrice: cawPriceUsd,
                })
                  // eslint-disable-next-line no-console
                  .then(() => console.log('[signin:diag] Quick Sign session registered + persisted'))
                  .catch(sessErr =>
                    // eslint-disable-next-line no-console
                    console.warn('[signin:diag] auto session register failed (non-fatal):', sessErr),
                  )
              } else {
                // eslint-disable-next-line no-console
                console.log('[signin:diag] Quick Sign disabled by user — skipping session derive')
              }

              // Land on the post-mint onboarding stepper (signed in), NOT the
              // feed — same destination as the non-sponsored mint (New.tsx) and
              // OnboardingGuard. The stepper walks the user through deposit /
              // Quick Sign / follow before they hit the feed.
              //
              // CRITICAL: pass mintedTokenId in location.state, exactly like
              // New.tsx does. WelcomePage's fresh-mint fast-path keys off
              // location.state.mintedTokenId — without it, freshMintTokenId is
              // undefined, the page falls into the slow indexer-dependent branch,
              // and on any /ensure miss/timeout it navigate('/home') → AuthGate →
              // the captive splash (the "signed me out" symptom). The bigint
              // store-set above can also lose a rehydration race; the state hand-
              // off doesn't. (Sponsored bootstrap already deposited, so no
              // separate pendingDeposit hint is needed.)
              navigate(`/welcome/${mintedUsername}`, {
                replace: true,
                // pendingDeposit (the gifted amount) rides the nav state too —
                // WelcomePage forwards it to PostMintOnboarding as a prop, the
                // other input (besides the localStorage hint above) to
                // depositPending. Both set → the stepper skips the deposit step
                // and treats the gift as staked immediately.
                state: {
                  mintedTokenId,
                  pendingDeposit: derivedDepositAmount > 0n ? derivedDepositAmount.toString() : null,
                  // This is a GIFTED mint — the sponsor already deposited the
                  // gift (or it was fully consumed by burn+gas). Either way a
                  // passkey user has no wallet to deposit from, so the stepper
                  // must skip the deposit step regardless of the net amount.
                  // (pendingDeposit can be null when gift − burn − gas ≈ 0; this
                  // flag covers that case so they don't land on an empty Deposit
                  // form.)
                  giftedMint: true,
                  // We just kicked off the Quick Sign session register above
                  // (when quickSignEnabled). It resolves in the BACKGROUND
                  // (~seconds), so hasActiveSession reads false on the stepper's
                  // first render → it would land on the QS step and prompt, then
                  // auto-advance once the session lands (the 3s flash). Signal
                  // "QS already handled" so the stepper treats the QS step as
                  // complete from frame 1 and never prompts. False when the user
                  // toggled Quick Sign OFF — then they DO enable it manually.
                  quickSignPending: quickSignEnabled,
                },
              })
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
  // The flow is gated by EITHER a valid invite code OR a completed X-signup
  // verification (xQualifiedToken). Only block when neither is satisfied.
  const codeInvalid = !codeValid || (giftInfo !== null && !giftInfo.valid)
  // The flow is reachable via a valid invite code, a completed X verification,
  // OR (when enabled) the user explicitly opting into a free ungated signup.
  const gateBlocked = codeInvalid && !xQualifiedToken && !(ungatedEnabled && ungatedChosen)
  if (gateBlocked) {
    const xRejected = xSignup.result?.ok && xSignup.result.qualified === false
    const xRejectKey = xSignup.result?.reason === 'x_account_already_used'
      ? 'onboarding.x_gate.already_used'
      : 'onboarding.x_gate.not_qualified'
    return (
      <div
        className={`fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden ${outerBg}`}
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <BoidsBg isDark={isDark} />
        <div className="absolute top-3 right-3 z-[110]">
          <LanguageSwitcher />
        </div>
        <div className="relative z-10 px-4 py-8 min-h-screen flex items-center justify-center">
          <div className={`w-full max-w-md rounded-2xl border p-6 text-center ${
            isDark ? 'border-white/10 bg-black/60' : 'border-gray-200 bg-white/90'
          }`}>
            {/* A code WAS provided but is used/expired (not just absent/malformed):
                say so explicitly so the user understands their code is dead,
                rather than implying they never had a valid one. They can still
                fall through to X-signup / ungated below as an alternative. */}
            {codeValid && giftInfo?.valid === false && (giftInfo.reason === 'used' || giftInfo.reason === 'expired') && (
              <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-amber-300 bg-amber-50 text-amber-800'
              }`}>
                {giftInfo.reason === 'used'
                  ? t('onboarding.code.already_used')
                  : t('onboarding.code.expired')}
              </div>
            )}
            <h2 className={`text-xl font-bold mb-2 ${textPrimary}`}>
              {t('onboarding.x_gate.title')}
            </h2>
            <p className={`text-sm ${textFaint}`}>
              {t('onboarding.x_gate.body')}
            </p>

            {xRejected && (
              <p className="mt-3 text-sm text-red-500">{t(xRejectKey)}</p>
            )}
            {xSignup.error && (
              <p className="mt-3 text-sm text-red-500">{t('onboarding.x_gate.error')}</p>
            )}

            <button
              onClick={() => xSignup.start()}
              disabled={xSignup.busy}
              className={`mt-5 w-full px-4 py-3 rounded-xl text-sm font-bold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                isDark ? 'bg-yellow-500 text-black hover:bg-yellow-400' : 'bg-yellow-500 text-black hover:bg-yellow-400'
              }`}
            >
              {xSignup.busy ? t('onboarding.x_gate.connecting') : t('onboarding.x_gate.cta')}
            </button>

            {/* Ungated free-signup option (#229) — only when the operator enabled
                it. Creates a free, zero-balance profile the user funds later. */}
            {ungatedEnabled && (
              <>
                <p className={`mt-4 text-xs ${textFaint}`}>{t('onboarding.x_gate.or_free')}</p>
                <button
                  onClick={() => setUngatedChosen(true)}
                  className={`mt-2 w-full px-4 py-3 rounded-xl text-sm font-semibold transition-colors cursor-pointer border ${
                    isDark
                      ? 'border-white/20 text-white hover:bg-white/10'
                      : 'border-gray-300 text-gray-900 hover:bg-black/5'
                  }`}
                >
                  {t('onboarding.x_gate.free_cta')}
                </button>
              </>
            )}

            <button
              onClick={() => navigate('/')}
              className={`mt-3 px-4 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer ${
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
    <div
      className={`fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden ${outerBg}`}
      style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
    >
      <BoidsBg isDark={isDark} />

      {/* Language picker — top-right, matches PostMintOnboarding */}
      <div className="absolute top-3 right-3 z-[110]">
        <LanguageSwitcher />
      </div>

      <div className="relative z-10 px-4 py-8 min-h-screen flex items-start justify-center">
        <div className="w-full max-w-[800px]">

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
          {state.step === 'welcome' && (
            <div className="max-w-[560px] mx-auto text-center pt-6">
              <img
                src={cawLogo}
                alt="CAW"
                className="w-20 h-20 mx-auto mb-6 drop-shadow-[0_0_24px_rgba(234,179,8,0.45)]"
              />
              <p className="text-yellow-500 text-sm font-semibold tracking-[0.2em] uppercase mb-3">
                {t('onboarding.welcome.kicker')}
              </p>
              <h1 className={`text-3xl sm:text-4xl font-bold mb-4 ${textPrimary}`}>
                {t('onboarding.welcome.title')}
              </h1>
              <p className={`text-base sm:text-lg mb-8 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                {t('onboarding.welcome.body')}
              </p>

              <div className={`rounded-xl border px-4 py-3 mb-8 text-sm whitespace-pre-line ${
                isDark ? 'border-yellow-500/25 bg-yellow-500/5 text-yellow-200/90' : 'border-yellow-300 bg-yellow-50 text-yellow-800'
              }`}>
                {t('onboarding.welcome.sponsored_note')}
              </div>

              {/* Persistence advisory. Private/incognito windows and in-app
                  webviews can't keep the user logged in, and iOS Safari private
                  mode is undetectable, so this is ALWAYS shown (advisory, never
                  a hard block). If a probe positively detects private mode we
                  upgrade to a stronger, red, "you are in one" message. */}
              <div className={`rounded-xl border px-4 py-3 mb-6 text-sm text-left ${
                privateProbe?.isPrivate
                  ? (isDark ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-red-300 bg-red-50 text-red-700')
                  : (isDark ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-amber-300 bg-amber-50 text-amber-800')
              }`}>
                {privateProbe?.isPrivate
                  ? t('onboarding.welcome.private_window_detected')
                  : t('onboarding.welcome.persistence_advisory')}
              </div>

              {/* TEMP on-device debug readout — remove once iOS private-mode
                  detection is confirmed/abandoned. Shows raw probe values so we
                  can see what an iOS private window actually reports. */}
              {privateProbe && (
                <div className={`rounded-lg px-3 py-2 mb-6 text-[11px] font-mono text-left break-all ${
                  isDark ? 'bg-white/5 text-white/50' : 'bg-gray-100 text-gray-500'
                }`}>
                  debug: private={String(privateProbe.isPrivate)} ls-broken={String(privateProbe.localStorageBroken)} idb-broken={String(privateProbe.indexedDbBroken)} quota={privateProbe.quotaMB == null ? 'n/a' : `${privateProbe.quotaMB}MB`} quota-private={String(privateProbe.quotaPrivate)}
                </div>
              )}

              {/* Passkey can't be created in this browser (iOS in-app webview /
                  no platform authenticator). Tell the user how to fix it HERE,
                  before they invest in picking a name, and disable the CTA. */}
              {passkeyGate.blocked && passkeyGate.messageKey && (
                <div className={`rounded-xl border px-4 py-3 mb-6 text-sm text-left ${
                  isDark ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-red-300 bg-red-50 text-red-700'
                }`}>
                  {t(passkeyGate.messageKey)}
                </div>
              )}

              <button
                onClick={() => setState(s => ({ ...s, step: 'username' }))}
                disabled={passkeyGate.blocked}
                className={`w-full sm:w-auto sm:min-w-[280px] py-3.5 px-8 rounded-full font-semibold text-base transition-colors ${
                  passkeyGate.blocked
                    ? isDark ? 'bg-white/10 text-white/40 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
                }`}
              >
                {t('onboarding.welcome.cta')}
              </button>
            </div>
          )}

          {state.step === 'username' && (
            <UsernameStep
              username={state.username}
              usernameAvailable={state.usernameAvailable}
              onUsernameChange={handleUsernameChange}
              onAvailabilityChange={handleAvailabilityChange}
              onNext={goNext}
              giftCaw={giftInfo?.valid ? giftInfo.giftCaw : undefined}
              gasCostCaw={giftInfo?.valid ? giftInfo.gasCaw : undefined}
              minUsernameLength={giftInfo?.valid ? giftInfo.minUsernameLength : undefined}
              giftLoading={giftLoading}
              cawPriceUsd={cawPriceUsd}
              quickSignEnabled={quickSignEnabled}
              onQuickSignEnabledChange={setQuickSignEnabled}
              quickSignExpanded={quickSignExpanded}
              onQuickSignExpandedChange={setQuickSignExpanded}
              qsSpendLimit={qsSpendLimit}
              onQsSpendLimitChange={setQsSpendLimit}
              qsDuration={qsDuration}
              onQsDurationChange={setQsDuration}
              qsTipCeiling={qsTipCeiling}
              onQsTipCeilingChange={(v: bigint) => { setQsTipCeilingTouched(true); setQsTipCeiling(v) }}
              qsWalletProtect={qsWalletProtect}
              onQsWalletProtectChange={setQsWalletProtect}
            />
          )}

          {/* Vault-password / passkey / backup steps are narrower than the
              stepper (which keeps the 800px column above): cap their content at
              600px and center it. */}
          {state.step === 'vault-password' && (
            <div className="max-w-[600px] mx-auto">
              <VaultPasswordStep
                vaultPassword={state.vaultPassword}
                vaultPasswordConfirm={state.vaultPasswordConfirm}
                onPasswordChange={handlePasswordChange}
                onConfirmChange={handleConfirmChange}
                onNext={goNext}
                onBack={goBack}
              />
            </div>
          )}

          {state.step === 'passkey' && (
            <div className="max-w-[600px] mx-auto">
              <PasskeyStep
                username={state.username}
                onNext={handlePasskeyEnrolled}
                onBack={goBack}
              />
            </div>
          )}

          {state.step === 'create-account' && state.enrolledPasskey && (
            <div className="max-w-[600px] mx-auto">
              <CreateAccountStep
                code={normalizedCode}
                xQualifiedToken={xQualifiedToken ?? undefined}
                username={state.username}
                depositAmount={derivedDepositAmount}
                repayAmount={derivedRepayAmount}
                sponsorTokenId={repaySponsorTokenId}
                vaultPassword={state.vaultPassword}
                passkey={state.enrolledPasskey}
                onCreated={handleAccountCreated}
                onUsernameTaken={handleUsernameTaken}
                onBack={goBack}
              />
            </div>
          )}

          {state.step === 'backup' && state.bootstrapResult && (
            <div className="max-w-[600px] mx-auto">
              <BackupStep
                bootstrapResult={state.bootstrapResult}
                username={state.username}
                onNext={handleBootstrapDone}
              />
            </div>
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
