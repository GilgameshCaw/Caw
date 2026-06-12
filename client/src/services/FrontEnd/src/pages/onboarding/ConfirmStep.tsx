/**
 * ConfirmStep.tsx
 *
 * Final step of /onboarding: shows the confirmed tx hash and provides
 * a "Continue to feed" button that navigates to /.
 *
 * This step is reached only after bootstrapNewUser() has returned a txHash,
 * so the tx is already in the mempool (or confirmed, depending on whether
 * the sponsor waits for a receipt). We display it as informational
 * without blocking navigation on confirmation — the user can continue
 * while the tx finalizes.
 */

import { sepolia } from 'wagmi/chains'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useNavigate } from '~/utils/localizedRouter'

export interface ConfirmStepProps {
  username: string
  txHash: string
  /** True while the post-mint sign-in is still establishing a session. */
  signingIn?: boolean
}

// The sponsored bootstrap tx lands on Ethereum L1 (Sepolia on testnet), so the
// block explorer is sepolia.etherscan.io. Pulled from the wagmi chain so it
// tracks the network rather than being hardcoded.
const EXPLORER_TX_BASE = `${sepolia.blockExplorers.default.url}/tx/`

export default function ConfirmStep({ username, txHash, signingIn = false }: ConfirmStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  return (
    <div className="space-y-6 text-center">
      <div>
        <h2 className={`text-2xl font-bold mb-2 ${strongClass}`}>
          {t('onboarding.confirm.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.confirm.subtitle', { username })}
        </p>
      </div>

      {/* Transaction — link out to the block explorer rather than showing a
          raw truncated hash (nothing the user can do with the hex string). */}
      <div className={`rounded-xl p-4 text-left space-y-2 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <p className={`text-xs font-medium ${mutedClass}`}>
          {t('onboarding.confirm.tx_label')}
        </p>
        <a
          href={`${EXPLORER_TX_BASE}${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 text-sm font-medium ${
            isDark ? 'text-yellow-400 hover:text-yellow-300' : 'text-yellow-600 hover:text-yellow-700'
          }`}
        >
          {t('onboarding.confirm.view_on_explorer')}
          <span aria-hidden="true">↗</span>
        </a>
        <p className={`text-xs ${mutedClass}`}>
          {t('onboarding.confirm.tx_note')}
        </p>
      </div>

      <button
        onClick={() => navigate('/')}
        disabled={signingIn}
        className="w-full py-3 rounded-full font-semibold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
      >
        {signingIn
          ? t('onboarding.confirm.signing_in')
          : t('onboarding.confirm.cta')}
      </button>
    </div>
  )
}
