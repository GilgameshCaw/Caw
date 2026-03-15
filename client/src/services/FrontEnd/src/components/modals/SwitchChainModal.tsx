import React, { useState } from 'react'
import { HiX, HiSwitchHorizontal } from 'react-icons/hi'
import { useSwitchChain } from 'wagmi'
import { chains } from '~/config/chains'
import { baseSepolia } from 'wagmi/chains'
import ModalWrapper from './ModalWrapper'

// Get chain name from wagmi chain definition
const l2ChainName = baseSepolia.name

interface SwitchChainModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess?: () => void
}

const SwitchChainModal: React.FC<SwitchChainModalProps> = ({
  isOpen,
  onClose,
  onSuccess
}) => {
  const { switchChain } = useSwitchChain()
  const [isSwitching, setIsSwitching] = useState(false)

  const handleSwitch = async () => {
    setIsSwitching(true)
    try {
      await switchChain({ chainId: chains.l2.chainId })
      onSuccess?.()
      onClose()
    } catch (err) {
      console.error('Failed to switch chain:', err)
    } finally {
      setIsSwitching(false)
    }
  }

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-sm"
      zIndex={80}
      usePortal
      backdropClass="bg-black/60"
      className="shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-yellow-500/20">
            <HiSwitchHorizontal className="w-5 h-5 text-yellow-500" />
          </div>
          <h3 className="text-lg font-semibold text-white">
            Wrong Network
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-full transition-colors text-white/60 hover:text-white hover:bg-white/10"
        >
          <HiX className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="px-4 pb-4">
        <p className="text-sm mb-4 text-white/70">
          You need to switch to {l2ChainName} to perform this action.
        </p>

        <p className="text-xs mb-4 text-white/40">
          Actions like posting, liking, and following happen on {l2ChainName} for lower gas fees.
        </p>

        {/* Button */}
        <button
          onClick={handleSwitch}
          disabled={isSwitching}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSwitching ? 'Switching...' : `Switch to ${l2ChainName}`}
        </button>
      </div>
    </ModalWrapper>
  )
}

export default SwitchChainModal
