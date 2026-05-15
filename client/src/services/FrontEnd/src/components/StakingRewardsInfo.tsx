import React, { useState } from 'react'
import { HiChevronDown } from 'react-icons/hi'
import { useT } from '~/i18n/I18nProvider'

interface StakingRewardsInfoProps {
  /** Always use dark styling (e.g. onboarding). Default false = theme-aware. */
  alwaysDark?: boolean
  isDark?: boolean
  /** Start collapsed. Default false (expanded). */
  defaultCollapsed?: boolean
}

const StakingRewardsInfo: React.FC<StakingRewardsInfoProps> = ({
  alwaysDark = false,
  isDark = true,
  defaultCollapsed = false,
}) => {
  const t = useT()
  const dark = alwaysDark || isDark
  const [expanded, setExpanded] = useState(!defaultCollapsed)

  const REWARDS = [
    { action: t('staking.rewards.action.post'), cost: '5,000 CAW', parts: [t('staking.rewards.split.100_depositors')] },
    { action: t('staking.rewards.action.like'), cost: '2,000 CAW', parts: [t('staking.rewards.split.80_poster'), t('staking.rewards.split.20_depositors')] },
    { action: 'ReCAW', cost: '4,000 CAW', parts: [t('staking.rewards.split.50_poster'), t('staking.rewards.split.50_depositors')] },
    { action: t('staking.rewards.action.follow'), cost: '30,000 CAW', parts: [t('staking.rewards.split.80_followed'), t('staking.rewards.split.20_depositors')] },
  ]

  return (
    <div className={`py-4 px-[10px] rounded-lg border transition-all duration-300 ${
      dark ? 'bg-[#171202]/85 border-white/20' : 'bg-yellow-50 border-gray-300'
    }`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className={`w-full flex items-center justify-between text-left cursor-pointer ${
          expanded ? 'mb-3' : ''
        }`}
        aria-expanded={expanded}
      >
        <h3 className={`text-base font-semibold transition-colors duration-300 ${
          dark ? 'text-white' : 'text-gray-900'
        }`}>
          {t('staking.rewards.heading')}
        </h3>
        <HiChevronDown
          className={`w-5 h-5 flex-shrink-0 transition-transform duration-300 ${
            dark ? 'text-gray-400' : 'text-gray-500'
          } ${expanded ? '' : '-rotate-90'}`}
        />
      </button>

      <div
        className={`grid transition-all duration-300 ease-out ${
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <ul className={`text-sm space-y-2 transition-colors duration-300 ${
            dark ? 'text-gray-300' : 'text-gray-700'
          }`}>
            {REWARDS.map(r => (
              <li key={r.action} className="flex justify-between items-start">
                <span>
                  <span className={`font-semibold ${dark ? 'text-yellow-300' : 'text-yellow-700'}`}>{r.action}:</span> {r.cost}
                </span>
                <span className={`text-xs ml-2 text-right ${dark ? 'text-yellow-500/70' : 'text-yellow-600'}`}>
                  {r.parts.map((part, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <>,<br className="[@media(min-width:380px)]:hidden" /> </>}
                      {part}
                    </React.Fragment>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className={`text-xs mt-3 ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
            {t('staking.rewards.footer')}
          </p>
        </div>
      </div>
    </div>
  )
}

export default StakingRewardsInfo
