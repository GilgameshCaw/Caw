/**
 * RotateEcdsaFallbackDialog.tsx
 *
 * Allows a Population B user to rotate their secp256k1 ecdsaFallback key.
 *
 * Flow:
 *   1. User enters a NEW vault password + confirmation (with strength meter).
 *   2. User clicks "Rotate & Download" →
 *      a. Generate fresh secp256k1 keypair.
 *      b. Encrypt with new vault password → new BackupBlob.
 *      c. Build EIP-712 permit for SmartEOA.rotateEcdsaFallback(newPubkey).
 *      d. Sign with existing passkey via `onRotate` callback (parent handles
 *         the signing and contract call — keeps ABI out of the dialog).
 *      e. After tx confirmation, download the new backup blob.
 *
 * Sponsor note: SmartEOA.rotateEcdsaFallback is NOT covered by the v5
 * sponsor entry points (only mintAndDeposit, depositFor, authenticate are).
 * Population B users must therefore fund their own EOA with a small amount
 * of ETH to submit this tx directly. If `needsEthFunding` is true the dialog
 * shows the user's EOA address with a copy button and a clear warning.
 *
 * For Wave 3, the parent decides whether sponsoring is available. If it is,
 * `onRotate` abstracts the signing + submission. If not, the parent should
 * set `needsEthFunding: true` and the dialog informs the user.
 */

import React, { useState, useCallback, useEffect } from 'react'
import { HiRefresh, HiExclamation, HiClipboard, HiCheck } from 'react-icons/hi'
import ModalWrapper from '~/components/modals/ModalWrapper'
import ModalHeader from '~/components/modals/ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { StrengthMeter, MIN_VAULT_PASSWORD_LENGTH } from './StrengthMeter'
import { generateSecp256k1Keypair } from '~/services/identity/secp256k1Key'
import { encryptBackupBlob } from '~/services/identity/backupBlob'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RotateResult {
  /** Ethereum address of the new secp256k1 key (new ecdsaFallback address). */
  newEcdsaAddress: `0x${string}`
  /**
   * Encrypted BackupBlob JSON as a string — pass to the caller to download.
   * The dialog downloads it automatically after a successful rotation.
   */
  newBlobJson: string
}

export interface RotateEcdsaFallbackDialogProps {
  open: boolean
  onClose: () => void

  /** Current EOA address of the connected Population B wallet. */
  walletAddress: `0x${string}`

  /** Current ecdsaFallback address shown in the "you are rotating away from" hint. */
  currentFallbackAddress?: `0x${string}`

  /**
   * When true, the sponsor does not support this action and the user must
   * fund their EOA directly. The dialog shows a "Send ETH to <address>"
   * notice instead of the rotate form.
   *
   * If false (default), show the rotate form and use `onRotate` to submit.
   */
  needsEthFunding?: boolean

  /**
   * Callback that submits the rotateEcdsaFallback tx.
   * Receives the new secp256k1 address. Returns when the tx is confirmed.
   * The dialog downloads the new backup blob after this resolves.
   */
  onRotate: (newEcdsaAddress: `0x${string}`, newBlobJson: string) => Promise<void>

  /** Optional username for the downloaded file name. */
  username?: string
}

// ─── Internal phase state ─────────────────────────────────────────────────────

type Phase =
  | { name: 'idle' }
  | { name: 'submitting' }
  | { name: 'success' }
  | { name: 'error'; message: string }

// ─── Component ────────────────────────────────────────────────────────────────

