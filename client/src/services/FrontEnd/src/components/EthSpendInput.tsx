/**
 * EthSpendInput.tsx
 *
 * Shared "ETH to spend / ETH to deposit" card used on:
 *   - /usernames/new   (Profile/New.tsx — burns a username, deposits remainder)
 *   - /staking         (Staking.tsx deposit panel — full amount becomes deposit)
 *
 * The two sites previously had ~100 lines of duplicated input + quick-picks +
 * USD readout + balance "use max" button. The only divergence is the
 * username-cost branch in the readout copy: New.tsx subtracts the username
 * burn cost from the swap output before showing "(~Y CAW)"; Staking has no
 * username cost so it just shows the full expected CAW out.
 *
 * Callers own the wagmi swap-quote logic (reserves, slippage, zap math) and
 * pass the quote primitives in via props. This component is purely the
 * input + USD-readout UI, no on-chain logic of its own.
 */
import React from 'react'
import { formatEther } from 'viem'
import { useTheme } from '~/hooks/useTheme'
import { formatUsd } from '~/utils/numberFormat'
import { convertToNumber, formatNumberCompact } from '~/utils'

const ETH_GAS_RESERVE_WEI = 1_000_000_000_000_000n // 0.001 ETH

/**
 * Compact dollar formatter: $20, $300, $1.5k, $12k, $45k, $1.2M.
 * Originally lived inside Profile/New.tsx; moved here so both callsites share it.
 */
function formatDollarsCompact(dollars: number): string {
  if (dollars < 1_000) return `$${dollars}`
  if (dollars < 1_000_000) {
    const k = dollars / 1_000
    return Number.isInteger(k) ? `$${k}k` : `$${k.toFixed(1)}k`
  }
  const m = dollars / 1_000_000
  return Number.isInteger(m) ? `$${m}M` : `$${m.toFixed(1)}M`
}

export interface EthSpendInputProps {
  /** Title shown above the input. e.g. "ETH to spend" or "ETH to deposit". */
  title: string
  /** Optional subtitle next to the title (rendered smaller, normal weight). */
  subtitle?: string
  /** Additional content rendered after the title (e.g. info-popover line). */
  titleSuffix?: React.ReactNode
  /** Controlled input value (string form, e.g. "0.05"). */
  ethAmount: string
  /** Setter for the controlled input. */
  setEthAmount: (next: string) => void
  /** ETH/USD price for the USD readout + quick-pick computation. */
  ethPrice: number
  /** Dollar amounts to render as quick-pick buttons. */
  quickPickDollars: number[]
  /** Swap quote (in CAW raw wei). Required to render the "~Y CAW" readout. */
  expectedCawOut?: bigint
  /** When true, gates the CAW readout — caller's reserves haven't loaded. */
  reservesLoaded?: boolean
  /**
   * Optional username burn cost (CAW raw wei). When set:
   *   - If `expectedCawOut < cost` → render a red warning ("below burn cost").
   *   - Else → subtract `cost` from `expectedCawOut` and show the remainder
   *           as the depositable CAW amount.
   * Omit on flows where the full swap output is the deposit (e.g. Staking).
   */
  usernameCostCaw?: bigint
  /** L1 ETH balance for the "use max" button. */
  ethBalanceWei?: bigint
  /**
   * Called when the user has no wallet connected. Optional — when absent, the
   * "Connect wallet" affordance is hidden. New.tsx passes its openConnectModal.
   */
  onConnectClick?: () => void
  /** Label for the balance row (e.g. "Balance:"). Defaults to "Balance:". */
  balanceLabel?: string
  /** Placeholder for the input (default "0.05"). */
  placeholder?: string
}

