import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useReadContract, useAccount } from 'wagmi'
import { erc20Abi } from 'viem'
import { CAW_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import ModalWrapper from './ModalWrapper'

interface InsufficientStakeModalProps {
  isOpen: boolean
  onClose: () => void
  requiredAmount?: bigint
  currentAmount?: bigint
  actionType?: 'post' | 'like' | 'repost' | 'profile'
  /** Override default stake navigation (e.g. to jump to onboarding stake step) */
  onStake?: () => void
}

const InsufficientStakeModal: React.FC<InsufficientStakeModalProps> = ({
  isOpen,
  onClose,
  requiredAmount,
  currentAmount,
  actionType = 'post',
  onStake,
}) => {
  const navigate = useNavigate()
  const { address } = useAccount()

  // Read CAW ERC-20 balance from the configured L1 chain (mainnet in prod,
  // Sepolia in dev/testnet). Previously hard-coded to the mainnet CAW token
  // address, which returned 0 on testnet. Using the same per-env CAW_ADDRESS
  // + chainId pair that the Staking page uses.
  const { data: balanceData } = useReadContract({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    chainId: chains.l1.chainId,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: isOpen && !!address,
      refetchInterval: 10000,
    },
  })

  const walletBalance = (balanceData as bigint | undefined) || 0n
  // Check if user has enough CAW in wallet to cover the required stake
  const hasEnoughToBuy = requiredAmount !== undefined && walletBalance >= requiredAmount
  const hasZeroBalance = walletBalance === 0n

  const handleBuyCAW = () => {
    window.open('https://app.uniswap.org/explore/tokens/ethereum/0xf3b9569f82b18aef890de263b84189bd33ebe452', '_blank')
    onClose()
  }

  const handleStakeCAW = () => {
    if (onStake) {
      onStake()
    } else {
      navigate('/staking')
    }
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
      zIndex={110}
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
          <h2 className="text-xl font-bold text-white">Insufficient CAW Deposited</h2>
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
          You don't have enough CAW deposited to {getActionText()}.
        </p>

        {/* Show current wallet balance */}
        <div className="bg-white/5 rounded-lg p-3 mt-3 mb-3">
          <p className="text-sm text-gray-400 mb-1">Wallet Balance:</p>
          <p className="text-lg font-semibold text-white">
            {(Number(walletBalance) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} CAW
          </p>
        </div>

        {/* Show remaining budget vs required cost. currentAmount here is the
            effective budget = onChainStake + pendingDepositAmount - pendingSpend,
            so it reflects what the user has LEFT after already-queued actions. */}
        {currentAmount !== undefined && requiredAmount !== undefined && (
          <div className="bg-white/5 rounded-lg p-3 mb-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <p className="text-gray-400">Remaining:</p>
                <p className="text-white font-medium">
                  {(Number(currentAmount) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 })} CAW
                </p>
              </div>
              <div>
                <p className="text-gray-400">This costs:</p>
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
            <>You have enough CAW in your wallet! Deposit it to start participating in the CAW ecosystem.</>
          ) : hasZeroBalance ? (
            <>You'll need to buy CAW tokens to get started with the CAW ecosystem.</>
          ) : (
            <>You have some CAW, but need more. Buy additional tokens or deposit what you have.</>
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
              Deposit CAW
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
              Deposit CAW
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