export function RotateEcdsaFallbackDialog({
  open,
  onClose,
  walletAddress,
  currentFallbackAddress,
  needsEthFunding = false,
  onRotate,
  username = 'user',
}: RotateEcdsaFallbackDialogProps): JSX.Element {
  const { isDark } = useTheme()
  const t = useT()

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [copied, setCopied] = useState(false)

  // Reset on open.
  useEffect(() => {
    if (!open) return
    setNewPassword('')
    setConfirmPassword('')
    setShowNew(false)
    setShowConfirm(false)
    setPhase({ name: 'idle' })
    setCopied(false)
  }, [open])

  const isTooShort = newPassword.length > 0 && newPassword.length < MIN_VAULT_PASSWORD_LENGTH
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword
  const canRotate =
    !needsEthFunding &&
    newPassword.length >= MIN_VAULT_PASSWORD_LENGTH &&
    newPassword === confirmPassword &&
    phase.name === 'idle'

  const handleCopyAddress = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(walletAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access denied — ignore
    }
  }, [walletAddress])

  const handleRotate = useCallback(async () => {
    if (!canRotate) return
    setPhase({ name: 'submitting' })

    try {
      // Generate new keypair.
      const newKeypair = generateSecp256k1Keypair()

      // Encrypt under new vault password.
      const blob = await encryptBackupBlob(
        newKeypair.privateKey,
        newPassword,
        newKeypair.address,
      )
      const blobJson = JSON.stringify(blob, null, 2)

      // Call parent to submit the on-chain rotate tx.
      await onRotate(newKeypair.address, blobJson)

      // Auto-download the new backup blob.
      downloadBlobFile(blobJson, `caw-recovery-${username}.json`)

      setPhase({ name: 'success' })
    } catch (err: unknown) {
      setPhase({
        name: 'error',
        message: err instanceof Error ? err.message : 'Rotation failed',
      })
    }
  }, [canRotate, newPassword, onRotate, username])

  // ── Theme classes ──
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const inputBg = isDark
    ? 'bg-white/5 border-white/20 text-white placeholder-white/30 focus:border-yellow-500/60'
    : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:border-yellow-500'
  const subtleBg = isDark ? 'bg-white/5' : 'bg-gray-50'

  // ─────────────────────────────────────────────────────────────────────────
  // Render: needs ETH funding path
  // ─────────────────────────────────────────────────────────────────────────
  if (needsEthFunding) {
    return (
      <ModalWrapper
        isOpen={open}
        onClose={onClose}
        maxWidth="max-w-md"
        zIndex={80}
        usePortal
        backdropClass="bg-black/60"
      >
        <ModalHeader
          title={t('identity.rotate_fallback.title')}
          onClose={onClose}
          icon={<HiRefresh className="w-5 h-5 text-yellow-500" />}
          iconBg="bg-yellow-500/20"
        />

        <div className="px-4 pb-5 space-y-4">
          <div
            className={`rounded-lg p-4 border ${
              isDark ? 'bg-yellow-900/20 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'
            }`}
            data-testid="eth-funding-notice"
          >
            <p className={`text-sm font-medium mb-2 ${isDark ? 'text-yellow-300' : 'text-yellow-800'}`}>
              {t('identity.rotate_fallback.needs_eth_title')}
            </p>
            <p className={`text-sm mb-3 ${isDark ? 'text-yellow-400/70' : 'text-yellow-700'}`}>
              {t('identity.rotate_fallback.needs_eth_body')}
            </p>
            <div className={`rounded p-2 flex items-center gap-2 ${subtleBg}`}>
              <p className={`text-xs font-mono flex-1 break-all ${strongClass}`}>
                {walletAddress}
              </p>
              <button
                type="button"
                onClick={handleCopyAddress}
                data-testid="copy-address-btn"
                className={`flex-shrink-0 p-1.5 rounded transition-colors cursor-pointer ${
                  isDark ? 'text-white/60 hover:text-white hover:bg-white/10' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'
                }`}
                aria-label="Copy address"
              >
                {copied
                  ? <HiCheck className="w-4 h-4 text-green-500" />
                  : <HiClipboard className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className={`w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {t('common.close')}
          </button>
        </div>
      </ModalWrapper>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render: rotate form
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <ModalWrapper
      isOpen={open}
      onClose={onClose}
      maxWidth="max-w-md"
      zIndex={80}
      usePortal
      backdropClass="bg-black/60"
    >
      <ModalHeader
        title={t('identity.rotate_fallback.title')}
        onClose={onClose}
        icon={<HiRefresh className="w-5 h-5 text-yellow-500" />}
        iconBg="bg-yellow-500/20"
      />

      <div className="px-4 pb-5 space-y-4">

        {/* Big red warning */}
        <div className={`rounded-lg p-3 flex gap-2 ${
          isDark ? 'bg-red-900/30 border border-red-500/30' : 'bg-red-50 border border-red-200'
        }`}>
          <HiExclamation className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isDark ? 'text-red-400' : 'text-red-600'}`} />
          <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-700'}`}>
            {t('identity.rotate_fallback.warning')}
          </p>
        </div>

        {/* Current fallback address */}
        {currentFallbackAddress && (
          <div className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <p className={`text-xs font-medium mb-1 ${mutedClass}`}>
              {t('identity.rotate_fallback.current_label')}
            </p>
            <p className={`text-xs font-mono break-all ${strongClass}`}>
              {currentFallbackAddress}
            </p>
          </div>
        )}

        {/* Success state */}
        {phase.name === 'success' && (
          <div
            className={`rounded-lg p-4 ${isDark ? 'bg-green-900/30 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}
            data-testid="rotate-success"
          >
            <p className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-800'}`}>
              {t('identity.rotate_fallback.success_title')}
            </p>
            <p className={`text-xs mt-1 ${isDark ? 'text-green-400/70' : 'text-green-700'}`}>
              {t('identity.rotate_fallback.success_body')}
            </p>
          </div>
        )}

        {phase.name !== 'success' && (
          <>
            {/* New vault password */}
            <div className="space-y-1">
              <label className={`block text-sm font-medium ${strongClass}`}>
                {t('identity.rotate_fallback.new_password_label')}
              </label>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  data-testid="new-password-input"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder={t('identity.rotate_fallback.password_placeholder')}
                  autoComplete="new-password"
                  className={`w-full px-3 py-2.5 pr-10 rounded-lg border text-sm outline-none transition-colors ${inputBg}`}
                />
                <button
                  type="button"
                  onClick={() => setShowNew(v => !v)}
                  className={`absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer ${mutedClass}`}
                  aria-label={showNew ? 'Hide password' : 'Show password'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {showNew ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    ) : (
                      <>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
              <StrengthMeter password={newPassword} />
              {isTooShort && (
                <p className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                  {t('identity.rotate_fallback.min_length', { n: MIN_VAULT_PASSWORD_LENGTH })}
                </p>
              )}
            </div>

            {/* Confirm password */}
            <div className="space-y-1">
              <label className={`block text-sm font-medium ${strongClass}`}>
                {t('identity.rotate_fallback.confirm_label')}
              </label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  data-testid="confirm-password-input"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder={t('identity.rotate_fallback.confirm_placeholder')}
                  autoComplete="new-password"
                  className={`w-full px-3 py-2.5 pr-10 rounded-lg border text-sm outline-none transition-colors ${
                    mismatch ? 'border-red-500' : ''
                  } ${inputBg}`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(v => !v)}
                  className={`absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer ${mutedClass}`}
                  aria-label={showConfirm ? 'Hide confirm password' : 'Show confirm password'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {showConfirm ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    ) : (
                      <>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
              {mismatch && (
                <p className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`} role="alert">
                  {t('identity.rotate_fallback.mismatch')}
                </p>
              )}
            </div>

            {/* Error */}
            {phase.name === 'error' && (
              <p
                role="alert"
                data-testid="rotate-error"
                className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}
              >
                {phase.message}
              </p>
            )}

            {/* Buttons */}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={phase.name === 'submitting'}
                className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                  isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-testid="rotate-confirm-btn"
                onClick={handleRotate}
                disabled={!canRotate || phase.name === 'submitting'}
                className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {phase.name === 'submitting'
                  ? t('identity.rotate_fallback.submitting')
                  : t('identity.rotate_fallback.confirm_btn')}
              </button>
            </div>
          </>
        )}

        {phase.name === 'success' && (
          <button
            type="button"
            onClick={onClose}
            className={`w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {t('common.close')}
          </button>
        )}
      </div>
    </ModalWrapper>
  )
}

export default RotateEcdsaFallbackDialog

// ─── File download helper ─────────────────────────────────────────────────────

function downloadBlobFile(jsonString: string, filename: string): void {
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
