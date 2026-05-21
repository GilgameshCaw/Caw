/**
 * AddPasskeyDialog.tsx
 *
 * Two-phase passkey enrollment with a 24-hour timelock:
 *
 * Phase A — Propose: user clicks "Create passkey on this new device" →
 *   enrollPasskey() → submit SmartEOA.proposeAddPasskey(X, Y).
 *   After success the row appears in the pending list.
 *
 * Phase B — Finalize: shown separately in IdentitySection as a banner
 *   on any pending row whose proposedAt + 24h has elapsed.
 *   Calling SmartEOA.finalizeAddPasskey(pubkeyId) promotes it to enrolled.
 *
 * For Wave 3, the actual on-chain write for propose and finalize is
 * stubbed behind the `onPropose` / `onFinalize` callbacks — the parent
 * (IdentitySection) wires the real wagmi write. This keeps the dialog
 * decoupled from the ABI and contract address details.
 *
 * A "Cancel pending passkey" button removes a pending row by calling
 * SmartEOA.cancelPendingPasskey(pubkeyId) via the `onCancel` callback.
 */

import React, { useState, useCallback, useEffect } from 'react'
import { HiKey, HiClock, HiCheckCircle, HiExclamation } from 'react-icons/hi'
import ModalWrapper from '~/components/modals/ModalWrapper'
import ModalHeader from '~/components/modals/ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { enrollPasskey, type PasskeyPubkey } from '~/services/identity/passkey'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingPasskeyRow {
  /** keccak256(abi.encode(X, Y)) as 0x-hex */
  pubkeyId: `0x${string}`
  pubkeyX: `0x${string}`
  pubkeyY: `0x${string}`
  /** Unix timestamp (seconds) when the passkey was proposed on-chain. */
  proposedAt: number
}

export interface AddPasskeyDialogProps {
  open: boolean
  onClose: () => void

  /**
   * Existing pending passkeys read from SmartEOA.pendingPasskeys().
   * Parent supplies these so the dialog can show timelock status.
   */
  pendingPasskeys: PendingPasskeyRow[]

  /**
   * Called after enrollPasskey() succeeds. The parent should submit the
   * SmartEOA.proposeAddPasskey(X, Y) on-chain call and return the tx hash.
   */
  onPropose: (passkey: PasskeyPubkey) => Promise<{ txHash: string }>

  /**
   * Called when the user clicks "Finalize". Parent calls
   * SmartEOA.finalizeAddPasskey(pubkeyId) and resolves on confirmation.
   */
  onFinalize: (pubkeyId: `0x${string}`) => Promise<void>

  /**
   * Called when the user clicks "Cancel". Parent calls
   * SmartEOA.cancelPendingPasskey(pubkeyId) and resolves on confirmation.
   */
  onCancel: (pubkeyId: `0x${string}`) => Promise<void>

  /** rpId passed to enrollPasskey (defaults to window.location.hostname). */
  rpId?: string

  /** Username for the WebAuthn credential displayName. */
  username?: string
}

// ─── Timelock helpers ─────────────────────────────────────────────────────────

const TIMELOCK_SECONDS = 24 * 60 * 60 // 24 hours

function secondsUntilFinalizable(proposedAt: number): number {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return Math.max(0, proposedAt + TIMELOCK_SECONDS - nowSeconds)
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'Ready to finalize'
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `Available in ${hours}h ${mins}m`
  return `Available in ${mins}m`
}

// ─── Internal phase state ─────────────────────────────────────────────────────

type Phase =
  | { name: 'idle' }
  | { name: 'enrolling' }
  | { name: 'proposing'; passkey: PasskeyPubkey }
  | { name: 'proposed'; txHash: string }
  | { name: 'error'; message: string }

// ─── Component ────────────────────────────────────────────────────────────────

