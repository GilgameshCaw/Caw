import React, { useState, useEffect } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { readContract } from '@wagmi/core'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { isAddress, formatEther } from 'viem'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useTransferModalStore } from '~/store/transferModalStore'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawNameAbi, cawNameQuoterAbi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'

const TransferNFTModal: React.FC = () => {
  const { isDark } = useTheme()
  const { isOpen, tokenId, username, close } = useTransferModalStore()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const { writeContract, data: hash, isPending: isSubmitting, error: writeError, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

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
      abi: cawNameQuoterAbi,
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
      setInputError('Address is required')
      return false
    }
    if (!isAddress(value)) {
      setInputError('Invalid Ethereum address')
      return false
    }
    if (value.toLowerCase() === address?.toLowerCase()) {
      setInputError('Cannot transfer to yourself')
      return false
    }
    setInputError(null)
    return true
  }

  const handleTransfer = async () => {
    if (!isConnected) {
      openConnectModal?.()
      return
    }

    if (needsChainSwitch) {
      switchChain({ chainId: chains.l1.chainId })
      return
    }

    if (!validateRecipient(recipient)) return
    if (!address || tokenId === null) return

    // Use transferAndSync to transfer + sync L2 ownership in one tx
    writeContract({
      address: CAW_NAMES_ADDRESS,
      abi: cawNameAbi,
      functionName: 'transferAndSync',
      args: [recipient as `0x${string}`, BigInt(tokenId), 0n],
      value: lzFee ?? 0n,
      chainId: chains.l1.chainId
    })
  }

  const getButtonText = () => {
    if (!isConnected) return 'Connect Wallet'
    if (needsChainSwitch) return isSwitchingChain ? 'Switching...' : 'Switch to Sepolia'
    if (isQuoting) return 'Estimating fee...'
    if (isSubmitting) return 'Confirm in wallet...'
    if (isConfirming) return 'Confirming...'
    if (isSuccess) return 'Transferred!'
    return 'Transfer'
  }

  const isButtonDisabled = isSubmitting || isConfirming || isSuccess || isSwitchingChain || isQuoting

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-md" usePortal zIndex={9999}>
      <div className="p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Transfer NFT
          </h2>
          <button
            onClick={handleClose}
            className={`transition-colors cursor-pointer ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className={`text-sm mb-1 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          Transfer <span className="font-semibold">@{username}</span> (Token #{tokenId}) to another wallet.
        </p>
        <p className={`text-xs mb-5 ${isDark ? 'text-yellow-500/80' : 'text-yellow-600'}`}>
          This is irreversible. You will lose ownership of this account.
        </p>

        {!isSuccess && (
          <div className="mb-5">
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              Recipient Address
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
              <p className="mt-1 text-xs text-red-500">{inputError}</p>
            )}
          </div>
        )}

        {/* Show LZ fee estimate */}
        {!isSuccess && lzFee !== null && lzFee > 0n && (
          <div className={`mb-4 p-3 rounded-lg text-xs ${isDark ? 'bg-white/5 text-gray-400' : 'bg-gray-50 text-gray-500'}`}>
            L2 sync fee: ~{formatEther(lzFee)} ETH
            <span className={`block mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              This covers the cross-chain message to update ownership on L2.
            </span>
          </div>
        )}

        {writeError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
            {writeError.message?.includes('User rejected')
              ? 'Transaction rejected'
              : writeError.message?.includes('caller is not the token owner')
                ? 'You are not the owner of this token'
                : 'Transaction failed. Please try again.'}
          </div>
        )}

        {isSuccess && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${isDark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-700'}`}>
            Transfer successful! @{username} has been transferred and L2 ownership has been synced.
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={handleClose}
            className={`px-4 py-2 rounded-lg text-sm transition cursor-pointer ${
              isDark
                ? 'bg-white/10 hover:bg-white/20 text-white'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
            }`}
          >
            {isSuccess ? 'Close' : 'Cancel'}
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
