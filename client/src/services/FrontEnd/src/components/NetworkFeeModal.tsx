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
  /**
   * Optional override. If omitted, the modal reads the on-chain Network
   * name via useNetworkFees(networkId).name. This is the right behavior in
   * 99% of cases — pass an override only if you want to display the mirror
   * hostname or a custom label instead of the actual Network name.
   */
  networkName?: string
  /** ETH/USD price in dollars (from usePriceStore) */
  ethPrice: number
  /**
   * Current LZ native fee in wei (from `quote.nativeFee` on the Quoter).
   *
   * IMPORTANT: `quote.nativeFee` returned by the on-chain Quoter is the full
   * msg.value the user must send — it is NOT just the LZ message cost. It
   * already includes the per-Network storage fees ×2 (once charged on L1 and
   * once forwarded for the L2-side mirror update). To display the pure LZ
   * message leg, pass `applicableStorageFeesWei` so we can subtract `2×` that
   * out of `lzFeeWei`. Without it we would double-count storage fees here.
   */
  lzFeeWei?: bigint
  /**
   * Sum of per-Network storage fees applicable to the current flow (single
   * set, NOT doubled). Subtracted ×2 from `lzFeeWei` so the "LayerZero
   * message fee" row shows the true cross-chain leg only.
   *
   * Flow → fees included (mirrors CawProfileQuoter.sol):
   *   mintQuote                       → mintFee
   *   mintAndDepositQuote             → mintFee + depositFee + authFee
   *   mintAndDepositAndQuickSignQuote → mintFee + depositFee + authFee
   *   mintAndAuthQuote                → mintFee + authFee
   *   mintAndAuthAndQuickSignQuote    → mintFee + authFee
   */
  applicableStorageFeesWei?: bigint
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
 * Double a wei value (null/undefined passthrough). Used to display the
 * total amount the user pays per fee event: `CawProfile.payFee()` charges
 * `2× fee` — half to the Network operator, half to buy-and-burn — so the
 * raw per-Network fee on `CawNetworkManager` is one side of that pair.
 */
function dbl(wei: bigint | null | undefined): bigint | null | undefined {
  return wei == null ? wei : wei * 2n
}

/**
 * Single table row. Shows "—" when fee or ceiling hasn't loaded yet.
 */
