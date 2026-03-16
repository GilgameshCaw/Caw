import React, { useState, useEffect } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { readContract } from '@wagmi/core'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatEther } from 'viem'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useSyncTransferStore } from '~/store/syncTransferStore'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawNameAbi, cawNameQuoterAbi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'

const SyncTransferModal: React.FC = () => {
  const { isDark } = useTheme()
  const { isOpen, tokenId, username, close } = useSyncTransferStore()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const { writeContract, data: hash, isPending: isSubmitting, error: writeError, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

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
      abi: cawNameQuoterAbi,
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
    if (!isConnected) {
      openConnectModal?.()
      return
    }

    if (needsChainSwitch) {
      switchChain({ chainId: chains.l1.chainId })
      return
    }

    writeContract({
      address: CAW_NAMES_ADDRESS,
      abi: cawNameAbi,
      functionName: 'syncTransfer',
      args: [chains.l2.layerZero, 0n] as [number, bigint],
      value: lzFee ?? 0n,
      chainId: chains.l1.chainId
    })
  }

  const getButtonText = () => {
    if (!isConnected) return 'Connect Wallet'
    if (needsChainSwitch) return isSwitchingChain ? 'Switching...' : 'Switch to Sepolia'
    if (isQuoting) return 'Estimating fee...'
    if (isSubmitting) return 'Confirm in wallet...'
    if (isConfirming) return 'Syncing...'
    if (isSuccess) return 'Synced!'
    return 'Sync Ownership'
  }

  const isButtonDisabled = isSubmitting || isConfirming || isSuccess || isSwitchingChain || isQuoting

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-md" usePortal zIndex={9999}>
      <div className="p-6">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Sync Ownership
            </h2>
          </div>
          <button
            onClick={handleClose}
            className={`transition-colors cursor-pointer ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className={`text-sm mb-4 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          <span className="font-semibold">@{username}</span> (Token #{tokenId}) was transferred to your wallet,
          but the L2 network hasn't been updated yet. To use this account, you need to sync ownership.
        </p>

        <p className={`text-xs mb-5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          This sends a cross-chain message to update your ownership on L2. It requires a small ETH transaction on Sepolia.
        </p>

        {/* Show LZ fee estimate */}
        {lzFee !== null && lzFee > 0n && (
          <div className={`mb-4 p-3 rounded-lg text-xs ${isDark ? 'bg-white/5 text-gray-400' : 'bg-gray-50 text-gray-500'}`}>
            Sync fee: ~{formatEther(lzFee)} ETH
          </div>
        )}

        {writeError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
            {writeError.message?.includes('User rejected')
              ? 'Transaction rejected'
              : writeError.message?.includes('no pending transfers')
                ? 'No pending transfers to sync'
                : 'Transaction failed. Please try again.'}
          </div>
        )}

        {isSuccess && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${isDark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-700'}`}>
            Ownership synced! You can now use @{username} on L2.
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
            {isSuccess ? 'Close' : 'Later'}
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
