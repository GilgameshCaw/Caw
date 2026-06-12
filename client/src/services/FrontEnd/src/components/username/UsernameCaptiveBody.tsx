/**
 * UsernameCaptiveBody — shared two-column layout shell for the username
 * creation flow.
 *
 * Renders:
 *   LEFT  — UsernamePreviewCard (sticky on md+), with heading / faucet /
 *            marketplace links driven by props.
 *   RIGHT — a `px-6 py-6 rounded-2xl backdrop-blur-sm` card containing:
 *             • an h2 heading (default: `new_profile.choose_username_heading`)
 *             • `{children}` — all page-specific form content (input card,
 *               deposit section, quick-sign card, submit button, etc.)
 *
 * The component owns ONLY the structural chrome (outer flex wrapper, column
 * sizing, card shell, heading). All business state stays with the caller and
 * flows in via `children`.
 *
 * Usage:
 *   <UsernameCaptiveBody username={username}>
 *     {/* the right-card inner content — input, deposit, submit, etc. *\/}
 *   </UsernameCaptiveBody>
 */

import React from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import UsernamePreviewCard from '~/components/username/UsernamePreviewCard'

export interface UsernameCaptiveBodyProps {
  /** Current username value — forwarded to the preview card. */
  username: string
  /**
   * Heading shown atop the right card.
   * Default: t('new_profile.choose_username_heading').
   */
  heading?: React.ReactNode
  /**
   * When set (sponsored / onboarding flow), records the gifted CAW amount in
   * wei. The prop is accepted for caller bookkeeping / future display; the body
   * itself does not render gift-specific UI — pass gift summary as part of
   * `children` instead.
   */
  sponsoredAmount?: bigint
  /** Show the faucet / Uniswap CTA in the left preview card. Default true. */
  showFaucetLink?: boolean
  /** Show the marketplace link in the left preview card. Default true. */
  showMarketplaceLink?: boolean
  /** Right-card body content (input card, deposit section, quick-sign, submit, etc.). */
  children: React.ReactNode
}

export default function UsernameCaptiveBody({
  username,
  heading,
  showFaucetLink = true,
  showMarketplaceLink = true,
  children,
}: UsernameCaptiveBodyProps) {
  const { isDark } = useTheme()
  const t = useT()

  const cardClass = `px-6 py-6 rounded-2xl backdrop-blur-sm ${
    isDark
      ? 'bg-white/[0.04] border border-white/10'
      : 'bg-black/[0.03] border border-black/10'
  }`

  const resolvedHeading = heading ?? t('new_profile.choose_username_heading')

  return (
    <div className="flex flex-col md:flex-row gap-8 md:gap-0 items-start md:divide-x md:divide-white/10 pt-6">
      {/* Left column — sticky NFT preview card */}
      <UsernamePreviewCard
        username={username}
        showHeading
        showFaucetLink={showFaucetLink}
        showMarketplaceLink={showMarketplaceLink}
        stickyColumn
      />

      {/* Right column — form card */}
      <div className="w-full md:w-[55%] md:min-w-[380px] md:pl-8">
        <div className={cardClass}>
          <h2 className="text-2xl font-bold text-center md:text-left mb-4 mt-2.5">
            {resolvedHeading}
          </h2>
          {children}
        </div>
      </div>
    </div>
  )
}
