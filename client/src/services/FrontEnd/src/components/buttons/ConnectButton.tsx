import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { sepolia } from "wagmi/chains";
import { useConnectModalBridge } from "~/hooks/useConnectModalBridge";

/**
 * Connect Wallet / Wrong Network button.
 *
 * Replaced ConnectButton.Custom from @rainbow-me/rainbowkit with pure wagmi
 * hooks so this component no longer requires RainbowKitProvider to be mounted.
 * Behaviour is identical to the previous implementation:
 *   - Not connected → "Connect Wallet" button (opens connect modal via bridge)
 *   - Wrong chain   → "Wrong network" button (switches to Sepolia)
 *   - Connected + correct chain → null
 */
const ConnectButton = () => {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const { openConnectModal } = useConnectModalBridge()

  const isUnsupported = isConnected && chainId !== sepolia.id

  if (!isConnected) {
    return (
      <button onClick={openConnectModal} type="button" className="btn btn-connect">
        Connect Wallet
      </button>
    )
  }

  if (isUnsupported) {
    return (
      <button
        onClick={() => switchChain({ chainId: sepolia.id })}
        type="button"
        className="btn btn-connect"
      >
        Wrong network
      </button>
    )
  }

  return null
}

export default ConnectButton;
