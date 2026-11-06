import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import SalesProceedsBanner from './SalesProceedsBanner'

const payouts = vi.hoisted(() => ({ value: { pending: null as bigint | null, loaded: true } }))

vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0xaaaa' }) }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (key: string) => key }))
vi.mock('~/hooks/useMarketplacePayouts', () => ({
  useMarketplacePayouts: () => ({
    ...payouts.value,
    withdraw: vi.fn(),
    withdrawTo: vi.fn(),
    isPending: false,
    isConfirming: false,
  }),
}))

describe('SalesProceedsBanner', () => {
  it('labels pendingPayouts as ETH', () => {
    payouts.value = { pending: 10n ** 18n, loaded: true }
    render(<SalesProceedsBanner />)
    expect(screen.getByText('1 ETH')).toBeTruthy()
    expect(screen.queryByText(/CAW/)).toBeNull()
  })

  it('renders nothing without a balance', () => {
    payouts.value = { pending: null, loaded: true }
    const { container } = render(<SalesProceedsBanner />)
    expect(container.firstChild).toBeNull()
  })
})