export function AddPasskeyDialog({
  open,
  onClose,
  pendingPasskeys,
  onPropose,
  onFinalize,
  onCancel,
  rpId,
  username = 'user',
}: AddPasskeyDialogProps): JSX.Element {
  const { isDark } = useTheme()
  const t = useT()

  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [finalizingId, setFinalizingId] = useState<`0x${string}` | null>(null)
  const [cancellingId, setCancellingId] = useState<`0x${string}` | null>(null)

  // Countdown ticker — refreshes every 60 seconds so the "Available in Nh Nm"
  // text stays reasonably fresh without hammering React.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open || pendingPasskeys.length === 0) return
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [open, pendingPasskeys.length])

  // Reset propose phase each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setPhase({ name: 'idle' })
    setFinalizingId(null)
    setCancellingId(null)
  }, [open])

  const handleEnrollAndPropose = useCallback(async () => {
    setPhase({ name: 'enrolling' })
    try {
      const effectiveRpId = rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social')
      const newPasskey = await enrollPasskey({
        rpId: effectiveRpId,
        userName: username,
        userDisplayName: username,
      })

      setPhase({ name: 'proposing', passkey: newPasskey })

      const { txHash } = await onPropose(newPasskey)
      setPhase({ name: 'proposed', txHash })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create passkey'
      // User cancellation from the browser passkey sheet is not an error worth showing.
      if (message.toLowerCase().includes('cancel') || message.toLowerCase().includes('abort')) {
        setPhase({ name: 'idle' })
        return
      }
      setPhase({ name: 'error', message })
    }
  }, [rpId, username, onPropose])

  const handleFinalize = useCallback(async (pubkeyId: `0x${string}`) => {
    setFinalizingId(pubkeyId)
    try {
      await onFinalize(pubkeyId)
      onClose()
    } catch (err: unknown) {
      setFinalizingId(null)
      setPhase({
        name: 'error',
        message: err instanceof Error ? err.message : 'Finalize failed',
      })
    }
  }, [onFinalize, onClose])

  const handleCancel = useCallback(async (pubkeyId: `0x${string}`) => {
    setCancellingId(pubkeyId)
    try {
      await onCancel(pubkeyId)
    } finally {
      setCancellingId(null)
    }
  }, [onCancel])

  // ── Theme classes ──
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const subtleBg = isDark ? 'bg-white/5' : 'bg-gray-50'
  const secondaryBtn = isDark
    ? 'bg-white/10 text-white hover:bg-white/20'
    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'

  const isProposing = phase.name === 'enrolling' || phase.name === 'proposing'

  // ─────────────────────────────────────────────────────────────────────────
  // Render
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
        title={t('identity.add_passkey.title')}
        onClose={onClose}
        icon={<HiKey className="w-5 h-5 text-yellow-500" />}
        iconBg="bg-yellow-500/20"
      />

      <div className="px-4 pb-5 space-y-4">

        {/* ── Pending passkeys list ── */}
        {pendingPasskeys.length > 0 && (
          <div className="space-y-2">
            <p className={`text-xs font-semibold uppercase tracking-wide ${mutedClass}`}>
              {t('identity.add_passkey.pending_label')}
            </p>
            {pendingPasskeys.map(row => {
              const remainSeconds = secondsUntilFinalizable(row.proposedAt)
              const canFinalize = remainSeconds === 0
              const isFinalizing = finalizingId === row.pubkeyId
              const isCancelling = cancellingId === row.pubkeyId
              const shortId = row.pubkeyId.slice(2, 10)

              return (
                <div
                  key={row.pubkeyId}
                  className={`rounded-lg p-3 ${subtleBg}`}
                  data-testid={`pending-passkey-${shortId}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={`text-xs font-mono truncate ${strongClass}`}>
                        {shortId}…
                      </p>
                      <div className="flex items-center gap-1 mt-1">
                        <HiClock className={`w-3 h-3 flex-shrink-0 ${
                          canFinalize
                            ? isDark ? 'text-green-400' : 'text-green-600'
                            : mutedClass
                        }`} />
                        <p
                          className={`text-xs ${
                            canFinalize
                              ? isDark ? 'text-green-400' : 'text-green-600'
                              : mutedClass
                          }`}
                          data-testid={`countdown-${shortId}`}
                        >
                          {formatCountdown(remainSeconds)}
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-2 flex-shrink-0">
                      {canFinalize && (
                        <button
                          type="button"
                          data-testid={`finalize-btn-${shortId}`}
                          onClick={() => handleFinalize(row.pubkeyId)}
                          disabled={isFinalizing}
                          className="text-xs px-2 py-1 rounded bg-yellow-500 text-black font-medium hover:bg-yellow-400 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {isFinalizing ? t('common.loading') : t('identity.add_passkey.finalize_btn')}
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid={`cancel-btn-${shortId}`}
                        onClick={() => handleCancel(row.pubkeyId)}
                        disabled={isCancelling}
                        className={`text-xs px-2 py-1 rounded transition-colors cursor-pointer disabled:opacity-50 ${
                          isDark
                            ? 'bg-white/10 text-white/70 hover:bg-white/20'
                            : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                        }`}
                      >
                        {isCancelling ? t('common.loading') : t('identity.add_passkey.cancel_btn')}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Propose new passkey ── */}
        {phase.name === 'idle' && (
          <div className="space-y-3">
            <p className={`text-sm ${mutedClass}`}>
              {t('identity.add_passkey.description')}
            </p>
            <button
              type="button"
              data-testid="propose-passkey-btn"
              onClick={handleEnrollAndPropose}
              className="w-full py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors cursor-pointer"
            >
              {t('identity.add_passkey.create_btn')}
            </button>
          </div>
        )}

        {/* ── Enrolling / proposing spinner ── */}
        {isProposing && (
          <div className="flex flex-col items-center gap-3 py-4" data-testid="proposing-spinner">
            <svg
              className="animate-spin w-7 h-7 text-yellow-500"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className={`text-sm text-center ${mutedClass}`}>
              {phase.name === 'enrolling'
                ? t('identity.add_passkey.status_enrolling')
                : t('identity.add_passkey.status_proposing')}
            </p>
          </div>
        )}

        {/* ── Proposed success ── */}
        {phase.name === 'proposed' && (
          <div
            className={`rounded-lg p-4 flex gap-3 ${
              isDark ? 'bg-green-900/30 border border-green-500/30' : 'bg-green-50 border border-green-200'
            }`}
            data-testid="proposed-success"
          >
            <HiCheckCircle className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-green-400' : 'text-green-600'}`} />
            <div>
              <p className={`text-sm font-medium ${isDark ? 'text-green-300' : 'text-green-800'}`}>
                {t('identity.add_passkey.proposed_title')}
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-green-400/70' : 'text-green-700'}`}>
                {t('identity.add_passkey.proposed_body')}
              </p>
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {phase.name === 'error' && (
          <div
            className={`rounded-lg p-3 flex gap-2 ${
              isDark ? 'bg-red-900/30 border border-red-500/30' : 'bg-red-50 border border-red-200'
            }`}
            role="alert"
            data-testid="propose-error"
          >
            <HiExclamation className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isDark ? 'text-red-400' : 'text-red-600'}`} />
            <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-700'}`}>
              {phase.message}
            </p>
          </div>
        )}

        {/* ── Close button ── */}
        <div className="pt-1">
          <button
            type="button"
            onClick={onClose}
            className={`w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${secondaryBtn}`}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default AddPasskeyDialog
