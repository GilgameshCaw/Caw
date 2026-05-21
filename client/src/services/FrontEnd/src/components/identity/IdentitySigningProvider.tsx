/**
 * IdentitySigningProvider.tsx
 *
 * Thin context that tracks whether a passkey signing ceremony is in
 * progress. Hooks (useSponsorDeposit, useSponsorAuthenticate, etc.)
 * call `start` before invoking navigator.credentials.get() and `stop`
 * once the assertion resolves or rejects.
 *
 * The visual indicator (IdentitySigningOverlay) is rendered once at the
 * app root so it doesn't need to be mounted inside each dialog.
 *
 * Usage in hooks:
 *   const { startSigning, stopSigning } = useIdentitySigning()
 *   startSigning('Please authenticate with your passkey')
 *   try { await signWithPasskey(...) } finally { stopSigning() }
 *
 * Usage in the app root:
 *   <IdentitySigningProvider>
 *     <App />
 *   </IdentitySigningProvider>
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useState,
} from 'react'
import { HiFingerPrint } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

// ─── Context ────────────────────────────────────────────────────────────────

export interface IdentitySigningState {
  isSigning: boolean
  message: string
}

export interface IdentitySigningActions {
  startSigning: (message?: string) => void
  stopSigning: () => void
}

export type IdentitySigningContextValue = IdentitySigningState & IdentitySigningActions

const DEFAULT_MESSAGE = 'Please authenticate with your passkey'

const IdentitySigningContext = createContext<IdentitySigningContextValue>({
  isSigning: false,
  message: '',
  startSigning: () => undefined,
  stopSigning: () => undefined,
})

// ─── Provider ────────────────────────────────────────────────────────────────

export function IdentitySigningProvider({
  children,
}: {
  children: React.ReactNode
}): JSX.Element {
  const [state, setState] = useState<IdentitySigningState>({
    isSigning: false,
    message: '',
  })

  const startSigning = useCallback((message: string = DEFAULT_MESSAGE) => {
    setState({ isSigning: true, message })
  }, [])

  const stopSigning = useCallback(() => {
    setState({ isSigning: false, message: '' })
  }, [])

  const value: IdentitySigningContextValue = {
    ...state,
    startSigning,
    stopSigning,
  }

  return (
    <IdentitySigningContext.Provider value={value}>
      {children}
      {state.isSigning && <IdentitySigningOverlay message={state.message} />}
    </IdentitySigningContext.Provider>
  )
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useIdentitySigning(): IdentitySigningContextValue {
  return useContext(IdentitySigningContext)
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

/**
 * Centered modal-style overlay shown while `isSigning` is true.
 * The browser's native WebAuthn sheet will appear on top of this.
 */
function IdentitySigningOverlay({ message }: { message: string }): JSX.Element {
  const { isDark } = useTheme()

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 bg-black/60"
      style={{ zIndex: 200 }}
      data-testid="identity-signing-overlay"
    >
      <div
        className={`rounded-2xl border p-8 max-w-xs w-full flex flex-col items-center gap-5 ${
          isDark
            ? 'bg-black border-yellow-500/30'
            : 'bg-white border-gray-200'
        }`}
      >
        {/* Fingerprint icon */}
        <div className={`p-4 rounded-full ${isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'}`}>
          <HiFingerPrint className="w-10 h-10 text-yellow-500" />
        </div>

        {/* Message */}
        <p className={`text-center text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {message}
        </p>

        {/* Spinner */}
        <svg
          className="animate-spin w-6 h-6 text-yellow-500"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-label="signing in progress"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      </div>
    </div>
  )
}
