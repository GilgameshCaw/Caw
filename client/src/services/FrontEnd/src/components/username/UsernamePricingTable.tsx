/**
 * UsernamePricingTable — the per-length CAW burn-cost table shown inside the
 * pricing popover on /usernames/new (Profile/New.tsx) and the onboarding
 * username step (UsernameStep.tsx).
 *
 * Both pages rendered an identical 8-row table off the same COST_SCHEDULE; the
 * only differences were optional USD columns and an optional gift-gate dimming
 * (a row greys out when its cost exceeds the invite's gift). Both are props.
 *
 * Pure presentational: theme + i18n only. The compact strings ("1T", "240B", …)
 * are fixed display labels tied to COST_SCHEDULE and live here as the single
 * source of truth for the popover.
 */

import { COST_SCHEDULE, DEFAULT_COST } from '~/utils/cawCostSchedule'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { formatUsd } from '~/utils/numberFormat'

/** The eight popover rows, in display order. cawWhole is whole CAW (not wei). */
const ROWS: { tKey: string; cawWhole: number; compact: string }[] = [
  { tKey: 'new_profile.chars.1', cawWhole: COST_SCHEDULE[1], compact: '1T' },
  { tKey: 'new_profile.chars.2', cawWhole: COST_SCHEDULE[2], compact: '240B' },
  { tKey: 'new_profile.chars.3', cawWhole: COST_SCHEDULE[3], compact: '60B' },
  { tKey: 'new_profile.chars.4', cawWhole: COST_SCHEDULE[4], compact: '6B' },
  { tKey: 'new_profile.chars.5', cawWhole: COST_SCHEDULE[5], compact: '200M' },
  { tKey: 'new_profile.chars.6', cawWhole: COST_SCHEDULE[6], compact: '20M' },
  { tKey: 'new_profile.chars.7', cawWhole: COST_SCHEDULE[7], compact: '10M' },
  { tKey: 'new_profile.chars.8plus', cawWhole: DEFAULT_COST, compact: '1M' },
]

export interface UsernamePricingTableProps {
  /**
   * CAW price in USD. When provided, each row shows a "(~$…)" column.
   * Undefined → no USD column (New.tsx's popover omits per-row USD).
   */
  cawPriceUsd?: number
  /**
   * Invite gift in wei. When provided, rows whose whole-CAW cost exceeds the
   * gift dim to 40% opacity (the onboarding gift-gate affordance). Undefined →
   * no dimming (the /usernames/new popover, which has no gift context).
   */
  giftCaw?: bigint
}

export default function UsernamePricingTable({ cawPriceUsd, giftCaw }: UsernamePricingTableProps) {
  const { isDark } = useTheme()
  const t = useT()
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'

  return (
    <div className="space-y-2">
      {ROWS.map(({ tKey, cawWhole, compact }) => {
        const usd = cawPriceUsd !== undefined ? cawWhole * cawPriceUsd : null
        const tooExpensive = giftCaw !== undefined && BigInt(cawWhole) * 10n ** 18n > giftCaw
        return (
          <div
            key={tKey}
            className={`flex justify-between text-xs items-baseline ${tooExpensive ? 'opacity-40' : ''}`}
          >
            <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>{t(tKey)}</span>
            <span>
              <span className={`font-mono ${strongClass}`}>
                {cawPriceUsd === undefined
                  ? t('new_profile.burn_cost', { cost: compact })
                  : `${compact} CAW`}
              </span>
              {usd !== null && <span className={`${mutedClass} ml-2`}>(~${formatUsd(usd)})</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}
