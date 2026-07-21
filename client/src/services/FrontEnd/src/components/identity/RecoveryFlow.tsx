/**
 * RecoveryFlow.tsx
 *
 * The "sign in with backup file" flow (file-select → password → success),
 * extracted from the /recovery page so it can render EITHER as a full page
 * (Recovery.tsx) OR inside a modal (RecoveryModal.tsx). The page keeps the
 * original full-navigation success behavior; the modal closes + hands control
 * back to the caller (which can open the passkey-setup dialog).
 *
 * Security notes (unchanged from the page):
 *  - The decrypted private key is handed to RecoveryProvider which keeps it ONLY
 *    in React state — never written to any persistent storage.
 *  - On a wrong-password retry the file is NOT cleared (the user keeps trying
 *    passwords without re-uploading — feedback_human_vs_profile_scoped_credentials).
 *  - Blob schema errors surface immediately so the user knows the file is wrong
 *    before entering a password.
 */

import { useRef, useState } from 'react'
import { readContract } from '@wagmi/core'
import { sepolia, baseSepolia } from 'wagmi/chains'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { decryptBackupBlob, validateBackupBlobShape, type BackupBlob } from '~/services/identity/backupBlob'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { wagmiConfig } from '~/config/wagmiConfig'
import { CAW_PROFILE_LENS_ADDRESS, CAW_NAMES_L2_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileLensAbi, cawProfileLedgerAbi } from '~/../../../abi/generated'
import type { TokenData } from '~/types'
import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

type RecoveryStep = 'file-select' | 'password' | 'success'

export interface RecoveryFlowProps {
  /**
   * Called once the recovered key is in memory AND the user has been fully
   * signed in (auth session established + tokens injected). `intent` says which
   * success CTA the user picked:
   *   - 'setup-passkey' → the primary "set up a passkey on this device" action
   *   - 'skip'          → the secondary "just take me in" action
   *   - 'rescue'        → the recovered key owns NO profile; go to Account
   *                       settings to recover any CAW/ETH the wallet still holds
   * Page variant navigates; modal variant closes + optionally opens the passkey
   * dialog. If omitted, the flow does nothing after sign-in (caller-less usage).
   */
  onSignedIn?: (intent: 'setup-passkey' | 'skip' | 'rescue') => void
  /**
   * Called when the user backs out BEFORE completing recovery (the modal's
   * "back to sign in" / close affordance). Page variant navigates to /welcome;
   * modal variant closes. Omit to hide the back affordance.
   */
  onBack?: () => void
  /** 'page' shows the full-height wrapper; 'modal' renders just the card. */
  variant?: 'page' | 'modal'
}

