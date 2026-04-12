import React from 'react'

interface StakingRewardsInfoProps {
  /** Always use dark styling (e.g. onboarding). Default false = theme-aware. */
  alwaysDark?: boolean
  isDark?: boolean
}

const REWARDS = [
  { action: 'Post', cost: '5,000 CAW', parts: ['100% to depositors'] },
  { action: 'Like', cost: '2,000 CAW', parts: ['80% to poster', '20% to depositors'] },
  { action: 'ReCAW', cost: '4,000 CAW', parts: ['50% to poster', '50% to depositors'] },
  { action: 'Follow', cost: '30,000 CAW', parts: ['80% to followed', '20% to depositors'] },
]

const StakingRewardsInfo: React.FC<StakingRewardsInfoProps> = ({
  alwaysDark = false,
  isDark = true,
}) => {
  const dark = alwaysDark || isDark

  return (
    <div className={`py-4 px-[10px] rounded-lg border transition-all duration-300 ${
      dark ? 'bg-[#171202]/85 border-white/20' : 'bg-yellow-50 border-gray-300 shadow-xl'
    }`}>
      <h3 className={`text-base font-semibold mb-3 transition-colors duration-300 ${
        dark ? 'text-white' : 'text-gray-900'
      }`}>
        Earn from every action on the protocol:
      </h3>
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
        Rewards accrue in real time with no lock-up periods.
      </p>
    </div>
  )
}

export default StakingRewardsInfo
