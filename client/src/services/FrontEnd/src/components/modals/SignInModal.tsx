import { Link, useNavigate } from '~/utils/localizedRouter'
import { useAccount } from 'wagmi'
import { useActiveToken } from '~/store/tokenDataStore'
import { useSignInModalStore } from '~/store/signInModalStore'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import ModalWrapper from './ModalWrapper'
import { useT } from '~/i18n/I18nProvider'

interface SignInModalProps {
  isOpen?: boolean
  onClose?: () => void
  message?: string
}

/**
 * Modal that prompts unauthenticated users to connect a wallet and create a username.
 * Can be used standalone (with isOpen/onClose props) or via the global useSignInModalStore.
 */
export default function SignInModal({ isOpen: propIsOpen, onClose: propOnClose, message: propMessage }: SignInModalProps) {
  const t = useT()
  const { isConnected } = useAccount()
  const ensureWallet = useEnsureWallet()
  const activeToken = useActiveToken()
  const store = useSignInModalStore()
  const navigate = useNavigate()

  // Support both prop-driven and store-driven usage
  const isOpen = propIsOpen ?? store.isOpen
  const onClose = propOnClose ?? store.close
  const message = propMessage ?? store.message

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
            {t('signin_modal.title')}
          </h3>
          <p className="text-sm text-white/60">
            {message || t('signin_modal.default_message')}
          </p>
        </div>

        {!isConnected ? (
          <div className="space-y-3">
            <button
              onClick={() => {
                ensureWallet(null, async () => {})
                onClose()
              }}
              className="w-full py-3 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors cursor-pointer"
            >
              {t('common.sign_in')}
            </button>
            {/* Card-payment path: generates a fresh EOA, user buys ETH from
                Moonpay and continues into the normal Pop A mint flow.
                Only rendered when the operator has configured a Moonpay
                key on this install — mirrors without Moonpay biz
                registration see no card-payment UI. */}
            {import.meta.env.VITE_MOONPAY_API_KEY && (
              <button
                onClick={() => {
                  onClose()
                  navigate('/onboarding/onramp')
                }}
                className="w-full py-2.5 text-sm font-semibold rounded-full border border-yellow-500/40 text-yellow-500 hover:bg-yellow-500/10 transition-colors cursor-pointer"
              >
                {t('signin_modal.buy_with_card')}
              </button>
            )}
          </div>
        ) : !activeToken?.username ? (
          <Link
            to="/usernames/new"
            onClick={onClose}
            className="block w-full py-3 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors text-center"
          >
            {t('signin_modal.create_profile')}
          </Link>
        ) : (
          <button
            onClick={onClose}
            className="w-full py-3 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors cursor-pointer"
          >
            {t('common.continue')}
          </button>
        )}

        <button
          onClick={onClose}
          className="w-full py-2.5 text-sm text-white/50 hover:text-white/80 transition-colors cursor-pointer"
        >
          {t('common.cancel')}
        </button>
      </div>
    </ModalWrapper>
  )
}
