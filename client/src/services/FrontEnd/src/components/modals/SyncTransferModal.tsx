import React, { useState, useEffect } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { readContract } from '@wagmi/core'
import { formatEther } from 'viem'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeTextSecondary, themeTextMuted, themeBgSubtle, themeSecondaryButton } from '~/utils/theme'
import { useSyncTransferStore } from '~/store/syncTransferStore'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'
import { usePriceStore } from '~/store/tokenDataStore'

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
      args: [0, '0x0000000000000000000000000000000000000000', false],
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
    close()
  }

  const handleSync = async () => {
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

  const getButtonText = () => {
    if (needsChainSwitch) return isSwitchingChain ? t('sync_transfer.btn.switching') : t('sync_transfer.btn.switch_network')
    if (isQuoting) return t('sync_transfer.btn.estimating_fee')
    if (isSubmitting) return t('sync_transfer.btn.confirm_in_wallet')
    if (isConfirming) return t('sync_transfer.btn.syncing')
    if (isSuccess) return t('sync_transfer.btn.synced')
    return t('sync_transfer.btn.sync')
  }

  const isButtonDisabled = isSubmitting || isConfirming || isSuccess || isSwitchingChain || isQuoting

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
            {t('sync_transfer.fee_label')}: ~{formatEther(lzFee)} ETH{ethPrice > 0 && ` (~$${(Number(formatEther(lzFee)) * ethPrice).toFixed(2)})`}
          </div>
        )}

        {writeError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
            {writeError.message?.includes('User rejected')
              ? t('sync_transfer.error.tx_rejected')
              : writeError.message?.includes('no pending transfers')
                ? t('sync_transfer.error.no_pending')
                : t('sync_transfer.error.tx_failed')}
          </div>
        )}

        {isSuccess && (
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
          {!isSuccess && (
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