const EthSpendInput: React.FC<EthSpendInputProps> = ({
  title,
  subtitle,
  titleSuffix,
  ethAmount,
  setEthAmount,
  ethPrice,
  quickPickDollars,
  expectedCawOut,
  reservesLoaded,
  usernameCostCaw,
  ethBalanceWei,
  onConnectClick,
  balanceLabel = 'Balance:',
  placeholder = '0.05',
}) => {
  const { isDark } = useTheme()

  // Parse user input to raw wei for downstream comparisons. Empty / NaN → 0.
  let ethAmountWei = 0n
  try {
    const n = Number(ethAmount)
    if (!Number.isNaN(n) && n > 0) {
      ethAmountWei = BigInt(Math.round(n * 1e18))
    }
  } catch { /* keep 0n */ }

  return (
    <div className={`border rounded-xl p-4 space-y-3 ${
      isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50'
    }`}>
      <div className="text-sm font-medium">
        {title}
        {subtitle && (
          <span className={`text-xs font-normal ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {subtitle}
          </span>
        )}
        {titleSuffix}
      </div>

      {/* Quick-pick dollar amounts. The amount-in-ETH is derived from the
          current ETH/USD price; if the price isn't loaded yet, the buttons
          are disabled. */}
      <div className="flex gap-2">
        {quickPickDollars.map(dollars => {
          // 4-decimal ETH precision is plenty given we display in USD.
          const ethAmountForDollars = ethPrice > 0
            ? (dollars / ethPrice).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
            : ''
          const active = ethAmount === ethAmountForDollars && ethAmountForDollars !== ''
          return (
            <button
              key={dollars}
              type="button"
              onClick={() => setEthAmount(ethAmountForDollars)}
              disabled={ethPrice <= 0}
              className={`flex-1 py-1.5 text-xs rounded-full border transition-colors cursor-pointer ${
                active
                  ? 'border-yellow-500 text-yellow-400'
                  : isDark
                    ? 'border-white/10 text-gray-400 hover:text-white hover:border-white/30'
                    : 'border-[#BBB] text-gray-600 hover:text-gray-900 hover:border-gray-500'
              } disabled:opacity-30 disabled:cursor-not-allowed`}
            >
              {formatDollarsCompact(dollars)}
            </button>
          )
        })}
      </div>

      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={ethAmount}
          onChange={e => setEthAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder={placeholder}
          className={`w-full px-4 py-2.5 rounded-full focus:outline-none text-sm ${
            isDark
              ? 'bg-black border border-white/20 text-white placeholder-white/30 focus:border-white/30'
              : 'bg-white border border-gray-300 text-black placeholder-gray-400 focus:border-gray-400'
          }`}
        />
        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm">ETH</span>
      </div>

      <div className={`flex justify-between items-center text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        {/* Left cell: either a red "below burn cost" warning (when the swap
            output won't cover the username's CAW burn), the combined
            "~$X.XX (~Y CAW)" readout, or just "~$X.XX" if the reserves
            haven't loaded / no quote yet. */}
        <span>
          {ethAmountWei > 0n && ethPrice > 0 && reservesLoaded && expectedCawOut !== undefined
            && usernameCostCaw !== undefined && expectedCawOut < usernameCostCaw ? (
            <span className="text-red-400">
              Below the {formatNumberCompact(convertToNumber(usernameCostCaw, 18))} CAW burn cost — increase ETH.
            </span>
          ) : ethAmountWei > 0n && ethPrice > 0 && reservesLoaded && expectedCawOut !== undefined ? (
            <>
              ~<span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                ${formatUsd(Number(ethAmount) * ethPrice)}
              </span>{' '}
              (~{formatNumberCompact(convertToNumber(
                usernameCostCaw !== undefined ? expectedCawOut - usernameCostCaw : expectedCawOut,
                18,
              ))} CAW)
            </>
          ) : ethAmountWei > 0n && ethPrice > 0 ? (
            <>~<span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>${formatUsd(Number(ethAmount) * ethPrice)}</span></>
          ) : ''}
        </span>
        {ethBalanceWei !== undefined ? (
          <button
            type="button"
            onClick={() => {
              const max = ethBalanceWei > ETH_GAS_RESERVE_WEI
                ? ethBalanceWei - ETH_GAS_RESERVE_WEI
                : 0n
              setEthAmount(Number(formatEther(max)).toFixed(6).replace(/\.?0+$/, ''))
            }}
            className="hover:underline cursor-pointer"
            title="Use max (leaves ~0.001 ETH for gas)"
          >
            {balanceLabel}{' '}
            <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {Number(formatEther(ethBalanceWei)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH
            </span>
          </button>
        ) : onConnectClick ? (
          <button
            type="button"
            onClick={onConnectClick}
            className="hover:underline cursor-pointer text-yellow-500"
          >
            Connect wallet
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default EthSpendInput