const FeeTableRow: React.FC<{
  label: string
  current: string
  ceiling?: string
  isDark: boolean
}> = ({ label, current, ceiling, isDark }) => {
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const borderClass = isDark ? 'border-white/10' : 'border-gray-200'

  return (
    <tr className={`border-t ${borderClass}`}>
      <td className={`py-2 pr-4 text-sm ${mutedClass}`}>{label}</td>
      <td className={`py-2 pr-4 text-sm font-mono ${strongClass}`}>{current}</td>
      {ceiling !== undefined && (
        <td className={`py-2 text-sm font-mono ${mutedClass}`}>{ceiling}</td>
      )}
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
  applicableStorageFeesWei,
}) => {
  const { isDark } = useTheme()
  const fees = useNetworkFees(networkId, isOpen)

  // Prefer the actual on-chain Network name over any caller override.
  // Falls back to override → "this Network" when both are missing.
  const displayName = fees.name ?? networkName ?? 'this Network'

  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const headerClass = isDark ? 'text-white/40' : 'text-gray-400'
  const borderClass = isDark ? 'border-white/10' : 'border-gray-200'

  // Subtract 2× storage fees from `lzFeeWei` to show the pure LZ leg.
  // Quoter packs `nativeFee = storageFees*2 + lzMessageFee`. If the caller
  // didn't supply the storage offset (legacy callsite), fall back to the raw
  // value to avoid silently showing 0 — but the label will then be inflated.
  let trueLzWei: bigint | undefined = lzFeeWei
  if (lzFeeWei != null && applicableStorageFeesWei != null) {
    const offset = applicableStorageFeesWei * 2n
    trueLzWei = lzFeeWei > offset ? lzFeeWei - offset : 0n
  }
  const lzCurrentUsd = weiToUsd(trueLzWei, ethPrice)

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-lg"
      zIndex={80}
      usePortal
    >
      <ModalHeader
        title={`Network fees on ${displayName}`}
        onClose={onClose}
        icon={<HiInformationCircle className="w-5 h-5 text-yellow-500" />}
        iconBg="bg-yellow-500/20"
        border={false}
      />

      <div className="px-4 pb-5 space-y-4">

        {/* Single unified fee table — keeps column widths consistent across
            per-action fees, the cross-chain LZ row, and the deferred
            withdraw fee. A "Pay later" divider row separates pay-now from
            pay-at-withdrawal. */}
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
                  <span className="relative group inline-flex items-center gap-1">
                    <span>Ceiling</span>
                    <button
                      type="button"
                      aria-label="Ceiling info"
                      className={`inline-flex items-center justify-center transition-colors ${
                        isDark ? 'text-white/40 hover:text-white/80' : 'text-gray-400 hover:text-gray-700'
                      }`}
                    >
                      <HiInformationCircle className="w-3.5 h-3.5" />
                    </button>
                    <span
                      role="tooltip"
                      className={`pointer-events-none absolute z-50 bottom-full mb-2 left-1/2 -translate-x-1/2 w-60 rounded-lg border px-3 py-2 text-[11px] leading-relaxed normal-case tracking-normal opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shadow-lg ${
                        isDark ? 'bg-black border-white/20 text-white/80' : 'bg-white border-gray-200 text-gray-700'
                      }`}
                    >
                      Permanent cap — operators can lower it, never raise it.
                    </span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <FeeTableRow
                label="Mint username"
                current={weiToUsd(dbl(fees.mintFee), ethPrice)}
                ceiling={weiToUsd(dbl(fees.mintFeeCeiling), ethPrice)}
                isDark={isDark}
              />
              <FeeTableRow
                label="Deposit CAW"
                current={weiToUsd(dbl(fees.depositFee), ethPrice)}
                ceiling={weiToUsd(dbl(fees.depositFeeCeiling), ethPrice)}
                isDark={isDark}
              />
              <FeeTableRow
                label="Authenticate (extra Network)"
                current={weiToUsd(dbl(fees.authFee), ethPrice)}
                ceiling={weiToUsd(dbl(fees.authFeeCeiling), ethPrice)}
                isDark={isDark}
              />
              {/* Cross-chain LZ row — not a Network fee, hover the label for context */}
              <tr className={`border-t ${borderClass}`}>
                <td className={`py-2 pr-4 text-sm ${mutedClass}`}>
                  <span className="relative group inline-flex items-center gap-1">
                    <span>LayerZero message fee</span>
                    <button
                      type="button"
                      aria-label="LayerZero fee info"
                      className={`inline-flex items-center justify-center transition-colors ${
                        isDark ? 'text-white/40 hover:text-white/80' : 'text-gray-400 hover:text-gray-700'
                      }`}
                    >
                      <HiInformationCircle className="w-3.5 h-3.5" />
                    </button>
                    <span
                      role="tooltip"
                      className={`pointer-events-none absolute z-50 bottom-full mb-2 left-0 w-[269px] rounded-lg border px-3 py-2 text-[11px] leading-relaxed normal-case tracking-normal opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shadow-lg ${
                        isDark ? 'bg-black border-white/20 text-white/80' : 'bg-white border-gray-200 text-gray-700'
                      }`}
                    >
                      Paid to the LayerZero bridge — not a {displayName} fee, and not part of buy-and-burn.
                    </span>
                  </span>
                </td>
                <td className={`py-2 pr-4 text-sm font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {lzCurrentUsd}
                </td>
                <td className={`py-2 text-sm ${mutedClass}`}>
                  (varies)
                </td>
              </tr>

              {/* Withdraw row — label communicates the lock-in semantics
                  inline; tooltip below has the full explanation. Row is
                  visually dimmed because the fee isn't paid now. */}
              <tr className="border-t border-[#4f3c0096] text-[#6c6c6c]">
                <td className="py-2 pr-4 text-sm">
                  <span className="relative group inline-flex items-center gap-1">
                    <span>Maximum withdraw fee for you</span>
                    <button
                      type="button"
                      aria-label="Withdraw fee info"
                      className={`inline-flex items-center justify-center transition-colors ${
                        isDark ? 'text-white/40 hover:text-white/80' : 'text-gray-400 hover:text-gray-700'
                      }`}
                    >
                      <HiInformationCircle className="w-3.5 h-3.5" />
                    </button>
                    <span
                      role="tooltip"
                      className={`pointer-events-none absolute z-50 bottom-full mb-2 left-0 w-[269px] rounded-lg border px-3 py-2 text-[11px] leading-relaxed normal-case tracking-normal opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shadow-lg ${
                        isDark ? 'bg-black border-white/20 text-white/80' : 'bg-white border-gray-200 text-gray-700'
                      }`}
                    >
                      Locked in when you deposit. You always pay the lower of that locked rate and the current rate — never more.
                    </span>
                  </span>
                </td>
                <td
                  colSpan={2}
                  className="py-2 pr-4 text-sm font-mono text-center"
                >
                  {weiToUsd(dbl(fees.withdrawFee), ethPrice)} <span className="font-sans">(pay later)</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Buy-and-burn note */}
        <p className={`text-xs leading-relaxed text-center pt-1 border-t ${borderClass} ${isDark ? 'text-yellow-600' : 'text-amber-700'}`}>
          Half of all network fees are used to buy and burn CAW.
        </p>
      </div>
    </ModalWrapper>
  )
}

export default NetworkFeeModal
