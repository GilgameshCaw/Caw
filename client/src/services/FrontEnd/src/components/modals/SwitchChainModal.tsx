import React, { useState } from 'react'
import { HiSwitchHorizontal } from 'react-icons/hi'
import { useSwitchChain } from 'wagmi'
import { chains } from '~/config/chains'
import { baseSepolia } from 'wagmi/chains'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'

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
      <ModalHeader
        title="Wrong Network"
        onClose={onClose}
        icon={<HiSwitchHorizontal className="w-5 h-5 text-yellow-500" />}
        border={false}
        forceDark
      />

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
