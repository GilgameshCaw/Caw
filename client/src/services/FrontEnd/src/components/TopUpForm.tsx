/**
 * TopUpForm.tsx
 *
 * Passkey-wallet (Population-B) "add funds" — pay with CAW.
 *
 * The user's deposit address IS their own SmartEOA. They (or anyone — exchange,
 * another wallet) send CAW to it; then ONE relayed batch sweeps it into their
 * staked profile balance:
 *   1. CAW.approve(CawProfile, amount)
 *   2. CawProfile.depositFor(clientId, tokenId, amount, l2Dest, 0n) {value: LZ fee}
 *   3. CAW.transfer(relayer, feeCaw)   — repay the relayer gas + the LZ fee it fronts
 *
 * Trustless: the CAW never touches the sponsor. The relayer only fronts gas + the
 * LZ fee (forwarded as msg.value on call 2), repaid in CAW by call 3 — priced by
 * GET /api/sponsor/execute-quote?forwardedValueWei=<LZ fee>, which the /execute
 * relay re-derives authoritatively (a too-low fee → FEE_TOO_LOW, the user re-signs).
 *
 * Pop-B ONLY (the /wallet page hosting it is Pop-B). Mirrors WithdrawForm's
 * quote + 3-call-batch pattern.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { formatEther, formatUnits, encodeFunctionData, erc20Abi, parseUnits } from 'viem'
import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { CLIENT_ID } from '~/api/actions'
import { apiFetch } from '~/api/client'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import { usePriceStore } from '~/store/tokenDataStore'
import { handleError } from '~/utils'
import { useT } from '~/i18n/I18nProvider'

interface SponsorExecuteQuote {
  relayer: Address
  minFeeCawWei: string
  priceAvailable: boolean
  cawAddress: Address
}

interface TopUpFormProps {
  /** tokenId of the active CAW profile to deposit into */
  tokenId: number | undefined
  /** the passkey EOA address (deposit destination shown to the user) */
  eoaAddress: Address | undefined
  /** EOA's L1 CAW balance in wei (the depositable amount) */
  cawBalanceWei: bigint
  /** EOA's L1 ETH balance in wei — the deposit LZ fee is paid from here */
  ethBalanceWei?: bigint
  /** Called after a successful relayed deposit so parents can refetch */
  onSuccess?: () => void
  className?: string
}

