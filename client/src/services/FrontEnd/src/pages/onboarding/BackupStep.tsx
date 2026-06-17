/**
 * BackupStep.tsx
 *
 * Step 6 of /onboarding — pure recovery-file backup of the wallet that was just
 * minted in CreateAccountStep (#236 split this out so create + backup are two
 * distinct steps). The on-chain account already exists by the time we get here;
 * this step never touches the chain.
 *
 *   Three explicit backup actions (download, email, host status-line).
 *   Continue / Skip-backup link with a warning modal if no user-chosen
 *   backup was completed.
 */

import { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { type BootstrapResult } from '~/services/identity/bootstrap'
import { downloadBackupBlob } from '~/services/identity/cloudBackup'
import { apiFetch } from '~/api/client'

export interface BackupStepProps {
  /** The wallet minted in CreateAccountStep — its encrypted backup blob is what
   *  we offer to download / email / host here. */
  bootstrapResult: BootstrapResult
  username: string
  onNext: (result: BootstrapResult) => void
}

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export default function BackupStep({
  bootstrapResult,
  username,
  onNext,
}: BackupStepProps) {
  const { isDark } = useTheme()
  const t = useT()

  // Backup-phase state
  const [didDownload, setDidDownload] = useState(false)
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailResult, setEmailResult] = useState<'sent' | 'sent_spam' | 'unavailable' | null>(null)
  const [didEmail, setDidEmail] = useState(false)

  // Host copy was stored automatically in CreateAccountStep before this step —
  // always-on status line. (BootstrapResult is required, so this is always true.)
  const didHost = true

  // Skip-warning modal
  const [showSkipWarning, setShowSkipWarning] = useState(false)

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  const emailFormatValid = recoveryEmail === '' || EMAIL_REGEX.test(recoveryEmail.trim())
  const canSendEmail = recoveryEmail.trim() !== '' && EMAIL_REGEX.test(recoveryEmail.trim()) && !emailSending && emailResult === null

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
                : isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed'
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
