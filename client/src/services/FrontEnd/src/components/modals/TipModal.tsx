import React, { useState, useEffect } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { themeTextSecondary, themeTextMuted, themeBorder } from '~/utils/theme'
import { useSignAndSubmitAction, getValidatorTip } from '~/api/actions'
import { useActiveToken, usePriceStore } from '~/store/tokenDataStore'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import InsufficientStakeModal from './InsufficientStakeModal'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import Tooltip from '~/components/Tooltip'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { useT } from '~/i18n/I18nProvider'

const PRESET_USD_AMOUNTS = [1, 5, 10, 20]
// Floor in USD (not CAW) so the gate matches the user-facing input
// regardless of CAW price. Previously this was a CAW floor of 1, which
// was effectively no floor at all when CAW was a fraction of a cent.
const MIN_TIP_USD = 1

const formatUsd = (n: number): string =>
  n < 1 ? `$${n.toFixed(2)}` : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`

const trimZero = (s: string): string => s.replace(/\.0+$/, '')

const formatCompactCaw = (n: number): string => {
  if (n >= 1_000_000_000) return `${trimZero((n / 1_000_000_000).toFixed(1))}b`
  if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}m`
  if (n >= 1_000) return `${trimZero((n / 1_000).toFixed(1))}k`
  return n.toFixed(0)
}

const usdToCaw = (usd: number, cawPrice: number): number => {
  if (!cawPrice || cawPrice <= 0) return 0
  return Math.max(1, Math.round(usd / cawPrice))
}

interface TipModalProps {
  isOpen: boolean
  recipientTokenId: number
  recipientUsername: string
  cawUserId?: number
  cawCawonce?: number
  onClose: () => void
  onTipSubmitted?: () => void
}

type TipState = 'idle' | 'signing' | 'submitted'

