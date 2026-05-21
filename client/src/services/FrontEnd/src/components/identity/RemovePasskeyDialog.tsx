/**
 * RemovePasskeyDialog.tsx
 *
 * Safety gate for the `removePasskey` contract call.
 *
 * When the user is about to remove their LAST enrolled passkey (N=1),
 * they must prove they can decrypt their vault backup before we hand
 * control to the parent's onConfirm callback. This prevents accidental
 * lockout via muscle memory — the contract correctly accepts N=1
 * self-removal, but the FE gate stops it without vault proof.
 *
 * When N>=2, a simpler confirm/cancel dialog is shown. The quorum
 * requirement (co-signer approval) is enforced at the contract layer.
 *
 * See plan-smart-eoa-passkey-sponsorship.md §1 Scenario D.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react'
import { HiKey, HiExclamation, HiLockClosed, HiUpload } from 'react-icons/hi'
import ModalWrapper from '~/components/modals/ModalWrapper'
import ModalHeader from '~/components/modals/ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

// ─── BackupBlob type ─────────────────────────────────────────────────────────
// TODO: replace with the canonical import once Step 4c's cloudBackup service
// is merged:
//   import type { BackupBlob } from '~/services/identity/cloudBackup'
//
// This stub must remain structurally compatible with the real BackupBlob
// (both need `encryptedKey: string` and `ecdsaFallbackAddress: string`).

export interface BackupBlob {
  /** Argon2id-encrypted secp256k1 private key (base64 or hex). */
  encryptedKey: string
  /** Ethereum address of the ecdsaFallback key encoded in this blob. */
  ecdsaFallbackAddress: string
  /** Opaque version tag for the encryption scheme, e.g. "argon2id-v1". */
  version?: string
  /** Any additional fields from Step 4c's real format are passed through. */
  [key: string]: unknown
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface RemovePasskeyDialogProps {
  open: boolean
  onClose: () => void
  /** Hash of the passkey being removed. Passed to the parent's onConfirm. */
  targetPasskeyHash: `0x${string}`
  /** Current count of enrolled passkeys (from on-chain read). */
  activePasskeyCount: number
  /** Address of the ecdsaFallback key stored in SmartEOA (from on-chain read). */
  ecdsaFallbackAddr: `0x${string}`
  /**
   * Vault-password verification callback supplied by the parent.
   * Implementation lives in Step 4c's identity service layer.
   *
   * Returns:
   *   valid           – password successfully decrypted the blob
   *   addressMatches  – decrypted key's address equals ecdsaFallbackAddr
   *
   * When this prop is omitted the N=1 path renders the form but the
   * Remove button stays disabled (safe-default for tests / Storybook).
   */
  verifyVaultPassword?: (
    password: string,
    blob: BackupBlob,
  ) => Promise<{ valid: boolean; addressMatches: boolean }>
  /**
   * Called after the user has satisfied all guards.
   *
   * unlocked=true  – user proved vault access (N=1 path)
   * unlocked=false – simple confirmation only (N>=2 path)
   */
  onConfirm: (params: { unlocked: boolean }) => Promise<void>
}

// ─── Internal state ───────────────────────────────────────────────────────────

type VerifyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'wrong_password' }
  | { status: 'wrong_address' }
  | { status: 'bad_json' }
  | { status: 'verified' }

// ─── Component ────────────────────────────────────────────────────────────────