export default function RecoveryFlow({ onSignedIn, onBack, variant = 'page' }: RecoveryFlowProps) {
  const t = useT()
  const { isDark } = useTheme()
  const recovery = useRecoveryContext()
  const { verify } = useVerifyWallet()

  const [step, setStep] = useState<RecoveryStep>('file-select')
  const [blob, setBlob] = useState<BackupBlob | null>(null)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [derivedAddress, setDerivedAddress] = useState<`0x${string}` | null>(null)
  // Whether the recovered key owns a profile. null = not checked yet. Decides
  // the success-step UI: a profile → "set up a passkey" (sign in); no profile →
  // "recover funds" (the wallet was transferred out but may hold CAW/ETH). A
  // passkey only makes sense for a profile, so we must not offer it otherwise.
  const [ownsProfile, setOwnsProfile] = useState<boolean | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Step 1: file select ──────────────────────────────────────────────────

  // Shared file → blob parser used by BOTH the file picker and drag-and-drop.
  const processFile = (file: File) => {
    setError(null)
    const reader = new FileReader()
    reader.onload = (evt) => {
      const text = evt.target?.result
      if (typeof text !== 'string') {
        setError(t('recovery.error.not_valid_backup'))
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        setError(t('recovery.error.not_valid_backup'))
        return
      }
      if (!validateBackupBlobShape(parsed)) {
        setError(t('recovery.error.not_valid_backup'))
        return
      }
      setBlob(parsed as BackupBlob)
      setStep('password')
    }
    reader.onerror = () => {
      setError(t('recovery.error.not_valid_backup'))
    }
    reader.readAsText(file)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }

  // Drag-and-drop onto the drop zone. `isDragging` drives a highlight; the
  // window-level dragover/drop default must be prevented or the browser
  // navigates away to open the dropped file.
  const [isDragging, setIsDragging] = useState(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) processFile(file)
  }
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!isDragging) setIsDragging(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  // ── Step 2: password + decrypt ───────────────────────────────────────────

  const handleDecrypt = async () => {
    if (!blob || !password) return
    setError(null)
    setIsDecrypting(true)
    try {
      const privateKeyBytes = await decryptBackupBlob(blob, password)
      const hexKey = ('0x' + Array.from(privateKeyBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')) as `0x${string}`
      const addr = privateKeyToAccount(hexKey).address
      setDerivedAddress(addr)
      recovery.setKey(hexKey)
      setStep('success')
      // Determine profile ownership up front (fast on-chain read) so the success
      // step shows the RIGHT action — "set up a passkey" vs "recover funds" —
      // instead of always offering a passkey and then erroring for a profile-less
      // wallet. Best-effort: on read failure default to the profile path (the old
      // behavior), which self-corrects in handleContinue.
      setOwnsProfile(null)
      try {
        const raw = await readContract(wagmiConfig, {
          address: CAW_PROFILE_LENS_ADDRESS,
          chainId: sepolia.id,
          abi: cawProfileLensAbi,
          functionName: 'tokens',
          args: [addr],
        })
        setOwnsProfile(!!raw && raw.length > 0)
        if (!raw || raw.length === 0) {
          // Profile-less but key loaded → make the wallet reachable for rescue.
          useTokenDataStore.getState().setLastAddress(addr.toLowerCase())
        }
      } catch {
        setOwnsProfile(true) // read failed → assume profile; handleContinue re-checks
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('corrupted')) {
        setError(t('recovery.error.decrypt_failed'))
      } else {
        setError(t('recovery.error.wrong_password'))
      }
    } finally {
      setIsDecrypting(false)
    }
  }

  const handlePasswordKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void handleDecrypt()
  }

  // ── Step 3: success → full sign-in ─────────────────────────────────────────
  //
  // The recovered secp256k1 key is now in memory (RecoveryProvider). To actually
  // SIGN THE USER IN (so their profile shows up and is usable) we must:
  //   1. Establish an auth SESSION — useVerifyWallet().verify() signs a challenge
  //      with the recovered key and POSTs /api/auth/verify (JWT per owned token).
  //   2. FETCH + INJECT the owner's tokens (recovery is ADDRESS-scoped, the key
  //      may own several usernames): CawProfileLens.tokens(address) → tokenId list,
  //      then CawProfileLedger.getTokens([...]) for staked balance + cawonce.
  // AuthGate requires an active token with a username before /home, so this MUST
  // complete before we hand control back. The recovered key is only READ.
  // No-profile wallet: the key is loaded and lastAddress is set (at decrypt), so
  // the rescue card in Account settings can act on it. Just route there.
  const handleRescue = () => {
    if (recovery.address) useTokenDataStore.getState().setLastAddress(recovery.address.toLowerCase())
    onSignedIn?.('rescue')
  }

  const handleContinue = async (intent: 'setup-passkey' | 'skip') => {
    if (!recovery.address) { onSignedIn?.(intent); return }
    setError(null)
    setIsSigningIn(true)
    try {
      const owner = recovery.address
      // Profile ownership was already determined at decrypt (ownsProfile). Re-read
      // defensively (cheap) in case it was the read-failure fallback, and to get
      // the token rows we inject below.
      const rawTokens = await readContract(wagmiConfig, {
        address: CAW_PROFILE_LENS_ADDRESS,
        chainId: sepolia.id,
        abi: cawProfileLensAbi,
        functionName: 'tokens',
        args: [owner],
      })

      if (!rawTokens || rawTokens.length === 0) {
        // Defensive: the button for this case is "Recover funds", not this path —
        // but if we got here, route to rescue instead of hanging on verify().
        handleRescue()
        return
      }

      // Has a profile → establish an auth session.
      const ok = await verify()
      if (!ok) {
        setError(t('recovery.error.signin_failed'))
        return
      }

      let l2Rows: readonly { tokenId: bigint; cawBalance: bigint; nextCawonce: bigint }[] = []
      try {
        l2Rows = await readContract(wagmiConfig, {
          address: CAW_NAMES_L2_ADDRESS,
          chainId: baseSepolia.id,
          abi: cawProfileLedgerAbi,
          functionName: 'getTokens',
          args: [rawTokens.map(r => Number(r.tokenId))],
        }) as typeof l2Rows
      } catch { /* keep zeros */ }

      const tokens: TokenData[] = rawTokens.map(r => {
        const l2 = l2Rows.find(x => BigInt(x.tokenId) === BigInt(r.tokenId))
        return {
          tokenId: Number(r.tokenId),
          username: r.username,
          address: owner,
          owner: r.owner ?? owner,
          withdrawable: r.withdrawable ?? 0n,
          ownerBalance: r.ownerBalance ?? 0n,
          stakedAmount: l2?.cawBalance ?? 0n,
          cawonce: Number(l2?.nextCawonce ?? 0),
        }
      })

      const tds = useTokenDataStore.getState()
      tds.setTokensForAddress(owner as Address, tokens)
      tds.setActiveTokenIdForAddress(owner as Address, tokens[0].tokenId)
      tds.setLastAddress(owner.toLowerCase())

      onSignedIn?.(intent)
    } catch (e) {
      console.warn('[recovery] sign-in failed:', e)
      setError(t('recovery.error.signin_failed'))
    } finally {
      setIsSigningIn(false)
    }
  }

  // ── Styles ───────────────────────────────────────────────────────────────

  const textClass = isDark ? 'text-white' : 'text-black'
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  // The page variant floats the card over an opaque full-screen bg, so a
  // translucent card reads fine there. The modal variant floats over a
  // semi-transparent backdrop, so it needs an opaque card (matching our other
  // ModalWrapper modals: bg-black in dark / bg-white in light) or the content
  // behind the modal shows through.
  const cardClass = isDark
    ? variant === 'modal'
      ? 'bg-black border border-yellow-500/30'
      : 'bg-white/5 border border-white/10'
    : 'bg-white border border-gray-200 shadow-sm'
  const inputClass = isDark
    ? 'bg-white/5 border border-white/20 text-white placeholder-white/30 focus:border-yellow-500'
    : 'bg-gray-50 border border-gray-300 text-gray-900 placeholder-gray-400 focus:border-yellow-500'

  const card = (
    <div className={`w-full max-w-md rounded-2xl p-8 ${cardClass}`}>

      {/* Header */}
      <div className="text-center mb-8">
        <div className={`w-14 h-14 mx-auto mb-4 rounded-full flex items-center justify-center ${
          isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'
        }`}>
          <svg className="w-7 h-7 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
        <h1 className={`text-2xl font-bold mb-2 ${textClass}`}>
          {t('recovery.title')}
        </h1>
        <p className={`text-sm ${mutedClass}`}>
          {t('recovery.subtitle')}
        </p>
      </div>

      {/* Step: file-select */}
      {step === 'file-select' && (
        <div className="space-y-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`w-full py-10 rounded-xl border-2 border-dashed flex flex-col items-center gap-3 transition-all cursor-pointer ${
              isDragging
                ? (isDark ? 'border-yellow-500 bg-yellow-500/10' : 'border-yellow-500 bg-yellow-50')
                : isDark
                  ? 'border-white/20 hover:border-yellow-500/50 hover:bg-yellow-500/5'
                  : 'border-gray-300 hover:border-yellow-500/50 hover:bg-yellow-50'
            }`}
          >
            <svg className={`w-8 h-8 ${mutedClass}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <span className={`text-sm font-medium ${textClass}`}>{t('recovery.file_select.cta')}</span>
            <span className={`text-xs ${mutedClass}`}>{t('recovery.file_select.hint')}</span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
          {error && (
            <p className="text-sm text-red-500 text-center">{error}</p>
          )}
        </div>
      )}

      {/* Step: password */}
      {step === 'password' && blob && (
        <div className="space-y-4">
          <p className={`text-sm text-center ${mutedClass}`}>
            {blob.pubkeyAddress && (
              <span className="block mb-2 font-mono text-xs break-all">
                {blob.pubkeyAddress}
              </span>
            )}
            {t('recovery.password.prompt')}
          </p>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handlePasswordKeyDown}
              placeholder={t('recovery.password.placeholder')}
              autoFocus
              className={`w-full px-4 py-3 pr-11 rounded-xl text-sm outline-none transition-colors ${inputClass}`}
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              className={`absolute right-3 top-1/2 -translate-y-1/2 ${mutedClass} hover:opacity-80 cursor-pointer`}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )}
            </button>
          </div>
          {error && (
            <p className="text-sm text-red-500 text-center">{error}</p>
          )}
          <button
            onClick={() => void handleDecrypt()}
            disabled={!password || isDecrypting}
            className="w-full py-3 rounded-xl font-bold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {isDecrypting ? t('recovery.password.decrypting') : t('recovery.password.decrypt_cta')}
          </button>
          <button
            onClick={() => { setBlob(null); setPassword(''); setShowPassword(false); setError(null); setStep('file-select') }}
            className={`w-full py-2.5 text-sm rounded-xl transition-colors cursor-pointer ${
              isDark ? 'text-white/50 hover:text-white/80' : 'text-gray-400 hover:text-gray-700'
            }`}
          >
            {t('recovery.password.change_file')}
          </button>
        </div>
      )}

      {/* Step: success */}
      {step === 'success' && (
        <div className="space-y-6 text-center">
          <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center ${
            isDark ? 'bg-green-500/20' : 'bg-green-100'
          }`}>
            <svg className="w-7 h-7 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className={`font-semibold mb-1 ${textClass}`}>{t('recovery.success.heading')}</p>
            {derivedAddress && (
              <p className={`text-xs font-mono break-all ${mutedClass}`}>{derivedAddress}</p>
            )}
          </div>

          {ownsProfile === false ? (
            /* No profile → this wallet was transferred out. A passkey only makes
               sense for a profile, so DON'T offer "set up a passkey" — offer to
               recover any funds it still holds instead. */
            <>
              <p className={`text-sm ${mutedClass}`}>
                {t('recovery.no_profile.prompt')}
              </p>
              {error && <p className="text-sm text-red-500 text-center">{error}</p>}
              <button
                onClick={handleRescue}
                className="w-full py-3 rounded-xl font-bold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-all cursor-pointer"
              >
                {t('recovery.no_profile.recover_funds')}
              </button>
              {onBack && (
                <button
                  onClick={onBack}
                  className={`w-full py-2.5 text-sm rounded-xl transition-colors cursor-pointer ${
                    isDark ? 'text-white/50 hover:text-white/80' : 'text-gray-400 hover:text-gray-700'
                  }`}
                >
                  {t('recovery.no_profile.done')}
                </button>
              )}
            </>
          ) : (
            /* Has a profile (or ownership not yet resolved) → set up a passkey is
               the PRIMARY next action so the user doesn't need the file again. */
            <>
              <p className={`text-sm ${mutedClass}`}>
                {t('recovery.success.passkey_prompt')}
              </p>
              {error && <p className="text-sm text-red-500 text-center">{error}</p>}
              <button
                onClick={() => void handleContinue('setup-passkey')}
                disabled={isSigningIn || ownsProfile === null}
                className="w-full py-3 rounded-xl font-bold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSigningIn ? t('recovery.success.signing_in')
                  : ownsProfile === null ? t('recovery.success.checking')
                  : t('recovery.success.setup_passkey')}
              </button>
              <button
                onClick={() => void handleContinue('skip')}
                disabled={isSigningIn || ownsProfile === null}
                className={`w-full py-2.5 text-sm rounded-xl transition-colors cursor-pointer disabled:opacity-50 ${
                  isDark ? 'text-white/50 hover:text-white/80' : 'text-gray-400 hover:text-gray-700'
                }`}
              >
                {t('recovery.success.skip_to_feed')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Back to sign in — only before success, and only when a back handler exists. */}
      {step !== 'success' && onBack && (
        <div className="mt-6 text-center">
          <button
            onClick={onBack}
            className={`text-sm transition-colors cursor-pointer ${
              isDark ? 'text-white/40 hover:text-white/70' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {t('recovery.back_to_signin')}
          </button>
        </div>
      )}
    </div>
  )

  if (variant === 'modal') return card

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center px-6 py-12 ${
      isDark ? 'bg-black' : 'bg-gray-50'
    }`}>
      {card}
    </div>
  )
}
