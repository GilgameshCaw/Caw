/**
 * TopUpForm.tsx
 *
 * Passkey-wallet (Population-B) "add funds" — two tabs:
 *
 * CAW tab (original):
 *   The user's deposit address IS their own SmartEOA. They (or anyone — exchange,
 *   another wallet) send CAW to it; then ONE relayed batch sweeps it into their
 *   staked profile balance:
 *     1. CAW.approve(CawProfile, amount)
 *     2. CawProfile.depositFor(clientId, tokenId, amount, l2Dest, 0n) {value: LZ fee}
 *     3. CAW.transfer(relayer, feeCaw)   — repay the relayer gas
 *
 * ETH tab (new):
 *   The EOA holds ETH. ONE executeBatch swaps it to CAW and deposits in one go:
 *     1. CawMinter.depositZap(cawNetworkId, tokenId, swapEthWei, minCawOut, lzDestId, 0n)
 *            { value: swapEthWei + lzFeeWei }   — Minter swaps+deposits
 *     2. { to: relayer, value: minFeeEthWei, data: '0x' }  — ETH-repay gas fee
 *   executeBatch is non-payable; all inner ETH comes from the EOA's own balance.
 *
 * Pop-B ONLY (the /wallet page hosting it is Pop-B).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { formatEther, formatUnits, encodeFunctionData, erc20Abi, parseUnits, parseEther } from 'viem'
import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { cawProfileAbi, cawProfileMinterAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_MINTER_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_PAIR_ADDRESS } from '~/../../../abi/addresses'
import { CLIENT_ID } from '~/api/actions'
import { apiFetch } from '~/api/client'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import { usePriceStore } from '~/store/tokenDataStore'
import { usePoolReserves, useMinCawOut, suggestedSlippageBps } from '~/hooks/useZapQuote'
import { handleError } from '~/utils'
import { useT } from '~/i18n/I18nProvider'
import { DepositAddressBox } from '~/components/DepositAddressBox'

type TopUpTab = 'caw' | 'eth'

interface SponsorExecuteQuote {
  relayer: Address
  minFeeCawWei: string
  minFeeEthWei: string
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

  // ─── shared UI state ────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TopUpTab>('caw')
  const [isPending, setIsPending] = useState(false)
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [sponsorQuote, setSponsorQuote] = useState<SponsorExecuteQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)

  // ─── CAW-tab state ──────────────────────────────────────────────────────────
  const [amount, setAmount] = useState<string>('')
  const [depositFee, setDepositFee] = useState<bigint>(0n)

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

  // ─── ETH-tab state ──────────────────────────────────────────────────────────
  const [ethAmount, setEthAmount] = useState<string>('')
  const [ethDepositFee, setEthDepositFee] = useState<bigint>(0n)
  const [slippageBps, setSlippageBps] = useState<number>(200)
  const [slippageAutoSet, setSlippageAutoSet] = useState(false)

  const ethAmountWei = useMemo(() => {
    if (!ethAmount) return 0n
    try { return parseEther(ethAmount) } catch { return 0n }
  }, [ethAmount])

  // Pool reserves for V2 swap quote.
  const reserves = usePoolReserves(CAW_PAIR_ADDRESS as `0x${string}`, chains.l1.chainId)

  // Auto-set slippage based on trade size.
  useEffect(() => {
    if (activeTab !== 'eth' || slippageAutoSet || ethAmountWei === 0n || !reserves.loaded) return
    setSlippageBps(suggestedSlippageBps(ethAmountWei, reserves.wethReserve))
    setSlippageAutoSet(true)
  }, [activeTab, slippageAutoSet, ethAmountWei, reserves.loaded, reserves.wethReserve])

  // Reset slippage-auto flag when ETH amount is cleared so it re-fires next input.
  useEffect(() => {
    if (ethAmountWei === 0n) setSlippageAutoSet(false)
  }, [ethAmountWei])

  // minCawOut from Uniswap V2 reserves + slippage.
  const zapQuote = useMinCawOut(ethAmountWei, reserves, slippageBps)

  // LZ fee for the depositZap call (from the on-chain quoter).
  const { data: depositZapQuoteData } = useReadContract({
    address: CAW_NAME_QUOTER_ADDRESS,
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: 'depositZapQuote',
    args: [CLIENT_ID, tokenId ?? 0, chains.l2.layerZero, false],
    query: { enabled: activeTab === 'eth' && !!tokenId },
  })
  useEffect(() => {
    if (activeTab === 'eth' && depositZapQuoteData?.nativeFee != null) {
      setEthDepositFee(BigInt(depositZapQuoteData.nativeFee))
    }
  }, [activeTab, depositZapQuoteData])

  // Total ETH the EOA must hold: swapEth + lzFee + gasRepayFee.
  const minFeeEthWei = sponsorQuote ? BigInt(sponsorQuote.minFeeEthWei) : 0n
  const ethTotalRequired = ethAmountWei + ethDepositFee + minFeeEthWei

  const ethBalanceBigint = ethBalanceWei ?? 0n
  const ethAmountValid = ethAmountWei > 0n && zapQuote.loaded
  // Pre-flight: EOA must have enough ETH. Gate only once the quote is loaded.
  const ethInsufficientBalance =
    ethAmountValid && ethDepositFee > 0n && minFeeEthWei > 0n &&
    ethBalanceBigint < ethTotalRequired


  // ─── CAW tab: LZ deposit fee quote ─────────────────────────────────────────
  const { data: depositQuote } = useReadContract({
    address: CAW_NAME_QUOTER_ADDRESS,
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: 'depositQuote',
    args: [CLIENT_ID, tokenId ?? 0, amountWei, chains.l2.layerZero, false],
    query: { enabled: activeTab === 'caw' && !!tokenId && amountWei > 0n },
  })
  useEffect(() => {
    if (activeTab === 'caw' && depositQuote?.nativeFee != null) {
      setDepositFee(BigInt(depositQuote.nativeFee))
    }
  }, [activeTab, depositQuote])

  // ─── Fetch sponsor quote when confirm panel opens ──────────────────────────
  // CAW tab: forwardedValueWei = depositFee (LZ fee relayer fronts on call 2).
  // ETH tab: no forwarded value; gas-only. Same endpoint, no query param needed.
  useEffect(() => {
    if (!confirmVisible) return
    if (activeTab === 'caw' && depositFee === 0n) return
    if (activeTab === 'eth' && !ethAmountValid) return
    let cancelled = false
    setQuoteLoading(true)
    const url = activeTab === 'caw'
      ? `/api/sponsor/execute-quote?forwardedValueWei=${depositFee.toString()}`
      : '/api/sponsor/execute-quote'
    apiFetch<SponsorExecuteQuote>(url)
      .then(data => { if (!cancelled) setSponsorQuote(data) })
      .catch(() => { if (!cancelled) setSponsorQuote(null) })
      .finally(() => { if (!cancelled) setQuoteLoading(false) })
    return () => { cancelled = true }
  }, [confirmVisible, activeTab, depositFee, ethAmountValid])

  // ─── CAW tab: build + relay the 3-call deposit batch ───────────────────────
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

      // Call 3: repay the relayer in CAW (gas cost only — executeBatch is non-payable).
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

  // ─── ETH tab: build + relay the 2-call depositZap batch ───────────────────
  const handleDepositZap = useCallback(async () => {
    if (!eoaAccount || !tokenId || !ethAmountValid || !zapQuote.loaded || !sponsorQuote) return
    setIsPending(true)
    try {
      const feeEth = BigInt(sponsorQuote.minFeeEthWei)

      // Call 1: depositZap — Minter swaps ETH→CAW via Uniswap V2 and deposits.
      // msg.value = swapEthWei + lzFeeWei (both come from the EOA's own ETH).
      const call1: ExecCall = {
        to: CAW_NAMES_MINTER_ADDRESS as Address,
        value: ethAmountWei + ethDepositFee,
        data: encodeFunctionData({
          abi: cawProfileMinterAbi,
          functionName: 'depositZap',
          args: [CLIENT_ID, Number(tokenId), ethAmountWei, zapQuote.minCawOut, chains.l2.layerZero, 0n],
        }),
      }

      // Call 2: ETH raw transfer to repay the relayer for gas (executeBatch is non-payable).
      const call2: ExecCall = {
        to: sponsorQuote.relayer,
        value: feeEth,
        data: '0x',
      }

      const txHash = await smartEoaExecute([call1, call2])
      console.log('[TopUpForm] depositZap batch txHash:', txHash)

      // Optimistic pending-deposit hint — expected CAW out (before slippage floor).
      try {
        localStorage.setItem(
          `caw:pendingDeposit:${tokenId}`,
          JSON.stringify({ amount: zapQuote.expectedCawOut.toString(), txHash, at: Date.now(), stakedAtHintTime: '0' }),
        )
        window.dispatchEvent(new CustomEvent('caw:pendingDepositChanged', { detail: { tokenId } }))
      } catch { /* localStorage unavailable */ }

      setConfirmVisible(false)
      setEthAmount('')
      setSlippageAutoSet(false)
      onSuccess?.()
    } catch (err) {
      console.error('[TopUpForm] depositZap error:', err)
      handleError(err as never, 'pop-b-deposit-zap')
    } finally {
      setIsPending(false)
    }
  }, [eoaAccount, tokenId, ethAmountValid, ethAmountWei, ethDepositFee, zapQuote, sponsorQuote, smartEoaExecute, onSuccess])

  // ─── Display values ─────────────────────────────────────────────────────────
  const lzFeeEth = Number(formatEther(depositFee))
  const feeCawDisplay = sponsorQuote ? Number(formatUnits(BigInt(sponsorQuote.minFeeCawWei), 18)) : null
  // CAW tab: EOA must hold ETH for the LZ fee forwarded on call 2.
  const needsEth = depositFee > 0n && ethBalanceWei != null && ethBalanceWei < depositFee

  const ethLzFeeDisplay = Number(formatEther(ethDepositFee))
  const feeEthDisplay = sponsorQuote ? Number(formatEther(BigInt(sponsorQuote.minFeeEthWei))) : null
  const expectedCawDisplay = zapQuote.expectedCawOut > 0n
    ? Number(formatUnits(zapQuote.expectedCawOut, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : null
  const ethTotalRequiredDisplay = Number(formatEther(ethTotalRequired))

  const strongClass = isDark ? 'text-white' : 'text-black'
  const mutedClass = isDark ? 'text-gray-400' : 'text-gray-600'
  const inputClass = `w-full px-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-0 ${
    isDark ? 'bg-black border-white/20 text-white placeholder-gray-500' : 'bg-gray-100 border-gray-300 text-black placeholder-gray-400'
  }`
  const panelClass = `p-4 rounded-lg border transition-all duration-300 ${
    isDark ? 'bg-white/5 border-white/20' : 'bg-gray-50 border-gray-200'
  }`
  const tabBase = `flex-1 py-2 text-sm font-medium rounded-full transition-all duration-200 cursor-pointer`
  const tabActive = isDark ? 'bg-yellow-500 text-black' : 'bg-yellow-500 text-black'
  const tabInactive = isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'

  return (
    <div className={`space-y-4 ${className ?? ''}`}>

      {/* ── Tab toggle ─────────────────────────────────────────────────────── */}
      <div className={`flex gap-1 p-1 rounded-full ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
        <button
          onClick={() => { setActiveTab('caw'); setConfirmVisible(false) }}
          className={`${tabBase} ${activeTab === 'caw' ? tabActive : tabInactive}`}
        >
          {t('topup.tab_caw')}
        </button>
        <button
          onClick={() => { setActiveTab('eth'); setConfirmVisible(false) }}
          className={`${tabBase} ${activeTab === 'eth' ? tabActive : tabInactive}`}
        >
          {t('topup.tab_eth')}
        </button>
      </div>

      {/* ── Deposit address (shown on both tabs) ───────────────────────────── */}
      {eoaAddress && (
        <DepositAddressBox address={eoaAddress} population="B" />
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* CAW TAB                                                              */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'caw' && (
        <>
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
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* ETH TAB                                                              */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'eth' && (
        <>
          {/* ETH amount input */}
          <div className="space-y-1">
            <div className="flex justify-between items-center px-2">
              <label className={`text-sm font-medium ${mutedClass}`}>{t('topup.eth_amount_label')}</label>
              {ethBalanceWei != null && (
                <button
                  onClick={() => {
                    // Use max = balance − lzFee − relayerFee (leave at least that free).
                    const reserve = ethDepositFee + minFeeEthWei
                    const max = ethBalanceBigint > reserve ? ethBalanceBigint - reserve : 0n
                    setEthAmount(formatEther(max))
                  }}
                  className={`text-xs cursor-pointer hover:underline ${mutedClass}`}
                >
                  {t('topup.balance', { amount: Number(formatEther(ethBalanceBigint)).toLocaleString('en-US', { maximumFractionDigits: 5 }) })}
                </button>
              )}
            </div>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.0"
              value={ethAmount}
              onChange={e => { setEthAmount(e.target.value); setSlippageAutoSet(false) }}
              className={inputClass}
            />
          </div>

          {/* Swap / fee summary */}
          {ethAmountValid && (
            <div className={panelClass}>
              {expectedCawDisplay && (
                <div className="flex justify-between items-center text-sm">
                  <span className={mutedClass}>{t('topup.expected_caw_label')}</span>
                  <span className={`font-semibold ${strongClass}`}>~{expectedCawDisplay} CAW</span>
                </div>
              )}
              {ethDepositFee > 0n && (
                <div className="flex justify-between items-center text-sm mt-2">
                  <span className={mutedClass}>{t('topup.lz_fee_label')}</span>
                  <span className={mutedClass}>
                    {ethLzFeeDisplay.toFixed(5)} ETH{ethPrice > 0 && ` (~$${(ethLzFeeDisplay * ethPrice).toFixed(2)})`}
                  </span>
                </div>
              )}
              {feeEthDisplay != null && (
                <div className="flex justify-between items-center text-sm mt-2">
                  <span className={mutedClass}>{t('topup.relayer_fee_eth_label')}</span>
                  <span className={mutedClass}>
                    {feeEthDisplay.toFixed(6)} ETH{ethPrice > 0 && ` (~$${(feeEthDisplay * ethPrice).toFixed(2)})`}
                  </span>
                </div>
              )}
              {ethTotalRequired > 0n && (
                <div className={`flex justify-between items-center text-sm mt-2 pt-2 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                  <span className={`font-medium ${mutedClass}`}>{t('topup.eth_total_label')}</span>
                  <span className={`font-semibold ${strongClass}`}>
                    {ethTotalRequiredDisplay.toFixed(5)} ETH
                  </span>
                </div>
              )}
              {ethInsufficientBalance && (
                <p className="text-xs text-red-500 mt-2">
                  {t('topup.eth_insufficient', { amount: ethTotalRequiredDisplay.toFixed(5) })}
                </p>
              )}
            </div>
          )}

          {/* Confirm / submit */}
          {!confirmVisible ? (
            <button
              onClick={() => setConfirmVisible(true)}
              disabled={!ethAmountValid || ethDepositFee === 0n || ethInsufficientBalance}
              className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 ${
                !ethAmountValid || ethDepositFee === 0n || ethInsufficientBalance
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
                  <span className={mutedClass}>{t('topup.eth_spend_label')}</span>
                  <span className={`font-semibold ${strongClass}`}>{ethAmount} ETH</span>
                </div>
                {expectedCawDisplay && (
                  <div className="flex justify-between">
                    <span className={mutedClass}>{t('topup.expected_caw_label')}</span>
                    <span className={mutedClass}>~{expectedCawDisplay} CAW</span>
                  </div>
                )}
                {feeEthDisplay != null && (
                  <div className="flex justify-between">
                    <span className={mutedClass}>{t('topup.relayer_fee_eth_label')}</span>
                    <span className={mutedClass}>{feeEthDisplay.toFixed(6)} ETH</span>
                  </div>
                )}
              </div>
              {quoteLoading && <p className={`text-xs ${mutedClass}`}>{t('topup.fetching_quote')}</p>}
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
                  onClick={handleDepositZap}
                  disabled={isPending || !ethAmountValid || ethInsufficientBalance || !sponsorQuote || quoteLoading}
                  className={`flex-1 py-2 px-4 rounded-full text-sm font-semibold transition-all duration-300 ${
                    isPending || !ethAmountValid || ethInsufficientBalance || !sponsorQuote || quoteLoading
                      ? isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed'
                      : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
                  }`}
                >
                  {isPending ? t('topup.confirming_button') : t('topup.confirm_button')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
