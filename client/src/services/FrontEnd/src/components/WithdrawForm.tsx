/**
 * WithdrawForm.tsx
 *
 * Reusable L1 CAW withdrawal component. Branches on wallet population:
 *
 * Pop A (plain EOA):
 *   Direct withdrawTo(clientId, tokenId, recipient, lzTokenAmount) on CawProfile L1.
 *   Recipient defaults to own address, editable.
 *
 * Pop B (EIP-7702 / passkey):
 *   3-call relayed batch via useSmartEoaExecute:
 *     1. withdrawTo(clientId, tokenId, eoaAddress, 0n) — CAW lands on the EOA first.
 *     2. CAW.transfer(relayer, feeCaw)
 *     3. CAW.transfer(finalDestination, withdrawnAmount - feeCaw)
 *   Fetches relayer/feeCaw from GET /api/sponsor/execute-quote.
 *   If priceAvailable===false → disabled with explanation.
 */

import React, { useCallback, useEffect, useState } from 'react'
import { formatEther, formatUnits, encodeFunctionData, erc20Abi, parseUnits, isAddress } from 'viem'
import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { CLIENT_ID } from '~/api/actions'
import { apiFetch } from '~/api/client'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import useContractCall from '~/hooks/useContractCall'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { usePriceStore } from '~/store/tokenDataStore'
import { handleError } from '~/utils'
import { useT } from '~/i18n/I18nProvider'

interface SponsorExecuteQuote {
  relayer: Address
  minFeeCawWei: string
  priceAvailable: boolean
  cawAddress: Address
}

interface WithdrawFormProps {
  /** tokenId of the active CAW profile */
  tokenId: number | undefined
  /** withdrawable CAW in wei for this token (from L1 on-chain read) */
  withdrawableWei: bigint
  /**
   * The withdrawing wallet's L1 ETH balance in wei. Used ONLY to pre-warn Pop-B
   * users that their passkey EOA can't cover the LZ native fee (the withdrawTo
   * call carries `value: withdrawFee`, so the EOA must hold that ETH or the whole
   * relayed batch reverts). Optional: when undefined the guard is skipped.
   */
  ethBalanceWei?: bigint
  /** Called after a successful L1 withdrawal so parents can refetch data */
  onSuccess?: () => void
  /** Called after a successful L1 withdrawal (same) — alias kept for Staking compat */
  onSuccessRefetch?: () => void
  /** Optional class applied to the outer wrapper */
  className?: string
}

/** Validate an Ethereum address string entered by the user */
function isValidAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s) && isAddress(s)
}

