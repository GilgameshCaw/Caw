import React, { useState, useEffect } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { readContract } from '@wagmi/core'
import { isAddress, formatEther } from 'viem'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeTextSecondary, themeTextMuted, themeBgSubtle, themeSecondaryButton } from '~/utils/theme'
import { useTransferModalStore } from '~/store/transferModalStore'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'
import { usePriceStore } from '~/store/tokenDataStore'

const TransferNFTModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { isOpen, tokenId, username, close } = useTransferModalStore()
  const { address, isConnected } = useAccount()
  const ensureWallet = useEnsureWallet()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const { writeContract, data: hash, isPending: isSubmitting, error: writeError, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)

  const [recipient, setRecipient] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [lzFee, setLzFee] = useState<bigint | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)

  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  // Quote the LZ fee when recipient changes and is valid
  useEffect(() => {
    if (!isOpen || !recipient || !isAddress(recipient) || tokenId === null) {
      setLzFee(null)
      return
    }

    let cancelled = false
    setIsQuoting(true)

    readContract(wagmiConfig, {
      address: CAW_NAME_QUOTER_ADDRESS,
      abi: cawProfileQuoterAbi,
      functionName: 'syncTransferQuote',
      args: [tokenId, recipient as `0x${string}`, false],
      chainId: chains.l1.chainId
    })
      .then((quote: any) => {
        if (!cancelled) {
          // Add 10% buffer for fee fluctuation
          const fee = (quote.nativeFee * 110n) / 100n
          setLzFee(fee)
        }
      })
      .catch((err) => {
        console.warn('[Transfer] Failed to quote LZ fee:', err)
        if (!cancelled) setLzFee(null)
      })
      .finally(() => {
        if (!cancelled) setIsQuoting(false)
      })

    return () => { cancelled = true }
  }, [isOpen, recipient, tokenId])

  const handleClose = () => {
    setRecipient('')
    setInputError(null)
    setLzFee(null)
    reset()
    close()
  }

  const validateRecipient = (value: string): boolean => {
    if (!value.trim()) {
      setInputError(t('transfer_nft.error.address_required'))
      return false
    }
    if (!isAddress(value)) {
      setInputError(t('transfer_nft.error.invalid_address'))
      return false
    }
    if (value.toLowerCase() === address?.toLowerCase()) {
      setInputError(t('transfer_nft.error.cannot_self'))
      return false
    }
    setInputError(null)
    return true
  }

  const handleTransfer = async () => {
    await ensureWallet({ chainId: chains.l1.chainId }, async () => {
      if (!validateRecipient(recipient)) return
      if (!address || tokenId === null) return

      // Use transferAndSync to transfer + sync L2 ownership in one tx
      writeContract({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
        functionName: 'transferAndSync',
        args: [recipient as `0x${string}`, BigInt(tokenId), 0n],
        value: lzFee ?? 0n,
        chainId: chains.l1.chainId
      })
    })
  }

  const getButtonText = () => {
    if (needsChainSwitch) return isSwitchingChain ? t('transfer_nft.btn.switching') : t('transfer_nft.btn.switch_network')
    if (isQuoting) return t('transfer_nft.btn.estimating_fee')
    if (isSubmitting) return t('transfer_nft.btn.confirm_in_wallet')
    if (isConfirming) return t('transfer_nft.btn.confirming')
    if (isSuccess) return t('transfer_nft.btn.transferred')
    return t('transfer_nft.btn.transfer')
  }

  const isButtonDisabled = isSubmitting || isConfirming || isSuccess || isSwitchingChain || isQuoting

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-md" usePortal zIndex={9999}>
      <div className="p-6">
        <ModalHeader title={t('transfer_nft.title')} onClose={handleClose} border={false} size="lg" className="mb-4 px-0" />

        <p className={`text-sm mb-1 ${themeTextSecondary(isDark)}`}>
          {t('transfer_nft.intro_before')}<span className="font-semibold">@{username}</span>{t('transfer_nft.intro_token', { tokenId: tokenId ?? '' })}
        </p>
        <p className={`text-xs mb-5 ${isDark ? 'text-yellow-500/80' : 'text-yellow-600'}`}>
          {t('transfer_nft.warning')}
        </p>

        {!isSuccess && (
          <div className="mb-5">
            <label className={`block text-sm font-medium mb-2 ${themeTextSecondary(isDark)}`}>
              {t('transfer_nft.recipient_label')}
            </label>
            <input
              type="text"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value)
                if (inputError) setInputError(null)
              }}
              placeholder="0x..."
              disabled={isSubmitting || isConfirming}
              className={`w-full px-3 py-2 rounded-lg text-sm font-mono transition ${
                isDark
                  ? 'bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:border-yellow-500/50'
                  : 'bg-gray-50 border border-gray-200 text-gray-900 placeholder-gray-400 focus:border-yellow-500'
              } ${inputError ? (isDark ? 'border-red-500/50' : 'border-red-400') : ''} outline-none`}
            />
            {inputError && (
              <p className="mt-1 text-xs text-error-dim">{inputError}</p>
            )}
          </div>
        )}

        {/* Show LZ fee estimate */}
        {!isSuccess && lzFee !== null && lzFee > 0n && (
          <div className={`mb-4 p-3 rounded-lg text-xs ${themeBgSubtle(isDark)} ${themeTextMuted(isDark)}`}>
            {t('transfer_nft.l2_fee_label')}: ~{formatEther(lzFee)} ETH{ethPrice > 0 && ` (~$${(Number(formatEther(lzFee)) * ethPrice).toFixed(2)})`}
            <span className={`block mt-1 ${themeTextMuted(isDark)}`}>
              {t('transfer_nft.l2_fee_note')}
            </span>
          </div>
        )}

        {writeError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-error-dim text-sm">
            {writeError.message?.includes('User rejected')
              ? t('transfer_nft.error.tx_rejected')
              : writeError.message?.includes('caller is not the token owner')
                ? t('transfer_nft.error.not_owner')
                : t('transfer_nft.error.tx_failed')}
          </div>
        )}

        {isSuccess && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${isDark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-700'}`}>
            {t('transfer_nft.success', { username: username || '' })}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={handleClose}
            className={`px-4 py-2 rounded-lg text-sm transition cursor-pointer ${themeSecondaryButton(isDark)}`}
          >
            {isSuccess ? t('transfer_nft.btn.close') : t('transfer_nft.btn.cancel')}
          </button>
          {!isSuccess && (
            <button
              onClick={handleTransfer}
              disabled={isButtonDisabled}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
                isButtonDisabled
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:opacity-90'
              } ${needsChainSwitch ? 'bg-blue-500 text-white' : 'bg-red-500 text-white'}`}
            >
              {getButtonText()}
            </button>
          )}
        </div>
      </div>
    </ModalWrapper>
  )
}

export default TransferNFTModal
