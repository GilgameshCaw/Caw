/**
 * NetworkFeeModal.tsx
 *
 * Bottom-sheet/centered modal showing the full per-Network fee schedule
 * (current + ceiling in USD), the LZ message fee, and the buy-and-burn note.
 *
 * Usage:
 *   <NetworkFeeModal
 *     isOpen={open}
 *     onClose={() => setOpen(false)}
 *     networkId={CLIENT_ID}
 *     networkName="CAW"
 *     ethPrice={ethPrice}
 *     lzFeeEth={lzFeeEth}
 *   />
 */

import React from 'react'
import { formatEther } from 'viem'
import ModalWrapper from '~/components/modals/ModalWrapper'
import ModalHeader from '~/components/modals/ModalHeader'
import { HiInformationCircle } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { useNetworkFees } from '~/hooks/useNetworkFees'
import { formatUsd } from '~/utils/numberFormat'

interface NetworkFeeModalProps {
  isOpen: boolean
  onClose: () => void
  networkId: number | undefined
  /** Human-readable network name, e.g. "CAW" or "test.caw.social" */
  networkName: string
  /** ETH/USD price in dollars (from usePriceStore) */
  ethPrice: number
  /** Current LZ native fee in wei (from quote?.nativeFee) */
  lzFeeWei?: bigint
}

/**
 * Convert a fee in wei to a USD string, or "—" if price or fee is unavailable.
 * Fee is in ETH (18 decimals).
 */
function weiToUsd(wei: bigint | null | undefined, ethPrice: number): string {
  if (wei == null || ethPrice <= 0) return '—'
  const eth = Number(formatEther(wei))
  const usd = eth * ethPrice
  return `~$${formatUsd(usd)}`
}

/**
 * Single table row. Shows "—" when fee or ceiling hasn't loaded yet.
 */
const FeeTableRow: React.FC<{
  label: string
  current: string
  ceiling: string
  isDark: boolean
}> = ({ label, current, ceiling, isDark }) => {
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const borderClass = isDark ? 'border-white/10' : 'border-gray-200'

  return (
    <tr className={`border-t ${borderClass}`}>
      <td className={`py-2 pr-4 text-sm ${mutedClass}`}>{label}</td>
      <td className={`py-2 pr-4 text-sm font-mono ${strongClass}`}>{current}</td>
      <td className={`py-2 text-sm font-mono ${mutedClass}`}>{ceiling}</td>
    </tr>
  )
}

const NetworkFeeModal: React.FC<NetworkFeeModalProps> = ({
  isOpen,
  onClose,
  networkId,
  networkName,
  ethPrice,
  lzFeeWei,
}) => {
  const { isDark } = useTheme()
  const fees = useNetworkFees(networkId, isOpen)

  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const headerClass = isDark ? 'text-white/40' : 'text-gray-400'
  const borderClass = isDark ? 'border-white/10' : 'border-gray-200'

  const lzCurrentUsd = weiToUsd(lzFeeWei, ethPrice)

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-lg"
      zIndex={80}
      usePortal
    >
      <ModalHeader
        title={`Network fees on ${networkName}`}
        onClose={onClose}
        icon={<HiInformationCircle className="w-5 h-5 text-yellow-500" />}
        iconBg="bg-yellow-500/20"
      />

      <div className="px-4 pb-5 space-y-4">
        {/* Intro */}
        <p className={`text-sm leading-relaxed ${mutedClass}`}>
          These are the fees you pay when you mint, deposit, authenticate, or
          withdraw on <span className={isDark ? 'text-white' : 'text-gray-900'}>{networkName}</span>.
          The ceiling is a permanent upper bound the Network operator committed to —
          they can lower it, never raise it.
        </p>

        {/* Fee table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={`pb-2 text-left text-xs uppercase tracking-wide ${headerClass}`}>
                  Fee
                </th>
                <th className={`pb-2 text-left text-xs uppercase tracking-wide ${headerClass}`}>
                  Current
                </th>
                <th className={`pb-2 text-left text-xs uppercase tracking-wide ${headerClass}`}>
                  Ceiling
                </th>
              </tr>
            </thead>
            <tbody>
              <FeeTableRow
                label="Mint username"
                current={weiToUsd(fees.mintFee, ethPrice)}
                ceiling={weiToUsd(fees.mintFeeCeiling, ethPrice)}
                isDark={isDark}
              />
              <FeeTableRow
                label="Deposit CAW"
                current={weiToUsd(fees.depositFee, ethPrice)}
                ceiling={weiToUsd(fees.depositFeeCeiling, ethPrice)}
                isDark={isDark}
              />
              <FeeTableRow
                label="Authenticate (extra Network)"
                current={weiToUsd(fees.authFee, ethPrice)}
                ceiling={weiToUsd(fees.authFeeCeiling, ethPrice)}
                isDark={isDark}
              />
              <FeeTableRow
                label="Withdraw CAW"
                current={weiToUsd(fees.withdrawFee, ethPrice)}
                ceiling={weiToUsd(fees.withdrawFeeCeiling, ethPrice)}
                isDark={isDark}
              />
              <tr className={`border-t ${borderClass}`}>
                <td className={`py-2 pr-4 text-sm ${mutedClass}`}>
                  LayerZero message fee
                </td>
                <td className={`py-2 pr-4 text-sm font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {lzCurrentUsd}
                </td>
                <td className={`py-2 text-sm ${mutedClass}`}>
                  (varies)
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Buy-and-burn note */}
        <p className={`text-xs leading-relaxed pt-1 border-t ${borderClass} ${isDark ? 'text-yellow-600' : 'text-amber-700'}`}>
          Half of all protocol fees are used to buy and burn CAW.
        </p>
      </div>
    </ModalWrapper>
  )
}

export default NetworkFeeModal
