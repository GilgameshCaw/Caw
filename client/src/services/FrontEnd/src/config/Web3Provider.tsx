import { lazy, Suspense, Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { wagmiConfig } from "~/config/wagmiConfig";
import { useConnectModalStore } from "~/store/connectModalStore";

// Re-export wagmiConfig so existing importers (api/actions.ts, modals,
// instanceStore, etc.) can keep their `import { wagmiConfig } from
// '~/config/Web3Provider'` without changes.
export { wagmiConfig };

/**
 * Local ErrorBoundary for the lazy RainbowKit mount.
 *
 * The VITE_PROJECT_ID throw in RainbowKitLayer fires when the lazy chunk
 * first loads (on first Connect click). Without this boundary the error
 * bubbles to the root Sentry.ErrorBoundary and replaces the WHOLE app.
 * With this boundary only the wallet-connect UI fails; the feed and all
 * non-wallet routes remain functional.
 */
interface RkErrorBoundaryState { error: Error | null }
class RkErrorBoundary extends Component<{ children: ReactNode }, RkErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error): RkErrorBoundaryState {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to console so it is visible in operator logs even without Sentry.
    console.error('[RkErrorBoundary] RainbowKit layer failed to load:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: 'none' }} aria-hidden="true" data-rk-error={this.state.error.message} />
      )
    }
    return this.props.children
  }
}

// RainbowKitLayer is lazy — it's the ~2.6MB vendor-rainbowkit chunk.
// It only mounts when a wallet-connect flow is first invoked
// (mountRequested flips in connectModalStore). Population-B passkey
// users and feed-read-only sessions never trigger it.
const RainbowKitLayer = lazy(() => import("~/config/RainbowKitLayer"));

interface Web3ProviderProps {
  children: React.ReactNode;
  queryClient: QueryClient;
}

/**
 * Always-on layer: WagmiProvider + QueryClientProvider.
 * These are needed on EVERY route including passkey onboarding.
 *
 * Lazily-mounted layer: RainbowKitProvider (inside RainbowKitLayer).
 * Only rendered once connectModalStore.mountRequested becomes true —
 * triggered when any caller invokes openConnectModal via the bridge.
 *
 * The Suspense boundary wrapping RainbowKitLayer uses null fallback:
 * the layer is mounted in response to a user action (clicking "Connect
 * Wallet"), so the brief chunk-fetch delay (~50–200ms) is imperceptible.
 */
function RainbowKitMount() {
  const mountRequested = useConnectModalStore(s => s.mountRequested)
  if (!mountRequested) return null
  return (
    <Suspense fallback={null}>
      <RainbowKitLayer />
    </Suspense>
  )
}

export default function Web3Provider({ children, queryClient }: Web3ProviderProps) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
        {/* RainbowKit layer rendered AFTER children so it doesn't delay
            the main content. It mounts lazily beside the app tree and
            provides the connect modal context via connectModalStore bridge.
            It has no visible UI of its own — only the modal it opens.
            RkErrorBoundary catches VITE_PROJECT_ID throws and any other
            RK init errors so only the wallet UI fails, not the whole app. */}
        <RkErrorBoundary>
          <RainbowKitMount />
        </RkErrorBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