const TipModal: React.FC<TipModalProps> = ({
  isOpen,
  recipientTokenId,
  recipientUsername,
  cawUserId,
  cawCawonce,
  onClose,
  onTipSubmitted
}) => {
  const { isDark } = useTheme()
  const t = useT()
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const priceReady = cawPrice > 0
  const [usdInput, setUsdInput] = useState(PRESET_USD_AMOUNTS[0].toString())
  const [tipState, setTipState] = useState<TipState>('idle')
  const [error, setError] = useState<string | null>(null)

  const signAndSubmit = useSignAndSubmitAction()
  const activeToken = useActiveToken()
  const activeTokenId = activeToken?.tokenId
  const { isConnected, address } = useAccount()
  const { openConnectModal } = useConnectModal()
  const hasActiveSession = useHasActiveSession()
  const wrongWallet = isConnected && !hasActiveSession && activeToken?.owner && address
    ? activeToken.owner.toLowerCase() !== address.toLowerCase()
    : false
  const [showInsufficientStake, setShowInsufficientStake] = useState(false)

  // Reset to fresh state when modal opens (unless tip is still pending)
  useEffect(() => {
    if (isOpen && tipState !== 'signing') {
      setUsdInput(PRESET_USD_AMOUNTS[0].toString())
      setTipState('idle')
      setError(null)
    }
  }, [isOpen])

  const usdAmount = parseFloat(usdInput) || 0
  const tipAmount = usdToCaw(usdAmount, cawPrice)
  const validatorTip = getValidatorTip()
  const totalCost = BigInt(tipAmount + Number(validatorTip)) * 10n**18n
  const isValid = priceReady && usdAmount >= MIN_TIP_USD && tipAmount > 0

  const handleSubmit = async () => {
    if (!isValid) return

    if (!isConnected && !hasActiveSession) {
      openConnectModal?.()
      return
    }

    if (!activeTokenId) {
      setError(t('tip.error.no_token'))
      return
    }

    // Check if user has enough staked CAW to cover tip + validator fee
    const stakedAmount = activeToken?.stakedAmount ?? 0n
    if (stakedAmount < totalCost) {
      setShowInsufficientStake(true)
      return
    }

    setError(null)
    setTipState('signing')

    try {
      // Build the tip text: "tip:userId:cawonce" for post tips, "tip:" for profile tips
      const tipText = cawUserId != null && cawCawonce != null
        ? `tip:${cawUserId}:${cawCawonce}`
        : 'tip:'

      await signAndSubmit({
        actionType: 'other',
        senderId: activeTokenId,
        receiverId: recipientTokenId,
        receiverCawonce: cawCawonce ?? 0,
        recipients: [recipientTokenId],
        amounts: [BigInt(tipAmount), validatorTip],
        text: tipText
      })

      setTipState('submitted')
      onTipSubmitted?.()

      // Auto-close after 2 seconds
      setTimeout(() => {
        onClose()
      }, 2000)
    } catch (err: any) {
      console.error('Tip failed:', err)
      setTipState('idle')
      if (err.message?.includes('rejected') || err.message?.includes('denied')) {
        setError(t('profile.error.tx_rejected'))
      } else {
        setError(err.message?.split('\n')[0]?.slice(0, 100) || t('tip.error.failed'))
      }
    }
  }

  return (
    <>
      <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-sm">
        <ModalHeader title={t('tip.title', { username: recipientUsername })} onClose={onClose} />

        {/* Content */}
        <div className="p-4 space-y-4">
          {tipState === 'submitted' ? (
            <div className="flex flex-col items-center py-6 space-y-3">
              <div className="relative w-12 h-12">
                <div className="w-12 h-12 border-3 border-gray-400 border-t-yellow-500 rounded-full animate-spin"></div>
                <svg className="absolute inset-0 w-6 h-6 m-auto text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className={`text-sm ${themeTextSecondary(isDark)}`}>
                {t('tip.submitted', { amount: formatCompactCaw(tipAmount) })}
              </p>
            </div>
          ) : (
            <>
              {/* Preset amounts */}
              <div>
                <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>
                  {t('tip.select_amount')}
                </label>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {PRESET_USD_AMOUNTS.map(preset => (
                    <button
                      key={preset}
                      onClick={() => { setUsdInput(preset.toString()); setError(null) }}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer ${
                        usdAmount === preset
                          ? 'bg-yellow-500 text-black'
                          : isDark
                            ? 'bg-white/10 text-white hover:bg-white/20'
                            : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                      }`}
                    >
                      {formatUsd(preset)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom amount */}
              <div>
                <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>
                  {t('tip.amount_usd')}
                </label>
                <div className="relative mt-1">
                  <span className={`absolute left-3 top-1/2 -translate-y-1/2 text-sm ${themeTextMuted(isDark)}`}>$</span>
                  <input
                    type="number"
                    min={MIN_TIP_USD}
                    step="1"
                    value={usdInput}
                    onChange={e => {
                      setUsdInput(e.target.value)
                      setError(null)
                    }}
                    placeholder="0.00"
                    className={`w-full pl-7 pr-3 py-2 rounded-lg text-sm outline-none transition-colors ${
                      isDark
                        ? 'bg-white/10 text-white border border-white/20 focus:border-yellow-500/50 placeholder-gray-500'
                        : 'bg-gray-100 text-gray-900 border border-gray-200 focus:border-yellow-500 placeholder-gray-400'
                    }`}
                  />
                </div>
                {/* Balance line — derived from the staked amount we already
                    check against on submit. Turns red when the input pushes
                    total cost past available balance, so the user sees the
                    constraint before clicking Tip. */}
                {(() => {
                  const stakedAmount = activeToken?.stakedAmount ?? 0n
                  const balanceCaw = Number(stakedAmount / 10n**18n)
                  const insufficient = isValid && stakedAmount < totalCost
                  return (
                    <div className={`mt-1.5 text-xs flex justify-between ${insufficient ? 'text-error-dim' : themeTextMuted(isDark)}`}>
                      <span>{t('tip.balance', { defaultValue: 'Balance' })}: {balanceCaw.toLocaleString()} CAW</span>
                      {isValid && (
                        <span>
                          {insufficient
                            ? t('tip.insufficient', { defaultValue: 'Insufficient' })
                            : `${(balanceCaw - tipAmount - Number(validatorTip)).toLocaleString()} CAW left`}
                        </span>
                      )}
                    </div>
                  )
                })()}
              </div>

              {/* Cost summary */}
              <div className={`text-xs space-y-1 ${themeTextMuted(isDark)}`}>
                <div className="flex justify-between">
                  <span>{t('tip.row.tip_amount')}</span>
                  <span>{isValid ? tipAmount.toLocaleString() : '—'} CAW</span>
                </div>
                <div className="flex justify-between">
                  <span>{t('tip.row.validator_fee')}</span>
                  <span>{validatorTip.toString()} CAW</span>
                </div>
                <div className={`flex justify-between font-medium pt-1 border-t ${themeBorder(isDark)} ${themeTextSecondary(isDark)}`}>
                  <span>{t('tip.row.total')}</span>
                  <span>{isValid ? (tipAmount + Number(validatorTip)).toLocaleString() : '—'} CAW</span>
                </div>
              </div>

              {/* Error */}
              {error && (
                <p className="text-sm text-error-dim text-center">{error}</p>
              )}

              {/* Submit */}
              {(() => {
                const isDisabled = !isValid || tipState === 'signing' || wrongWallet
                const btn = (
                  <button
                    onClick={handleSubmit}
                    disabled={isDisabled}
                    className={
                      wrongWallet
                        ? 'w-full px-3 py-1.5 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer'
                        : `w-full py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 cursor-pointer ${
                            tipState === 'signing'
                              ? 'bg-yellow-500/30 cursor-not-allowed text-black'
                              : isDisabled
                                ? 'bg-yellow-500/30 cursor-not-allowed text-yellow-500/50'
                                : 'bg-yellow-500 text-black hover:bg-yellow-400'
                          }`
                    }
                  >
                    {wrongWallet ? t('post_form.button.wrong_wallet') : !priceReady ? t('tip.button.loading_price') : tipState === 'signing' ? (
                      <div className="flex items-center justify-center space-x-2">
                        <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"></div>
                        <span>{t('messages.signin.signing')}</span>
                      </div>
                    ) : (
                      isValid ? t('tip.button.send_amount', { amount: formatCompactCaw(tipAmount) + ' CAW' }) : t('tip.button.send')
                    )}
                  </button>
                )
                return wrongWallet
                  ? <Tooltip text={t('post_form.error.wrong_wallet_tooltip')} className="cursor-not-allowed">{btn}</Tooltip>
                  : btn
              })()}
            </>
          )}
        </div>
      </ModalWrapper>

      {/* Insufficient Stake Modal */}
      <InsufficientStakeModal
        isOpen={showInsufficientStake}
        onClose={() => setShowInsufficientStake(false)}
        actionType="post"
        currentAmount={activeToken?.stakedAmount}
        requiredAmount={totalCost}
      />
    </>
  )
}

export default TipModal
