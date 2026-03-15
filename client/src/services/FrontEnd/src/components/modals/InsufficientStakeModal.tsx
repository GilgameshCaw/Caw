import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useBalance } from 'wagmi'
import { useAccount } from 'wagmi'
import ModalWrapper from './ModalWrapper'

interface InsufficientStakeModalProps {
  isOpen: boolean
  onClose: () => void
  requiredAmount?: bigint
  currentAmount?: bigint
  actionType?: 'post' | 'like' | 'repost' | 'profile'
}

const InsufficientStakeModal: React.FC<InsufficientStakeModalProps> = ({
  isOpen,
  onClose,
  requiredAmount,
  currentAmount,
  actionType = 'post'
}) => {
  const navigate = useNavigate()
  const { address } = useAccount()

  // Fetch CAW token balance only when modal is open
  const { data: balanceData } = useBalance({
    address: address,
    token: '0xf3b9569f82b18aef890de263b84189bd33ebe452', // CAW token address on Ethereum mainnet
    query: {
      enabled: isOpen && !!address, // Only fetch when modal is open and address exists
      refetchInterval: 10000, // Refetch every 10 seconds instead of default 4 seconds
    }
  })

  const walletBalance = balanceData?.value || 0n
  // Check if user has enough CAW in wallet to cover the required stake
  const hasEnoughToBuy = requiredAmount !== undefined && walletBalance >= requiredAmount
  const hasZeroBalance = walletBalance === 0n

  const handleBuyCAW = () => {
    window.open('https://app.uniswap.org/explore/tokens/ethereum/0xf3b9569f82b18aef890de263b84189bd33ebe452', '_blank')
    onClose()
  }

  const handleStakeCAW = () => {
    navigate('/staking')
    onClose()
  }

  const getActionText = () => {
    switch (actionType) {
      case 'like':
        return 'like posts'
      case 'repost':
        return 'repost content'
      case 'profile':
        return 'update your profile'
      case 'post':
      default:
        return 'create posts'
    }
  }

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-md"
      zIndex={80}
      usePortal
      backdropClass="bg-black/50"
      className="p-6"
    >
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
            <svg className="w-9 h-9 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white">Insufficient CAW Staked</h2>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white transition-colors cursor-pointer"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Message */}
      <div className="text-center mb-6">
        <p className="text-gray-300 mb-2">
          You don't have enough CAW staked to {getActionText()}.
        </p>

        {/* Show current wallet balance */}
        <div className="bg-white/5 rounded-lg p-3 mt-3 mb-3">
          <p className="text-sm text-gray-400 mb-1">Wallet Balance:</p>
          <p className="text-lg font-semibold text-white">
            {(Number(walletBalance) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} CAW
          </p>
        </div>

        {/* Show staking requirements */}
        {currentAmount !== undefined && requiredAmount !== undefined && (
          <div className="bg-white/5 rounded-lg p-3 mb-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <p className="text-gray-400">Staked:</p>
                <p className="text-white font-medium">
                  {(Number(currentAmount) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} CAW
                </p>
              </div>
              <div>
                <p className="text-gray-400">Required:</p>
                <p className="text-yellow-500 font-medium">
                  {(Number(requiredAmount) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} CAW
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Conditional message based on balance */}
        <p className="text-sm text-gray-400 mt-3">
          {hasEnoughToBuy ? (
            <>You have enough CAW in your wallet! Stake it to start participating in the CAW ecosystem.</>
          ) : hasZeroBalance ? (
            <>You'll need to buy CAW tokens to get started with the CAW ecosystem.</>
          ) : (
            <>You have some CAW, but need more. Buy additional tokens or stake what you have.</>
          )}
        </p>
      </div>

      {/* Actions - conditional based on balance */}
      <div className="space-y-3">
        {hasEnoughToBuy ? (
          <>
            {/* Primary: Stake CAW (user has enough) */}
            <button
              onClick={handleStakeCAW}
              className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all duration-300 cursor-pointer"
            >
              Stake CAW
            </button>
            {/* Secondary: Buy more */}
            <button
              onClick={handleBuyCAW}
              className="w-full py-3 border border-white/20 hover:border-white/40 text-white font-semibold rounded-full transition-all duration-300 cursor-pointer"
            >
              Buy CAW on Uniswap
            </button>
          </>
        ) : (
          <>
            {/* Primary: Buy CAW (user doesn't have enough) */}
            <button
              onClick={handleBuyCAW}
              className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all duration-300 cursor-pointer"
            >
              Buy CAW on Uniswap
            </button>
            {/* Secondary: Stake CAW */}
            <button
              onClick={handleStakeCAW}
              className="w-full py-3 border border-white/20 hover:border-white/40 text-white font-semibold rounded-full transition-all duration-300 cursor-pointer"
            >
              Stake CAW
            </button>
          </>
        )}
        <button
          onClick={onClose}
          className="w-full py-3 text-gray-400 hover:text-white transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </ModalWrapper>
  )
}

export default InsufficientStakeModal
