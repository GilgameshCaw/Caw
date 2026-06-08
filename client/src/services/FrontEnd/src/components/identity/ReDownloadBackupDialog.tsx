/**
 * ReDownloadBackupDialog.tsx
 *
 * Lets a Population B user re-download their recovery backup file using:
 *   - The in-memory secp256k1 private key (held after sign-in) OR
 *   - An uploaded backup file + old vault password (if no in-memory key).
 *
 * Flow when in-memory key IS available:
 *   1. User enters a NEW vault password + confirmation.
 *   2. Click "Download new backup file" →
 *      a. encryptBackupBlob(inMemoryPrivateKey, newPassword, address)
 *      b. Download JSON file.
 *   3. Show success state.
 *
 * Flow when in-memory key is NOT available:
 *   Show a notice directing the user to sign in via /recovery first.
 *   The dialog cannot produce a new backup file without the in-memory
 *   key, so it blocks rather than silently producing a wrong result.
 *
 * The `inMemoryPrivateKey` prop is the raw 32-byte key from the
 * session state (never logged, never persisted). The parent is
 * responsible for passing it; this dialog does not read any store
 * directly (cleaner separation of concerns).
 */

import React, { useState, useCallback, useEffect } from 'react'
import { HiDownload, HiExclamation } from 'react-icons/hi'
import ModalWrapper from '~/components/modals/ModalWrapper'
import ModalHeader from '~/components/modals/ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { StrengthMeter, MIN_VAULT_PASSWORD_LENGTH } from './StrengthMeter'
import { encryptBackupBlob } from '~/services/identity/backupBlob'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReDownloadBackupDialogProps {
  open: boolean
  onClose: () => void

  /**
   * Raw 32-byte secp256k1 private key held in session memory.
   * If null, the dialog shows the Wave-4 placeholder notice.
   */
  inMemoryPrivateKey: Uint8Array | null

  /**
   * Ethereum address derived from the private key — shown to confirm
   * the user is downloading the right key.
   */
  ecdsaFallbackAddress?: `0x${string}`

  /** Used for the downloaded file name: caw-recovery-<username>.json */
  username?: string
}

// ─── Internal phase state ─────────────────────────────────────────────────────

type Phase =
  | { name: 'idle' }
  | { name: 'encrypting' }
  | { name: 'success' }
  | { name: 'error'; message: string }

// ─── Component ────────────────────────────────────────────────────────────────

