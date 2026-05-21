/**
 * Recovery.tsx
 *
 * "Sign in with backup file" flow for Population B users who have lost their
 * device and need to sign in using their encrypted backup blob.
 *
 * State machine:
 *   file-select → password → success
 *
 * Security notes:
 *  - The decrypted private key is handed to RecoveryProvider which keeps it
 *    ONLY in React state — never written to any persistent storage.
 *  - On a wrong-password retry the file is NOT cleared (per
 *    feedback_human_vs_profile_scoped_credentials). The user needs to keep
 *    trying different passwords without having to re-upload the file.
 *  - On blob schema errors we tell the user immediately so they know the
 *    file is wrong before they waste time entering a password.
 */

import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { decryptBackupBlob, validateBackupBlobShape, type BackupBlob } from '~/services/identity/backupBlob'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { privateKeyToAccount } from 'viem/accounts'

// ─── State machine ────────────────────────────────────────────────────────────

type RecoveryStep = 'file-select' | 'password' | 'success'

// ─── Component ────────────────────────────────────────────────────────────────

export default function Recovery() {
  const t = useT()
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const recovery = useRecoveryContext()

  const [step, setStep] = useState<RecoveryStep>('file-select')
  const [blob, setBlob] = useState<BackupBlob | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [derivedAddress, setDerivedAddress] = useState<`0x${string}` | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Step 1: file select ──────────────────────────────────────────────────

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null)
    const file = e.target.files?.[0]
    if (!file) return

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

  // ── Step 2: password + decrypt ───────────────────────────────────────────

  const handleDecrypt = async () => {
    if (!blob || !password) return
    setError(null)
    setIsDecrypting(true)
    try {
      const privateKeyBytes = await decryptBackupBlob(blob, password)
      // Convert 32-byte Uint8Array → 0x-prefixed hex
      const hexKey = ('0x' + Array.from(privateKeyBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')) as `0x${string}`
      // Derive address for confirmation display
      const addr = privateKeyToAccount(hexKey).address
      setDerivedAddress(addr)
      recovery.setKey(hexKey)
      setStep('success')
    } catch (err: unknown) {
      // Both wrong-password and corrupted-blob come from decryptBackupBlob.
      // The library throws "Incorrect vault password or corrupted backup blob."
      // Map that to a user-facing string.
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

  // ── Step 3: success ──────────────────────────────────────────────────────

  const handleContinue = () => {
    navigate('/home')
  }

  // ── Styles ───────────────────────────────────────────────────────────────

  const textClass = isDark ? 'text-white' : 'text-black'
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const cardClass = isDark
    ? 'bg-white/5 border border-white/10'
    : 'bg-white border border-gray-200 shadow-sm'
  const inputClass = isDark
    ? 'bg-white/5 border border-white/20 text-white placeholder-white/30 focus:border-yellow-500'
    : 'bg-gray-50 border border-gray-300 text-gray-900 placeholder-gray-400 focus:border-yellow-500'

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center px-6 py-12 ${
      isDark ? 'bg-black' : 'bg-gray-50'
    }`}>
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
            <button
              onClick={() => fileInputRef.current?.click()}
              className={`w-full py-10 rounded-xl border-2 border-dashed flex flex-col items-center gap-3 transition-all cursor-pointer ${
                isDark
                  ? 'border-white/20 hover:border-yellow-500/50 hover:bg-yellow-500/5'
                  : 'border-gray-300 hover:border-yellow-500/50 hover:bg-yellow-50'
              }`}
            >
              <svg className={`w-8 h-8 ${mutedClass}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <span className={`text-sm font-medium ${textClass}`}>{t('recovery.file_select.cta')}</span>
              <span className={`text-xs ${mutedClass}`}>{t('recovery.file_select.hint')}</span>
            </button>
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
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handlePasswordKeyDown}
              placeholder={t('recovery.password.placeholder')}
              autoFocus
              className={`w-full px-4 py-3 rounded-xl text-sm outline-none transition-colors ${inputClass}`}
            />
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
              onClick={() => { setStep('file-select'); setPassword(''); setError(null) }}
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
            <button
              onClick={handleContinue}
              className="w-full py-3 rounded-xl font-bold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-all cursor-pointer"
            >
              {t('recovery.success.cta')}
            </button>
          </div>
        )}

        {/* Back to sign in */}
        {step !== 'success' && (
          <div className="mt-6 text-center">
            <button
              onClick={() => navigate('/welcome')}
              className={`text-sm transition-colors cursor-pointer ${
                isDark ? 'text-white/40 hover:text-white/70' : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {t('recovery.back_to_signin')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
