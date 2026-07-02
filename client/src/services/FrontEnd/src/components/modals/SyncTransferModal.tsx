import React, { useCallback, useState, useEffect } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, usePublicClient } from 'wagmi'
import { readContract } from '@wagmi/core'
import { formatEther, erc20Abi, encodeFunctionData, type Address } from 'viem'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeTextSecondary, themeTextMuted, themeBgSubtle, themeSecondaryButton } from '~/utils/theme'
import { formatUsd } from '~/utils/numberFormat'
import { useSyncTransferStore } from '~/store/syncTransferStore'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'
import { usePriceStore } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'

const SyncTransferModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { isOpen, tokenId, username, close } = useSyncTransferStore()
  const { isConnected } = useAccount()
  const ensureWallet = useEnsureWallet()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const { writeContract, data: hash, isPending: isSubmitting, error: writeError, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  // Pop-B (passkey) relay path
  const { population } = useWalletPopulation()
  const isPopB = population === 'B'
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const l1Client = usePublicClient({ chainId: chains.l1.chainId })
  const [popBPending, setPopBPending] = useState(false)
  const [popBSuccess, setPopBSuccess] = useState(false)
  const [popBError, setPopBError] = useState<string | null>(null)

  const [lzFee, setLzFee] = useState<bigint | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)

  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  // Quote the LZ fee when modal opens
  useEffect(() => {
    if (!isOpen || tokenId === null) {
      setLzFee(null)
      return
    }

    let cancelled = false
    setIsQuoting(true)

    // Quote with tokenId=0 and address(0) since the transfer is already pending in the queue
    readContract(wagmiConfig, {
      address: CAW_NAME_QUOTER_ADDRESS,
      abi: cawProfileQuoterAbi,
      functionName: 'syncTransferQuote',
      // Phase 1: signature gained `lzDestId` as 3rd arg. This modal syncs
      // to the cross-chain L2 (matches the syncTransfer call below), so
      // quote against the L2 LayerZero eid.
      args: [0, '0x0000000000000000000000000000000000000000', chains.l2.layerZero, false],
      chainId: chains.l1.chainId
    })
      .then((quote: any) => {
        if (!cancelled) {
          const fee = (quote.nativeFee * 110n) / 100n
          setLzFee(fee)
        }
      })
      .catch((err) => {
        console.warn('[SyncTransfer] Failed to quote LZ fee:', err)
        if (!cancelled) setLzFee(null)
      })
      .finally(() => {
        if (!cancelled) setIsQuoting(false)
      })

    return () => { cancelled = true }
  }, [isOpen, tokenId])

  const handleClose = () => {
    reset()
    setPopBError(null)
    setPopBSuccess(false)
    setPopBPending(false)
    close()
  }

  const handleSync = async () => {
    if (isPopB) {
      handlePopBSync()
      return
    }
    await ensureWallet({ chainId: chains.l1.chainId }, async () => {
      writeContract({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
        functionName: 'syncTransfer',
        args: [chains.l2.layerZero, 0n] as [number, bigint],
        value: lzFee ?? 0n,
        chainId: chains.l1.chainId
      })
    })
  }

  // Pop-B relay: syncTransfer (payable LZ fee self-funded) + fee leg.
  const handlePopBSync = useCallback(async () => {
    if (!isPopB || !eoaAccount || !l1Client) return
    setPopBError(null)
    setPopBPending(true)
    try {
      const quote = await apiFetch<{ relayer: string; minFeeCawWei: string; priceAvailable: boolean; minFeeEthWei: string }>(
        `/api/sponsor/execute-quote?forwardedValueWei=0`,
      )
      const feeCaw = quote.priceAvailable ? BigInt(quote.minFeeCawWei) : null
      const feeEth = BigInt(quote.minFeeEthWei)
      const syncLzFee = lzFee ?? 0n

      const [cawBalNow, ethBalNow] = await Promise.all([
        l1Client.readContract({ address: CAW_ADDRESS as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoaAccount as Address] }) as Promise<bigint>,
        l1Client.getBalance({ address: eoaAccount as Address }),
      ])
      const payInCaw = feeCaw != null && cawBalNow >= feeCaw
      const payInEth = ethBalNow >= syncLzFee + feeEth
      if (!payInCaw && !payInEth) throw new Error('INSUFFICIENT_FEE_CAW')

      const calls: ExecCall[] = [
        {
          to: CAW_NAMES_ADDRESS,
          value: syncLzFee, // self-funded LZ fee
          data: encodeFunctionData({
            abi: cawProfileAbi,
            functionName: 'syncTransfer',
            args: [chains.l2.layerZero, 0n] as [number, bigint],
          }),
        },
      ]
      if (payInCaw) {
        calls.push({ to: CAW_ADDRESS as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [quote.relayer as Address, feeCaw!] }) })
      } else {
        calls.push({ to: quote.relayer as Address, value: feeEth, data: '0x' })
      }
      await smartEoaExecute(calls)
      setPopBSuccess(true)
    } catch (err: any) {
      const raw = (err?.message || '').replace(/^API\s+\d+:\s*/i, '')
      if (/NotAllowed|abort|cancel|denied|rejected/i.test(raw)) setPopBError(t('sync_transfer.error.tx_rejected'))
      else if (/no pending transfers/i.test(raw)) setPopBError(t('sync_transfer.error.no_pending'))
      else if (/SIMULATION_FAILED|INSUFFICIENT_FEE_CAW|insufficient|FEE_TOO_LOW/i.test(raw)) setPopBError(t('sync_transfer.popb_insufficient_fee'))
      else setPopBError(t('sync_transfer.error.tx_failed'))
    } finally {
      setPopBPending(false)
    }
  }, [isPopB, eoaAccount, l1Client, lzFee, smartEoaExecute, t])

  const getButtonText = () => {
    if (popBPending) return t('sync_transfer.btn.confirm_in_wallet')
    if (popBSuccess) return t('sync_transfer.btn.synced')
    if (needsChainSwitch) return isSwitchingChain ? t('sync_transfer.btn.switching') : t('sync_transfer.btn.switch_network')
    if (isQuoting) return t('sync_transfer.btn.estimating_fee')
    if (isSubmitting) return t('sync_transfer.btn.confirm_in_wallet')
    if (isConfirming) return t('sync_transfer.btn.syncing')
    if (isSuccess) return t('sync_transfer.btn.synced')
    return t('sync_transfer.btn.sync')
  }

  const isButtonDisabled = isSubmitting || isConfirming || isSuccess || isSwitchingChain || isQuoting || popBPending || popBSuccess

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-md" usePortal zIndex={9999}>
      <div className="p-6">
        <ModalHeader
          title={t('sync_transfer.title')}
          onClose={handleClose}
          icon={
            <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          }
          border={false}
          size="lg"
          className="mb-4 px-0"
        />

        <p className={`text-sm mb-4 ${themeTextSecondary(isDark)}`}>
          <span className="font-semibold">@{username}</span>{t('sync_transfer.intro_token', { tokenId: tokenId ?? '' })}
        </p>

        <p className={`text-xs mb-5 ${themeTextMuted(isDark)}`}>
          {t('sync_transfer.note')}
        </p>

        {/* Show LZ fee estimate */}
        {lzFee !== null && lzFee > 0n && (
          <div className={`mb-4 p-3 rounded-lg text-xs ${themeBgSubtle(isDark)} ${themeTextMuted(isDark)}`}>
            {t('sync_transfer.fee_label')}: ~{formatEther(lzFee)} ETH{ethPrice > 0 && ` (~$${formatUsd(Number(formatEther(lzFee)) * ethPrice)})`}
          </div>
        )}

        {(writeError || popBError) && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
            {popBError
              ? popBError
              : writeError?.message?.includes('User rejected')
                ? t('sync_transfer.error.tx_rejected')
                : writeError?.message?.includes('no pending transfers')
                  ? t('sync_transfer.error.no_pending')
                  : t('sync_transfer.error.tx_failed')}
          </div>
        )}

        {(isSuccess || popBSuccess) && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${isDark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-700'}`}>
            {t('sync_transfer.success', { username: username || '' })}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={handleClose}
            className={`px-4 py-2 rounded-lg text-sm transition cursor-pointer ${themeSecondaryButton(isDark)}`}
          >
            {isSuccess ? t('sync_transfer.btn.close') : t('sync_transfer.btn.later')}
          </button>
          {!isSuccess && !popBSuccess && (
            <button
              onClick={handleSync}
              disabled={isButtonDisabled}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
                isButtonDisabled
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:opacity-90'
              } ${needsChainSwitch ? 'bg-blue-500 text-white' : 'bg-yellow-500 text-black'}`}
            >
              {getButtonText()}
            </button>
          )}
        </div>
      </div>
    </ModalWrapper>
  )
}

export default SyncTransferModal
