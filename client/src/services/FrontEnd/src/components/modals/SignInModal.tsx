import { Link } from 'react-router-dom'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { useActiveToken } from '~/store/tokenDataStore'
import ModalWrapper from './ModalWrapper'

interface SignInModalProps {
  isOpen: boolean
  onClose: () => void
  message?: string
}

/**
 * Modal that prompts unauthenticated users to connect a wallet and create a username.
 * Shown when they try to interact with gated content (e.g. view replies).
 */
export default function SignInModal({ isOpen, onClose, message }: SignInModalProps) {
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const activeToken = useActiveToken()

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-sm">
      <div className="p-6 space-y-5">
        <div className="text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-yellow-500/20 flex items-center justify-center">
            <svg className="w-7 h-7 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-white mb-2">
            Sign in to continue
          </h3>
          <p className="text-sm text-white/60">
            {message || 'Connect your wallet and create a username to unlock this content.'}
          </p>
        </div>

        {!isConnected ? (
          <button
            onClick={() => {
              openConnectModal?.()
              onClose()
            }}
            className="w-full py-3 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors cursor-pointer"
          >
            Connect Wallet
          </button>
        ) : !activeToken?.username ? (
          <Link
            to="/usernames/new"
            onClick={onClose}
            className="block w-full py-3 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors text-center"
          >
            Create Your Profile
          </Link>
        ) : (
          <button
            onClick={onClose}
            className="w-full py-3 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors cursor-pointer"
          >
            Continue
          </button>
        )}

        <button
          onClick={onClose}
          className="w-full py-2.5 text-sm text-white/50 hover:text-white/80 transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </ModalWrapper>
  )
}
