/**
 * NetworkFeeModal.test.tsx
 *
 * Tests for the NetworkFeeModal component and its USD-formatting math.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { formatUsd } from '~/utils/numberFormat'

// ─── Mock external dependencies ──────────────────────────────────────────────

vi.mock('~/components/modals/ModalWrapper', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div data-testid="modal-wrapper">{children}</div> : null,
}))

vi.mock('~/components/modals/ModalHeader', () => ({
  default: ({ title, onClose }: { title: string; onClose: () => void }) => (
    <div data-testid="modal-header">
      <span>{title}</span>
      <button onClick={onClose} data-testid="modal-close-btn">X</button>
    </div>
  ),
}))

vi.mock('~/hooks/useTheme', () => ({
  useTheme: () => ({ isDark: true }),
}))

vi.mock('~/i18n/I18nProvider', () => ({
  useT: () => (key: string) => key,
}))

// Default: all fees null (loading state)
let mockNetworkFees = {
  mintFee: null as bigint | null,
  mintFeeCeiling: null as bigint | null,
  depositFee: null as bigint | null,
  depositFeeCeiling: null as bigint | null,
  authFee: null as bigint | null,
  authFeeCeiling: null as bigint | null,
  withdrawFee: null as bigint | null,
  withdrawFeeCeiling: null as bigint | null,
  isLoading: true,
}

vi.mock('~/hooks/useNetworkFees', () => ({
  useNetworkFees: () => mockNetworkFees,
}))

// ─── Import component after mocks ─────────────────────────────────────────────

import NetworkFeeModal from './NetworkFeeModal'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ETH_PRICE = 2000 // $2000/ETH
const DEFAULT_PROPS = {
  isOpen: true,
  onClose: vi.fn(),
  networkId: 1,
  networkName: 'CAW',
  ethPrice: ETH_PRICE,
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NetworkFeeModal', () => {
  beforeEach(() => {
    mockNetworkFees = {
      mintFee: null,
      mintFeeCeiling: null,
      depositFee: null,
      depositFeeCeiling: null,
      authFee: null,
      authFeeCeiling: null,
      withdrawFee: null,
      withdrawFeeCeiling: null,
      isLoading: true,
    }
  })

  it('renders nothing when isOpen=false', () => {
    render(<NetworkFeeModal {...DEFAULT_PROPS} isOpen={false} />)
    expect(screen.queryByTestId('modal-wrapper')).toBeNull()
  })

  it('shows network name in the header title', () => {
    render(<NetworkFeeModal {...DEFAULT_PROPS} networkName="test.caw.social" />)
    expect(screen.getByTestId('modal-header')).toHaveTextContent('test.caw.social')
  })

  it('shows — for all fees when fees are still loading', () => {
    render(<NetworkFeeModal {...DEFAULT_PROPS} />)
    // All current + ceiling cells should show —
    const dashes = screen.getAllByText('—')
    // 4 fee rows × 2 columns (current + ceiling) = 8 dashes, plus LZ current = 9 total
    expect(dashes.length).toBeGreaterThanOrEqual(8)
  })

  it('renders USD-converted fee when fees are loaded (doubled — operator + buy-and-burn)', () => {
    // payFee() in CawProfile charges 2× the per-Network fee: half to the
    // operator, half to buy-and-burn. The modal therefore renders 2× the
    // raw on-chain value so the user sees what they actually pay.
    mockNetworkFees = {
      ...mockNetworkFees,
      mintFee: 1_000_000_000_000_000n,         // 0.001 ETH → displayed as 0.002 ETH = $4.00
      mintFeeCeiling: 2_000_000_000_000_000n,  // 0.002 ETH → displayed as 0.004 ETH = $8.00
      depositFee: 500_000_000_000_000n,        // 0.0005 ETH → displayed as 0.001 ETH = $2.00
      depositFeeCeiling: 1_000_000_000_000_000n,
      authFee: 0n,
      authFeeCeiling: 0n,
      withdrawFee: 0n,
      withdrawFeeCeiling: 0n,
      isLoading: false,
    }

    render(<NetworkFeeModal {...DEFAULT_PROPS} />)

    // mintFee doubled: 0.001 × 2 × $2000 = $4.00
    expect(screen.getAllByText('~$4.00').length).toBeGreaterThanOrEqual(1)
    // depositFee doubled: 0.0005 × 2 × $2000 = $2.00
    expect(screen.getAllByText('~$2.00').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the LZ fee when provided', () => {
    // 0.002 ETH = 2e15 wei → $4.00 at $2000/ETH
    // No applicableStorageFeesWei → fall-back path: raw lzFeeWei is rendered.
    render(<NetworkFeeModal {...DEFAULT_PROPS} lzFeeWei={2_000_000_000_000_000n} />)
    expect(screen.getByText('~$4.00')).toBeTruthy()
  })

  it('subtracts 2× applicableStorageFeesWei from lzFeeWei to show true LZ leg', () => {
    // Quoter packs nativeFee = storageFees*2 + lzMsgFee.
    //   nativeFee     = 0.0033 ETH (~$6.60 @ $2000)
    //   storage (1×)  = 0.0015 ETH (~$3.00 @ $2000)
    //   storage × 2   = 0.0030 ETH
    //   true LZ       = 0.0003 ETH (~$0.60)
    render(<NetworkFeeModal
      {...DEFAULT_PROPS}
      lzFeeWei={3_300_000_000_000_000n}
      applicableStorageFeesWei={1_500_000_000_000_000n}
    />)
    expect(screen.getByText('~$0.60')).toBeTruthy()
  })

  it('clamps true LZ to 0 if 2× storage fees exceeds lzFeeWei', () => {
    // Pathological: storage*2 > nativeFee. Display "$0.00" rather than going negative.
    render(<NetworkFeeModal
      {...DEFAULT_PROPS}
      lzFeeWei={1_000_000_000_000_000n}
      applicableStorageFeesWei={1_000_000_000_000_000n}
    />)
    expect(screen.getByText('~$0.00')).toBeTruthy()
  })

  it('renders Network gas + Total due now that reconciles with the header math', () => {
    // nativeFee = storage*2 + trueLZ. Total due now must equal nativeFee + gas
    // (== the caller's rolled-up header), independent of how it's decomposed.
    //   nativeFee   = 0.0033 ETH
    //   storage (1×)= 0.0015 ETH → ×2 = 0.0030 ETH
    //   trueLZ      = 0.0003 ETH (~$0.60)
    //   gas         = 0.0002 ETH (~$0.40)
    //   total       = nativeFee + gas = 0.0035 ETH (~$7.00 @ $2000)
    render(<NetworkFeeModal
      {...DEFAULT_PROPS}
      lzFeeWei={3_300_000_000_000_000n}
      applicableStorageFeesWei={1_500_000_000_000_000n}
      gasWei={200_000_000_000_000n}
    />)
    expect(screen.getByText('Network gas')).toBeTruthy()
    expect(screen.getByText('Total due now')).toBeTruthy()
    expect(screen.getByText('~$0.40')).toBeTruthy()  // gas row
    expect(screen.getByText('~$7.00')).toBeTruthy()  // total = nativeFee + gas
  })

  it('omits the gas + total rows when gasWei is not provided (legacy callsite)', () => {
    render(<NetworkFeeModal
      {...DEFAULT_PROPS}
      lzFeeWei={3_300_000_000_000_000n}
      applicableStorageFeesWei={1_500_000_000_000_000n}
    />)
    expect(screen.queryByText('Total due now')).toBeNull()
    expect(screen.queryByText('Network gas')).toBeNull()
  })

  it('shows — for LZ fee when lzFeeWei is not provided', () => {
    render(<NetworkFeeModal {...DEFAULT_PROPS} lzFeeWei={undefined} />)
    // Expect the LZ row's current column to be —
    // (varies) appears for ceiling, — for current
    expect(screen.getByText('(varies)')).toBeTruthy()
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThan(0)
  })

  it('shows the buy-and-burn note', () => {
    render(<NetworkFeeModal {...DEFAULT_PROPS} />)
    expect(screen.getByText(/buy and burn CAW/i)).toBeTruthy()
  })

  it('shows the ceiling commitment explanation', () => {
    render(<NetworkFeeModal {...DEFAULT_PROPS} />)
    expect(screen.getByText(/lower it, never raise it/i)).toBeTruthy()
  })
})

// ─── formatUsd math unit tests ────────────────────────────────────────────────

describe('formatUsd rollup math (network fee)', () => {
  it('formats a typical ETH gas cost', () => {
    // 0.003 ETH × $2000 = $6.00
    expect(formatUsd(0.003 * 2000)).toBe('6.00')
  })

  it('formats sub-cent protocol fees', () => {
    // 0.00001 ETH × $2000 = $0.02 exactly → standard 2-decimal
    expect(formatUsd(0.02)).toBe('0.02')
  })

  it('formats zero as 0.00', () => {
    expect(formatUsd(0)).toBe('0.00')
  })

  it('formats large amounts with thousands separator', () => {
    expect(formatUsd(1234.56)).toBe('1,234.56')
  })

  it('rollup: mintFee + depositFee + lzFee → total in USD', () => {
    // Simulate the rollup logic used in New.tsx:
    //   mintFee = 0.001 ETH, depositFee = 0.0005 ETH, lzFee = 0.002 ETH
    //   total = 0.0035 ETH × $2000 = $7.00
    const totalEth = 0.001 + 0.0005 + 0.002 + 0.001 // gas estimate
    const usd = totalEth * ETH_PRICE
    expect(formatUsd(usd)).toBe('9.00')
  })
})