export function WithdrawForm({ tokenId, withdrawableWei, ethBalanceWei, onSuccess, onSuccessRefetch, className }: WithdrawFormProps) {
  const t = useT()
  const { isDark } = useTheme()
  const ensureWallet = useEnsureWallet()
  const { population, address } = useWalletPopulation()
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)

  const [withdrawFee, setWithdrawFee] = useState<bigint>(0n)
  const [recipientInput, setRecipientInput] = useState<string>('')
  const [isPending, setIsPending] = useState(false)
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [sponsorQuote, setSponsorQuote] = useState<SponsorExecuteQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)

  const isPopB = population === 'B'
  const isPopA = population === 'A'

  const withdrawable = withdrawableWei ?? 0n
  const withdrawableCaw = Number(formatUnits(withdrawable, 18))

  // Effective recipient: default to own address
  const defaultRecipient = address ?? ''
  const recipient: string = recipientInput || defaultRecipient
  const recipientValid = isValidAddress(recipient)

  // Safe address for eager calldata encoding. useContractCall (Pop-A) calls
  // encodeFunctionData on EVERY render regardless of `disabled`, so a recipient
  // of '' (no wagmi address yet — Pop-B, or Pop-A pre-connect) throws
  // InvalidAddressError synchronously. Feed the zero address as a placeholder
  // when the real one isn't valid yet; the `disabled` gate below still blocks
  // any actual send until recipientValid is true.
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address
  const recipientForEncode: Address = recipientValid ? (recipient as Address) : ZERO_ADDRESS

  // LZ fee quote (same quoter as Staking.tsx)
  const { data: withdrawQuote } = useReadContract({
    address: CAW_NAME_QUOTER_ADDRESS,
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    // lzDestId (the L2 the stake lives on) is required — the quoter routes
    // through the matching L2 peer to read withdrawFee + storage fee; passing 0
    // reverts on the missing-peer guard. Mirrors Staking.tsx's withdrawQuote.
    functionName: 'withdrawQuote',
    args: [CLIENT_ID, chains.l2.layerZero, false],
    query: { enabled: !!tokenId && withdrawable > 0n },
  })

  useEffect(() => {
    if (withdrawQuote?.nativeFee != null) setWithdrawFee(BigInt(withdrawQuote.nativeFee))
  }, [withdrawQuote])

  // Fetch sponsor quote when Pop-B and confirmation panel is visible
  useEffect(() => {
    if (!isPopB || !confirmVisible) return
    let cancelled = false
    const fetchQuote = async () => {
      setQuoteLoading(true)
      try {
        const data = await apiFetch<SponsorExecuteQuote>('/api/sponsor/execute-quote')
        if (!cancelled) setSponsorQuote(data)
      } catch {
        if (!cancelled) setSponsorQuote(null)
      } finally {
        if (!cancelled) setQuoteLoading(false)
      }
    }
    fetchQuote()
    return () => { cancelled = true }
  }, [isPopB, confirmVisible])

  // Pop-A direct withdrawTo via useContractCall
  const withdrawPopA = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
    functionName: 'withdrawTo',
    // withdrawTo takes 5 args on the deployed CawProfile: the 4th is lzDestId
    // (the L2 the stake lives on) so L1 can opportunistically flush a queued
    // owner update; lzTokenAmount=0n pays LZ fees in native ETH.
    args: [CLIENT_ID, Number(tokenId ?? 0), recipientForEncode, chains.l2.layerZero, 0n],
    disabled: !tokenId || withdrawFee === 0n || !recipientValid || withdrawable === 0n,
    value: withdrawFee,
    onPending: () => setIsPending(true),
    onSuccess: (hash) => {
      console.log('[WithdrawForm] Pop-A withdrawTo success:', hash)
      setIsPending(false)
      setConfirmVisible(false)
      onSuccess?.()
      onSuccessRefetch?.()
    },
    onError: (err) => {
      setIsPending(false)
      handleError(err, 'withdrawTo')
    },
  })

  // Pop-B relayed batch execute
  const handlePopBWithdraw = useCallback(async () => {
    if (!eoaAccount || !tokenId || !sponsorQuote || !sponsorQuote.priceAvailable) return
    if (!recipientValid) return

    setIsPending(true)
    try {
      const feeCaw = BigInt(sponsorQuote.minFeeCawWei)
      const rest = withdrawable > feeCaw ? withdrawable - feeCaw : 0n

      // Call 1: withdrawTo — CAW lands on the passkey EOA first
      const call1: ExecCall = {
        to: CAW_NAMES_ADDRESS,
        value: withdrawFee,
        data: encodeFunctionData({
          abi: cawProfileAbi,
          functionName: 'withdrawTo',
          args: [CLIENT_ID, Number(tokenId), eoaAccount, chains.l2.layerZero, 0n],
        }),
      }

      // Call 2: pay the relayer CAW fee
      const call2: ExecCall = {
        to: CAW_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [sponsorQuote.relayer, feeCaw],
        }),
      }

      // Call 3: forward the net CAW to the intended destination
      const call3: ExecCall = {
        to: CAW_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [recipient as Address, rest],
        }),
      }

      const txHash = await smartEoaExecute([call1, call2, call3])
      console.log('[WithdrawForm] Pop-B execute batch txHash:', txHash)
      setConfirmVisible(false)
      onSuccess?.()
      onSuccessRefetch?.()
    } catch (err) {
      console.error('[WithdrawForm] Pop-B withdraw error:', err)
      handleError(err as never, 'pop-b-withdraw')
    } finally {
      setIsPending(false)
    }
  }, [eoaAccount, tokenId, sponsorQuote, recipientValid, withdrawable, withdrawFee, recipient, smartEoaExecute, onSuccess, onSuccessRefetch])

  const handleConfirm = useCallback(async () => {
    if (isPopA) {
      await ensureWallet({ chainId: chains.l1.chainId }, async () => {
        await withdrawPopA.call()
      })
    } else if (isPopB) {
      await handlePopBWithdraw()
    }
  }, [isPopA, isPopB, ensureWallet, withdrawPopA, handlePopBWithdraw])

  // Derived display values
  const lzFeeEth = Number(formatEther(withdrawFee))
  const feeCawDisplay = sponsorQuote ? Number(formatUnits(BigInt(sponsorQuote.minFeeCawWei), 18)) : null
  const netCawDisplay = sponsorQuote
    ? Math.max(0, withdrawableCaw - (feeCawDisplay ?? 0))
    : withdrawableCaw

  // Pop-B ETH-fee cliff: the withdrawTo call carries the LZ native fee as `value`,
  // paid from the passkey EOA. A phone-first user typically holds no ETH, so the
  // batch would revert. Pre-warn + block once we know the fee and the balance.
  // Skip the guard until both the fee quote and the balance are known (avoid a
  // false "needs ETH" flash before withdrawFee resolves).
  const popBNeedsEth =
    isPopB &&
    withdrawFee > 0n &&
    ethBalanceWei != null &&
    ethBalanceWei < withdrawFee

  // Shared theme helpers (no hardcoded text-white per feedback_light_mode_contrast.md)
  const strongClass = isDark ? 'text-white' : 'text-black'
  const mutedClass = isDark ? 'text-gray-400' : 'text-gray-600'
  const inputClass = `w-full px-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-0 ${
    isDark ? 'bg-black border-white/20 text-white placeholder-gray-500' : 'bg-gray-100 border-gray-300 text-black placeholder-gray-400'
  }`
  const panelClass = `p-4 rounded-lg border transition-all duration-300 ${
    isDark ? 'bg-white/5 border-white/20' : 'bg-gray-50 border-gray-200'
  }`

  if (withdrawable === 0n) {
    return (
      <div className={`space-y-3 ${className ?? ''}`}>
        <p className={`text-sm ${mutedClass}`}>{t('withdraw.no_withdrawable')}</p>
      </div>
    )
  }

  return (
    <div className={`space-y-4 ${className ?? ''}`}>
      {/* Recipient address */}
      <div className="space-y-1">
        <label className={`text-sm font-medium ${mutedClass}`}>
          {t('withdraw.recipient_label')}
        </label>
        <input
          type="text"
          placeholder={defaultRecipient || '0x...'}
          value={recipientInput}
          onChange={e => setRecipientInput(e.target.value)}
          className={inputClass}
        />
        {recipientInput && !recipientValid && (
          <p className="text-xs text-red-500 px-2">{t('withdraw.invalid_address')}</p>
        )}
        {!recipientInput && (
          <p className={`text-xs ${mutedClass} px-2`}>{t('withdraw.recipient_default_hint')}</p>
        )}
      </div>

      {/* Amount summary */}
      <div className={panelClass}>
        <div className="flex justify-between items-center text-sm">
          <span className={mutedClass}>{t('withdraw.amount_label')}</span>
          <span className={`font-semibold ${strongClass}`}>
            {withdrawableCaw.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
          </span>
        </div>

        {/* LZ network fee */}
        {withdrawFee > 0n && (
          <div className="flex justify-between items-center text-sm mt-2">
            <span className={mutedClass}>{t('withdraw.lz_fee_label')}</span>
            <span className={mutedClass}>
              {lzFeeEth.toFixed(5)} ETH
              {ethPrice > 0 && ` (~$${(lzFeeEth * ethPrice).toFixed(2)})`}
            </span>
          </div>
        )}

        {/* Pop-B relayer CAW fee + net display */}
        {isPopB && feeCawDisplay != null && (
          <>
            <div className="flex justify-between items-center text-sm mt-2">
              <span className={mutedClass}>{t('withdraw.relayer_fee_label')}</span>
              <span className={mutedClass}>
                {feeCawDisplay.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
              </span>
            </div>
            <div className={`flex justify-between items-center text-sm mt-2 pt-2 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
              <span className={`font-medium ${strongClass}`}>{t('withdraw.net_label')}</span>
              <span className={`font-semibold ${strongClass}`}>
                {netCawDisplay.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
              </span>
            </div>
          </>
        )}

        {/* Pop-B pricing unavailable */}
        {isPopB && sponsorQuote && !sponsorQuote.priceAvailable && (
          <p className="text-xs text-amber-500 mt-2">
            {t('withdraw.pricing_unavailable')}
          </p>
        )}

        {/* Pop-B ETH-fee cliff: the EOA can't cover the LZ native fee */}
        {popBNeedsEth && (
          <p className="text-xs text-red-500 mt-2">
            {t('withdraw.needs_eth_for_fee', { amount: lzFeeEth.toFixed(5) })}
          </p>
        )}
      </div>

      {/* Confirm step — anti-phishing panel */}
      {!confirmVisible ? (
        <button
          onClick={() => setConfirmVisible(true)}
          disabled={!recipientValid || withdrawFee === 0n || popBNeedsEth}
          className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 ${
            !recipientValid || withdrawFee === 0n || popBNeedsEth
              ? isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed'
              : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
          }`}
        >
          {t('withdraw.review_button')}
        </button>
      ) : (
        <div className={`space-y-4 ${isDark ? 'bg-yellow-900/20 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'} rounded-lg p-4`}>
          <div>
            <p className={`text-sm font-semibold ${strongClass} mb-1`}>{t('withdraw.confirm_title')}</p>
            <p className={`text-xs ${mutedClass}`}>{t('withdraw.confirm_subtitle')}</p>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className={mutedClass}>{t('withdraw.confirm_destination')}</span>
              <span className={`font-mono text-xs ${strongClass} break-all`}>{recipient}</span>
            </div>
            <div className="flex justify-between">
              <span className={mutedClass}>{t('withdraw.confirm_net_amount')}</span>
              <span className={`font-semibold ${strongClass}`}>
                {netCawDisplay.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
              </span>
            </div>
          </div>

          {isPopB && quoteLoading && (
            <p className={`text-xs ${mutedClass}`}>{t('withdraw.fetching_quote')}</p>
          )}

          {isPopB && !quoteLoading && sponsorQuote && !sponsorQuote.priceAvailable && (
            <p className="text-xs text-amber-500">{t('withdraw.pricing_unavailable')}</p>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setConfirmVisible(false)}
              className={`flex-1 py-2 px-4 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer ${
                isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
              }`}
            >
              {t('withdraw.cancel_button')}
            </button>
            <button
              onClick={handleConfirm}
              disabled={
                isPending ||
                !recipientValid ||
                popBNeedsEth ||
                (isPopB && (!sponsorQuote || !sponsorQuote.priceAvailable || quoteLoading))
              }
              className={`flex-1 py-2 px-4 rounded-full text-sm font-semibold transition-all duration-300 ${
                isPending ||
                !recipientValid ||
                popBNeedsEth ||
                (isPopB && (!sponsorQuote || !sponsorQuote.priceAvailable || quoteLoading))
                  ? isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
              }`}
            >
              {isPending ? t('withdraw.confirming_button') : t('withdraw.confirm_button')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
