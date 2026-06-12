/**
 * UsernamePreviewCard — the left-column NFT-style username preview card.
 *
 * Extracted from Profile/New.tsx (the /usernames/new page) so the onboarding
 * username step can reuse the EXACT same card + styling rather than rebuild it.
 * Presentational: takes `username` + display flags, no hooks beyond i18n/theme/
 * network detection (all cheap, read-only).
 *
 * New.tsx renders it with the heading + faucet/marketplace links + sticky column
 * (showHeading / showFaucetLink / showMarketplaceLink / stickyColumn = true).
 * The onboarding step renders just the card + SVG (those flags false).
 */

import { Link } from 'react-router-dom'
import UsernameSvg from '~/components/UsernameSvg'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { chains } from '~/config/chains'

export interface UsernamePreviewCardProps {
  username: string
  /** Show the "Create your CAW Profile" heading + subtitle. Default true. */
  showHeading?: boolean
  /** Show the faucet (testnet) / Uniswap (mainnet) CTA below the SVG. Default true. */
  showFaucetLink?: boolean
  /** Show the marketplace link. Default true. */
  showMarketplaceLink?: boolean
  /** Wrap in the sticky 45%-width column (New.tsx two-column layout). Default true. */
  stickyColumn?: boolean
}

const isTestnet = (chains.l1.chainId as number) !== 1

export default function UsernamePreviewCard({
  username,
  showHeading = true,
  showFaucetLink = true,
  showMarketplaceLink = true,
  stickyColumn = true,
}: UsernamePreviewCardProps) {
  const { isDark } = useTheme()
  const t = useT()

  const cardClass = `px-6 py-6 rounded-2xl backdrop-blur-sm ${
    isDark ? 'bg-white/[0.04] border border-white/10' : 'bg-black/[0.03] border border-black/10'
  }`

  return (
    <div className={stickyColumn ? 'w-full md:w-[45%] md:sticky md:top-8 md:pr-8' : ''}>
      <div className={cardClass}>
        {showHeading && (
          <div className="text-center space-y-3">
            <h1 className="text-4xl font-bold">{t('new_profile.create_profile_heading')}</h1>
            <p className="text-gray-400 text-sm mx-auto" style={{ width: '85%' }}>
              {t('new_profile.create_profile_subtitle')}
            </p>
          </div>
        )}

        {/* Username SVG preview */}
        <div className={`flex justify-center items-center mb-6 ${showHeading ? 'mt-6' : ''}`}>
          <div className="w-64 h-64 overflow-hidden" style={{ borderRadius: '22px' }}>
            <UsernameSvg username={username || 'username'} textOpacity={username ? 1 : 0.5} />
          </div>
        </div>

        {(showFaucetLink || showMarketplaceLink) && (
          <div className="text-center">
            {showFaucetLink && (
              isTestnet ? (
                <Link
                  to="/faucet"
                  className={`inline-flex items-center justify-center px-4 py-2 rounded-full text-sm font-semibold transition-colors cursor-pointer ${
                    isDark
                      ? 'bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25'
                      : 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'
                  }`}
                >
                  {t('new_profile.claim_mcaw')}
                </Link>
              ) : (
                <a
                  href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-yellow-500/70 hover:text-yellow-500 transition-colors cursor-pointer"
                >
                  {t('new_profile.need_more_caw')}
                </a>
              )
            )}
            {showMarketplaceLink && (
              <Link to="/usernames" className="block mt-2 text-sm text-gray-400 hover:text-gray-300 transition-colors">
                {t('new_profile.marketplace_link')}
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
