import { ConnectButton } from '@rainbow-me/rainbowkit'
import WalletIcon from '~/components/icons/WalletIcon'
import { useTheme } from '~/hooks/useTheme'

/**
 * Compact wallet pill for captive surfaces (splash, post-mint onboarding,
 * captive bottom bar). Renders a wallet icon when a wallet is connected;
 * clicking opens RainbowKit's account modal where Disconnect lives.
 *
 * Renders nothing when no wallet is connected — the splash/captive bar
 * already has its own primary "Sign In" CTA for that state.
 */
const WalletAccountButton = () => {
  const { isDark } = useTheme()

  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, authenticationStatus, mounted }) => {
        const ready = mounted && authenticationStatus !== 'loading'
        const connected =
          ready && account && chain && (!authenticationStatus || authenticationStatus === 'authenticated')

        if (!connected) return null

        const onClick = chain.unsupported ? openChainModal : openAccountModal
        const label = chain.unsupported ? 'Wrong network' : (account.displayName || 'Wallet')

        return (
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors cursor-pointer border ${
              chain.unsupported
                ? 'bg-red-500/15 text-red-400 border-transparent hover:border-red-400/60'
                : isDark
                  ? 'bg-white/10 text-white border-transparent hover:border-white/40'
                  : 'bg-black/5 text-black border-transparent hover:border-black/30'
            }`}
          >
            <WalletIcon className="w-5 h-5" />
          </button>
        )
      }}
    </ConnectButton.Custom>
  )
}

export default WalletAccountButton