export function ReDownloadBackupDialog({
  open,
  onClose,
  inMemoryPrivateKey,
  ecdsaFallbackAddress,
  username = 'user',
}: ReDownloadBackupDialogProps): JSX.Element {
  const { isDark } = useTheme()
  const t = useT()

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })

  // Reset form on open.
  useEffect(() => {
    if (!open) return
    setNewPassword('')
    setConfirmPassword('')
    setShowNew(false)
    setShowConfirm(false)
    setPhase({ name: 'idle' })
  }, [open])

  const isTooShort = newPassword.length > 0 && newPassword.length < MIN_VAULT_PASSWORD_LENGTH
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword
  const canDownload =
    !!inMemoryPrivateKey &&
    newPassword.length >= MIN_VAULT_PASSWORD_LENGTH &&
    newPassword === confirmPassword

  const handleDownload = useCallback(async () => {
    if (!canDownload || !inMemoryPrivateKey || phase.name !== 'idle') return
    setPhase({ name: 'encrypting' })

    try {
      // Derive address from the stored key — use ecdsaFallbackAddress if provided,
      // otherwise use a placeholder (the blob stores it for display only).
      const address: `0x${string}` = ecdsaFallbackAddress ?? '0x0000000000000000000000000000000000000000'

      const blob = await encryptBackupBlob(inMemoryPrivateKey, newPassword, address)
      const blobJson = JSON.stringify(blob, null, 2)

      downloadJsonFile(blobJson, `caw-recovery-${username}.json`)
      setPhase({ name: 'success' })
    } catch (err: unknown) {
      setPhase({
        name: 'error',
        message: err instanceof Error ? err.message : 'Encryption failed',
      })
    }
  }, [canDownload, inMemoryPrivateKey, newPassword, ecdsaFallbackAddress, username, phase])

  // ── Theme classes ──
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const inputBg = isDark
    ? 'bg-white/5 border-white/20 text-white placeholder-white/30 focus:border-yellow-500/60'
    : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:border-yellow-500'

  // ─────────────────────────────────────────────────────────────────────────
  // Render: no in-memory key — user must sign in via /recovery first
  // ─────────────────────────────────────────────────────────────────────────
  if (!inMemoryPrivateKey) {
    return (
      <ModalWrapper
        isOpen={open}
        onClose={onClose}
        maxWidth="max-w-sm"
        zIndex={80}
        usePortal
        backdropClass="bg-black/60"
      >
        <ModalHeader
          title={t('identity.redownload.title')}
          onClose={onClose}
          icon={<HiDownload className="w-5 h-5 text-yellow-500" />}
          iconBg="bg-yellow-500/20"
        />

        <div className="px-4 pb-5 space-y-4">
          <div
            className={`rounded-lg p-4 border ${
              isDark ? 'bg-yellow-900/20 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'
            }`}
            data-testid="no-key-notice"
          >
            <div className="flex gap-2">
              <HiExclamation className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
              <div>
                <p className={`text-sm font-medium ${isDark ? 'text-yellow-300' : 'text-yellow-800'}`}>
                  {t('identity.redownload.no_key_title')}
                </p>
                <p className={`text-sm mt-1 ${isDark ? 'text-yellow-400/70' : 'text-yellow-700'}`}>
                  {t('identity.redownload.no_key_body')}
                </p>
              </div>
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
  // Render: download form
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
        title={t('identity.redownload.title')}
        onClose={onClose}
        icon={<HiDownload className="w-5 h-5 text-yellow-500" />}
        iconBg="bg-yellow-500/20"
      />

      <div className="px-4 pb-5 space-y-4">
        {/* Description */}
        <p className={`text-sm ${mutedClass}`}>
          {t('identity.redownload.description')}
        </p>

        {/* Current fallback address */}
        {ecdsaFallbackAddress && (
          <div className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <p className={`text-xs font-medium mb-1 ${mutedClass}`}>
              {t('identity.redownload.address_label')}
            </p>
            <p className={`text-xs font-mono break-all ${strongClass}`}>
              {ecdsaFallbackAddress}
            </p>
          </div>
        )}

        {/* Success state */}
        {phase.name === 'success' && (
          <div
            className={`rounded-lg p-4 ${isDark ? 'bg-green-900/30 border border-green-500/30' : 'bg-green-50 border border-green-200'}`}
            data-testid="download-success"
          >
            <p className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-800'}`}>
              {t('identity.redownload.success_title')}
            </p>
            <p className={`text-xs mt-1 ${isDark ? 'text-green-400/70' : 'text-green-700'}`}>
              {t('identity.redownload.success_body')}
            </p>
          </div>
        )}

        {phase.name !== 'success' && (
          <>
            {/* New vault password */}
            <div className="space-y-1">
              <label className={`block text-sm font-medium ${strongClass}`}>
                {t('identity.redownload.new_password_label')}
              </label>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  data-testid="new-password-input"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder={t('identity.redownload.password_placeholder')}
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
                  {t('identity.redownload.min_length', { n: MIN_VAULT_PASSWORD_LENGTH })}
                </p>
              )}
            </div>

            {/* Confirm password */}
            <div className="space-y-1">
              <label className={`block text-sm font-medium ${strongClass}`}>
                {t('identity.redownload.confirm_label')}
              </label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  data-testid="confirm-password-input"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder={t('identity.redownload.confirm_placeholder')}
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
                  {t('identity.redownload.mismatch')}
                </p>
              )}
            </div>

            {/* Error */}
            {phase.name === 'error' && (
              <p
                role="alert"
                data-testid="download-error"
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
                disabled={phase.name === 'encrypting'}
                className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                  isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-testid="download-btn"
                onClick={handleDownload}
                disabled={!canDownload || phase.name === 'encrypting'}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <HiDownload className="w-4 h-4" />
                {phase.name === 'encrypting'
                  ? t('identity.redownload.encrypting')
                  : t('identity.redownload.download_btn')}
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

export default ReDownloadBackupDialog

// ─── File download helper ─────────────────────────────────────────────────────

function downloadJsonFile(jsonString: string, filename: string): void {
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
