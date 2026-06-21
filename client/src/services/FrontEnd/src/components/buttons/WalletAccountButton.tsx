import { useAccount, useChainId } from 'wagmi'
import { sepolia } from 'wagmi/chains'
import WalletIcon from '~/components/icons/WalletIcon'
import { useTheme } from '~/hooks/useTheme'
import { useAccountModalBridge } from '~/hooks/useConnectModalBridge'

/**
 * Compact wallet pill for captive surfaces (splash, post-mint onboarding,
 * captive bottom bar). Renders a wallet icon when a wallet is connected;
 * clicking opens RainbowKit's account modal (Disconnect lives there).
 *
 * Renders nothing when no wallet is connected — the splash/captive bar
 * already has its own primary "Sign In" CTA for that state.
 *
 * Previously used ConnectButton.Custom from @rainbow-me/rainbowkit. Now
 * uses wagmi hooks directly + the account-modal bridge to keep this
 * component off the RK static import path.
 */
const WalletAccountButton = () => {
  const { isDark } = useTheme()
  const { isConnected, address } = useAccount()
  const chainId = useChainId()
  const { openAccountModal } = useAccountModalBridge()

  if (!isConnected || !address) return null

  const isUnsupported = chainId !== sepolia.id
  const label = isUnsupported ? 'Wrong network' : 'Wallet'

  return (
    <button
      type="button"
      onClick={openAccountModal}
      aria-label={label}
      title={label}
      className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors cursor-pointer border ${
        isUnsupported
          ? 'bg-red-500/15 text-red-400 border-transparent hover:border-red-400/60'
          : isDark
            ? 'bg-white/10 text-white border-transparent hover:border-white/40'
            : 'bg-black/5 text-black border-transparent hover:border-black/30'
      }`}
    >
      <WalletIcon className="w-5 h-5" />
    </button>
  )
}

export default WalletAccountButton