export function RemovePasskeyDialog({
  open,
  onClose,
  activePasskeyCount,
  ecdsaFallbackAddr,
  verifyVaultPassword,
  onConfirm,
}: RemovePasskeyDialogProps): JSX.Element {
  const { isDark } = useTheme()
  const t = useT()

  const isLastPasskey = activePasskeyCount === 1

  // ── N=1 form state ──
  const [password, setPassword] = useState('')
  const [blob, setBlob] = useState<BackupBlob | null>(null)
  const [blobFileName, setBlobFileName] = useState<string | null>(null)
  const [verifyState, setVerifyState] = useState<VerifyState>({ status: 'idle' })
  const [isSubmitting, setIsSubmitting] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // Reset all N=1 form state each time the dialog opens fresh.
  // useEffect avoids calling setters during render (React strict-mode safe).
  useEffect(() => {
    if (!open) return
    setPassword('')
    setBlob(null)
    setBlobFileName(null)
    setVerifyState({ status: 'idle' })
    setIsSubmitting(false)
  }, [open])

  // ── File upload handler ──
  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      // Reset file input so re-uploading the same file fires onChange again
      e.target.value = ''

      setVerifyState({ status: 'idle' })
      setBlob(null)

      let parsed: unknown
      try {
        const text = await file.text()
        parsed = JSON.parse(text)
      } catch {
        setVerifyState({ status: 'bad_json' })
        return
      }

      // Minimal structural validation — Step 4c's real BackupBlob type may
      // add stricter checks when the import is unified.
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>)['encryptedKey'] !== 'string' ||
        typeof (parsed as Record<string, unknown>)['ecdsaFallbackAddress'] !== 'string'
      ) {
        setVerifyState({ status: 'bad_json' })
        return
      }

      setBlob(parsed as BackupBlob)
      setBlobFileName(file.name)
    },
    [],
  )

  // ── Vault verify + confirm (N=1 path) ──
  const handleVaultConfirm = useCallback(async () => {
    if (!blob || !password || !verifyVaultPassword || isSubmitting) return

    setVerifyState({ status: 'loading' })
    setIsSubmitting(true)

    try {
      const result = await verifyVaultPassword(password, blob)

      if (!result.valid) {
        setVerifyState({ status: 'wrong_password' })
        setIsSubmitting(false)
        return
      }

      if (!result.addressMatches) {
        setVerifyState({ status: 'wrong_address' })
        setIsSubmitting(false)
        return
      }

      setVerifyState({ status: 'verified' })
      await onConfirm({ unlocked: true })
      onClose()
    } catch {
      setVerifyState({ status: 'wrong_password' })
      setIsSubmitting(false)
    }
  }, [blob, password, verifyVaultPassword, isSubmitting, onConfirm, onClose])

  // ── Simple confirm (N>=2 path) ──
  const handleSimpleConfirm = useCallback(async () => {
    if (isSubmitting) return
    setIsSubmitting(true)
    try {
      await onConfirm({ unlocked: false })
      onClose()
    } finally {
      setIsSubmitting(false)
    }
  }, [isSubmitting, onConfirm, onClose])

  // ── Derived readiness ──
  const vaultReady =
    isLastPasskey &&
    blob !== null &&
    password.length > 0 &&
    !!verifyVaultPassword &&
    verifyState.status !== 'loading'

  // ── Theme-aware classes (no hardcoded text-white / border-white) ──
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass  = isDark ? 'text-white/60' : 'text-gray-500'
  const inputBg     = isDark ? 'bg-white/5 border-white/20 text-white placeholder-white/30 focus:border-yellow-500/60' : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:border-yellow-500'
  const subtleBg    = isDark ? 'bg-white/5' : 'bg-gray-50'

  // ─────────────────────────────────────────────────────────────────────────
  // Render: simple path (N>=2)
  // ─────────────────────────────────────────────────────────────────────────
  if (!isLastPasskey) {
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
          title={t('identity.remove_passkey.title')}
          onClose={onClose}
          icon={<HiKey className="w-5 h-5 text-yellow-500" />}
          iconBg="bg-yellow-500/20"
        />
        <div className="px-4 pb-5">
          <p className={`text-sm mb-5 ${mutedClass}`}>
            {t('identity.remove_passkey.confirm_description')}
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                isDark
                  ? 'bg-white/10 text-white hover:bg-white/20'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="simple-remove-btn"
              onClick={handleSimpleConfirm}
              disabled={isSubmitting}
              className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors cursor-pointer disabled:opacity-50"
            >
              {isSubmitting ? t('common.removing') : t('identity.remove_passkey.remove_btn')}
            </button>
          </div>
        </div>
      </ModalWrapper>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render: vault-confirmation path (N=1)
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
        title={t('identity.remove_passkey.last_key_title')}
        onClose={onClose}
        icon={<HiExclamation className="w-5 h-5 text-red-400" />}
        iconBg="bg-red-500/20"
      />

      <div className="px-4 pb-5 space-y-4">
        {/* Warning banner */}
        <div className={`rounded-lg p-3 flex gap-2 ${isDark ? 'bg-red-900/30 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
          <HiLockClosed className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isDark ? 'text-red-400' : 'text-red-600'}`} />
          <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-700'}`}>
            {t('identity.remove_passkey.last_key_warning')}
          </p>
        </div>

        {/* Recovery address info */}
        <div className={`rounded-lg p-3 ${subtleBg}`}>
          <p className={`text-xs font-medium mb-1 ${mutedClass}`}>
            {t('identity.remove_passkey.recovery_key_label')}
          </p>
          <p className={`text-xs font-mono break-all ${strongClass}`}>
            {ecdsaFallbackAddr}
          </p>
        </div>

        {/* Step 1: Upload backup file */}
        <div>
          <p className={`text-sm font-medium mb-2 ${strongClass}`}>
            {t('identity.remove_passkey.step1_label')}
          </p>
          <button
            type="button"
            data-testid="upload-backup-btn"
            onClick={() => fileInputRef.current?.click()}
            className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-colors cursor-pointer ${
              blob
                ? isDark
                  ? 'border-green-500/50 bg-green-900/20 text-green-400'
                  : 'border-green-500 bg-green-50 text-green-700'
                : isDark
                  ? 'border-white/20 bg-white/5 text-white/70 hover:bg-white/10'
                  : 'border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100'
            }`}
          >
            <HiUpload className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">
              {blob
                ? blobFileName ?? t('identity.remove_passkey.file_loaded')
                : t('identity.remove_passkey.upload_backup_btn')}
            </span>
          </button>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            data-testid="file-input"
            onChange={handleFileChange}
          />
        </div>

        {/* Step 2: Vault password */}
        <div>
          <label className={`block text-sm font-medium mb-2 ${strongClass}`}>
            {t('identity.remove_passkey.step2_label')}
          </label>
          <input
            type="password"
            data-testid="vault-password-input"
            value={password}
            onChange={e => {
              setPassword(e.target.value)
              // Clear stale error when user starts re-typing
              if (verifyState.status === 'wrong_password' || verifyState.status === 'wrong_address') {
                setVerifyState({ status: 'idle' })
              }
            }}
            placeholder={t('identity.remove_passkey.password_placeholder')}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={`w-full px-3 py-2.5 rounded-lg border text-sm outline-none transition-colors ${inputBg}`}
          />
        </div>

        {/* Inline error messages */}
        {verifyState.status === 'bad_json' && (
          <p
            role="alert"
            data-testid="error-bad-json"
            className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}
          >
            {t('identity.remove_passkey.error_bad_json')}
          </p>
        )}
        {verifyState.status === 'wrong_password' && (
          <p
            role="alert"
            data-testid="error-wrong-password"
            className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}
          >
            {t('identity.remove_passkey.error_wrong_password')}
          </p>
        )}
        {verifyState.status === 'wrong_address' && (
          <p
            role="alert"
            data-testid="error-wrong-address"
            className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}
          >
            {t('identity.remove_passkey.error_wrong_address')}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 ${
              isDark
                ? 'bg-white/10 text-white hover:bg-white/20'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-testid="vault-remove-btn"
            onClick={handleVaultConfirm}
            disabled={!vaultReady || isSubmitting}
            className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {verifyState.status === 'loading'
              ? t('identity.remove_passkey.verifying')
              : t('identity.remove_passkey.remove_btn')}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default RemovePasskeyDialog