export function TopUpForm({ tokenId, eoaAddress, cawBalanceWei, ethBalanceWei, onSuccess, className }: TopUpFormProps) {
  const t = useT()
  const { isDark } = useTheme()
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)

  const [amount, setAmount] = useState<string>('')
  const [depositFee, setDepositFee] = useState<bigint>(0n)
  const [isPending, setIsPending] = useState(false)
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [sponsorQuote, setSponsorQuote] = useState<SponsorExecuteQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  const cawBalance = cawBalanceWei ?? 0n
  const cawBalanceTokens = Number(formatUnits(cawBalance, 18))

  // Parse the entered amount to wei, clamped at the EOA's CAW balance.
  const amountWei = useMemo(() => {
    if (!amount) return 0n
    try {
      const w = parseUnits(amount, 18)
      return w > cawBalance ? cawBalance : w
    } catch { return 0n }
  }, [amount, cawBalance])
  const amountValid = amountWei > 0n && amountWei <= cawBalance

  // Generate the deposit-address QR (mirror ShareProfileCard's dynamic import).
  useEffect(() => {
    if (!eoaAddress) { setQrDataUrl(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const mod = await import('qrcode')
        const toDataURL = (mod as any).toDataURL as ((text: string, opts: any) => Promise<string>) | undefined
        if (!toDataURL) return
        const url = await toDataURL(eoaAddress, {
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#000000', light: '#FFFFFF' },
        })
        if (!cancelled) setQrDataUrl(url)
      } catch { if (!cancelled) setQrDataUrl(null) }
    })()
    return () => { cancelled = true }
  }, [eoaAddress])

  // LZ deposit fee quote (same quoter Staking.tsx uses for the CAW deposit path).
  const { data: depositQuote } = useReadContract({
    address: CAW_NAME_QUOTER_ADDRESS,
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: 'depositQuote',
    args: [CLIENT_ID, tokenId ?? 0, amountWei, chains.l2.layerZero, false],
    query: { enabled: !!tokenId && amountWei > 0n },
  })
  useEffect(() => {
    if (depositQuote?.nativeFee != null) setDepositFee(BigInt(depositQuote.nativeFee))
  }, [depositQuote])

  // Fetch the relayer fee quote when the confirm panel opens. CRITICAL: pass
  // forwardedValueWei = depositFee (the LZ fee the relayer fronts as msg.value on
  // the depositFor call) so minFeeCawWei covers it; otherwise the /execute relay
  // re-quote rejects with FEE_TOO_LOW.
  useEffect(() => {
    if (!confirmVisible || depositFee === 0n) return
    let cancelled = false
    setQuoteLoading(true)
    apiFetch<SponsorExecuteQuote>(`/api/sponsor/execute-quote?forwardedValueWei=${depositFee.toString()}`)
      .then(data => { if (!cancelled) setSponsorQuote(data) })
      .catch(() => { if (!cancelled) setSponsorQuote(null) })
      .finally(() => { if (!cancelled) setQuoteLoading(false) })
    return () => { cancelled = true }
  }, [confirmVisible, depositFee])

  const handleCopy = useCallback(() => {
    if (!eoaAddress) return
    navigator.clipboard?.writeText(eoaAddress).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* clipboard unavailable */ })
  }, [eoaAddress])

  // Build + relay the 3-call deposit batch.
  const handleDeposit = useCallback(async () => {
    if (!eoaAccount || !tokenId || !amountValid || !sponsorQuote || !sponsorQuote.priceAvailable) return
    setIsPending(true)
    try {
      const feeCaw = BigInt(sponsorQuote.minFeeCawWei)

      // Call 1: approve CawProfile to pull `amountWei` CAW from the EOA.
      const call1: ExecCall = {
        to: CAW_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [CAW_NAMES_ADDRESS as Address, amountWei],
        }),
      }

      // Call 2: depositFor pulls the CAW into stake; forwards the LZ fee as value.
      const call2: ExecCall = {
        to: CAW_NAMES_ADDRESS,
        value: depositFee,
        data: encodeFunctionData({
          abi: cawProfileAbi,
          functionName: 'depositFor',
          args: [CLIENT_ID, Number(tokenId), amountWei, chains.l2.layerZero, 0n],
        }),
      }

      // Call 3: repay the relayer in CAW (gas + the LZ fee it fronted).
      const call3: ExecCall = {
        to: CAW_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [sponsorQuote.relayer, feeCaw],
        }),
      }

      const txHash = await smartEoaExecute([call1, call2, call3])
      console.log('[TopUpForm] deposit batch txHash:', txHash)

      // Optimistic pending-deposit hint so the stepper/budget credit it immediately
      // (same key/shape as Onboarding + New). The deposit is LZ-in-flight to L2.
      try {
        localStorage.setItem(
          `caw:pendingDeposit:${tokenId}`,
          JSON.stringify({ amount: amountWei.toString(), txHash, at: Date.now(), stakedAtHintTime: '0' }),
        )
        window.dispatchEvent(new CustomEvent('caw:pendingDepositChanged', { detail: { tokenId } }))
      } catch { /* localStorage unavailable */ }

      setConfirmVisible(false)
      setAmount('')
      onSuccess?.()
    } catch (err) {
      console.error('[TopUpForm] deposit error:', err)
      handleError(err as never, 'pop-b-deposit')
    } finally {
      setIsPending(false)
    }
  }, [eoaAccount, tokenId, amountValid, amountWei, depositFee, sponsorQuote, smartEoaExecute, onSuccess])

  // Display values
  const lzFeeEth = Number(formatEther(depositFee))
  const feeCawDisplay = sponsorQuote ? Number(formatUnits(BigInt(sponsorQuote.minFeeCawWei), 18)) : null
  // The EOA must hold ETH to cover the LZ fee (forwarded as value on depositFor).
  const needsEth = depositFee > 0n && ethBalanceWei != null && ethBalanceWei < depositFee

  const strongClass = isDark ? 'text-white' : 'text-black'
  const mutedClass = isDark ? 'text-gray-400' : 'text-gray-600'
  const inputClass = `w-full px-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-0 ${
    isDark ? 'bg-black border-white/20 text-white placeholder-gray-500' : 'bg-gray-100 border-gray-300 text-black placeholder-gray-400'
  }`
  const panelClass = `p-4 rounded-lg border transition-all duration-300 ${
    isDark ? 'bg-white/5 border-white/20' : 'bg-gray-50 border-gray-200'
  }`

  return (
    <div className={`space-y-4 ${className ?? ''}`}>
      {/* Deposit address + QR — "send CAW here" */}
      {eoaAddress && (
        <div className={panelClass}>
          <p className={`text-sm font-medium ${mutedClass} mb-2`}>{t('topup.address_label')}</p>
          <div className="flex items-center gap-3">
            {qrDataUrl && (
              <img src={qrDataUrl} alt="Deposit address QR" className="w-20 h-20 rounded bg-white p-1 flex-shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className={`font-mono text-xs break-all ${strongClass}`}>{eoaAddress}</p>
              <button
                onClick={handleCopy}
                className={`mt-2 text-xs font-medium px-3 py-1 rounded-full cursor-pointer transition-all duration-200 ${
                  isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
                }`}
              >
                {copied ? t('topup.copied') : t('topup.copy_address')}
              </button>
            </div>
          </div>
          <p className={`text-xs ${mutedClass} mt-3`}>{t('topup.address_hint')}</p>
        </div>
      )}

      {/* Amount to deposit (from the EOA's CAW balance) */}
      <div className="space-y-1">
        <div className="flex justify-between items-center px-2">
          <label className={`text-sm font-medium ${mutedClass}`}>{t('topup.amount_label')}</label>
          <button
            onClick={() => setAmount(formatUnits(cawBalance, 18))}
            className={`text-xs cursor-pointer hover:underline ${mutedClass}`}
          >
            {t('topup.balance', { amount: cawBalanceTokens.toLocaleString('en-US', { maximumFractionDigits: 2 }) })}
          </button>
        </div>
        <input
          type="number"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className={inputClass}
        />
        {amount && !amountValid && (
          <p className="text-xs text-red-500 px-2">{t('topup.invalid_amount')}</p>
        )}
      </div>

      {/* Fee summary */}
      {amountValid && (
        <div className={panelClass}>
          <div className="flex justify-between items-center text-sm">
            <span className={mutedClass}>{t('topup.deposit_label')}</span>
            <span className={`font-semibold ${strongClass}`}>
              {Number(formatUnits(amountWei, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
            </span>
          </div>
          {depositFee > 0n && (
            <div className="flex justify-between items-center text-sm mt-2">
              <span className={mutedClass}>{t('topup.lz_fee_label')}</span>
              <span className={mutedClass}>
                {lzFeeEth.toFixed(5)} ETH{ethPrice > 0 && ` (~$${(lzFeeEth * ethPrice).toFixed(2)})`}
              </span>
            </div>
          )}
          {needsEth && (
            <p className="text-xs text-red-500 mt-2">{t('topup.needs_eth_for_fee', { amount: lzFeeEth.toFixed(5) })}</p>
          )}
        </div>
      )}

      {/* Confirm / submit */}
      {!confirmVisible ? (
        <button
          onClick={() => setConfirmVisible(true)}
          disabled={!amountValid || depositFee === 0n || needsEth}
          className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 ${
            !amountValid || depositFee === 0n || needsEth
              ? isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed'
              : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
          }`}
        >
          {t('topup.review_button')}
        </button>
      ) : (
        <div className={`space-y-4 ${isDark ? 'bg-yellow-900/20 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'} rounded-lg p-4`}>
          <p className={`text-sm font-semibold ${strongClass}`}>{t('topup.confirm_title')}</p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className={mutedClass}>{t('topup.deposit_label')}</span>
              <span className={`font-semibold ${strongClass}`}>
                {Number(formatUnits(amountWei, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
              </span>
            </div>
            {feeCawDisplay != null && (
              <div className="flex justify-between">
                <span className={mutedClass}>{t('topup.relayer_fee_label')}</span>
                <span className={mutedClass}>
                  {feeCawDisplay.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
                </span>
              </div>
            )}
          </div>
          {quoteLoading && <p className={`text-xs ${mutedClass}`}>{t('topup.fetching_quote')}</p>}
          {!quoteLoading && sponsorQuote && !sponsorQuote.priceAvailable && (
            <p className="text-xs text-amber-500">{t('topup.pricing_unavailable')}</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={() => setConfirmVisible(false)}
              className={`flex-1 py-2 px-4 rounded-full text-sm font-medium cursor-pointer transition-all duration-200 ${
                isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
              }`}
            >
              {t('topup.cancel_button')}
            </button>
            <button
              onClick={handleDeposit}
              disabled={isPending || !amountValid || needsEth || !sponsorQuote || !sponsorQuote.priceAvailable || quoteLoading}
              className={`flex-1 py-2 px-4 rounded-full text-sm font-semibold transition-all duration-300 ${
                isPending || !amountValid || needsEth || !sponsorQuote || !sponsorQuote.priceAvailable || quoteLoading
                  ? isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
              }`}
            >
              {isPending ? t('topup.confirming_button') : t('topup.confirm_button')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
