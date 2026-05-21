/**
 * IdentitySection.test.tsx
 *
 * Tests for IdentitySection — population gating, skeleton loading state,
 * and enrolled-passkey list rendering from mocked useQuery results.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IdentitySection } from './IdentitySection'

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Population hook — controlled per test via a factory that reads from a
// module-level state object (vi.mock hoisting requires this pattern).
let _mockPop: 'A' | 'B' | 'C' | 'none' = 'B'
let _mockLoading = false
const WALLET_ADDR = '0x1111111111111111111111111111111111111111' as `0x${string}`

vi.mock('~/hooks/useWalletPopulation', () => ({
  useWalletPopulation: () => ({
    population: _mockPop,
    loading: _mockLoading,
    address: WALLET_ADDR,
  }),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: WALLET_ADDR }),
  usePublicClient: () => null,
}))

// React Query — mock useQuery to return controlled state.
let mockQueryResult: { data: unknown; isLoading: boolean } = {
  data: { enrolled: [], pending: [], ecdsaFallbackAddress: undefined },
  isLoading: false,
}

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({ ...mockQueryResult, refetch: vi.fn() })),
}))

vi.mock('~/hooks/useTheme', () => ({
  useTheme: () => ({ isDark: true }),
}))

vi.mock('~/i18n/I18nProvider', () => ({
  useT: () => (key: string) => key,
}))

// Mock child dialogs so they don't explode without full wagmi context.
vi.mock('./AddPasskeyDialog', () => ({
  default: () => null,
  AddPasskeyDialog: () => null,
}))
vi.mock('./RotateEcdsaFallbackDialog', () => ({
  default: () => null,
  RotateEcdsaFallbackDialog: () => null,
}))
vi.mock('./ReDownloadBackupDialog', () => ({
  default: () => null,
  ReDownloadBackupDialog: () => null,
}))
vi.mock('./RemovePasskeyDialog', () => ({
  default: () => null,
  RemovePasskeyDialog: () => null,
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderSection() {
  return render(<IdentitySection username="testuser" inMemoryPrivateKey={null} />)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IdentitySection — population gating', () => {
  it('renders for Population B', () => {
    _mockPop = 'B'
    _mockLoading = false

    renderSection()

    expect(screen.getByTestId('identity-section')).toBeInTheDocument()
  })

  it('does not render for Population A', () => {
    _mockPop = 'A'
    _mockLoading = false

    renderSection()

    expect(screen.queryByTestId('identity-section')).not.toBeInTheDocument()
  })

  it('does not render for Population C', () => {
    _mockPop = 'C'
    _mockLoading = false

    renderSection()

    expect(screen.queryByTestId('identity-section')).not.toBeInTheDocument()
  })

  it('does not render when population is none (not connected)', () => {
    _mockPop = 'none'
    _mockLoading = false

    renderSection()

    expect(screen.queryByTestId('identity-section')).not.toBeInTheDocument()
  })

  it('does not render while population is loading (returns none)', () => {
    // loading=true → population stays 'none' per hook implementation
    _mockPop = 'none'
    _mockLoading = true

    renderSection()

    expect(screen.queryByTestId('identity-section')).not.toBeInTheDocument()
  })
})

describe('IdentitySection — loading skeleton', () => {
  beforeEach(() => {
    _mockPop = 'B'
    _mockLoading = false
  })

  it('shows loading skeleton while passkey data is fetching', () => {
    mockQueryResult = { data: undefined, isLoading: true }

    renderSection()

    expect(screen.getByTestId('passkeys-loading')).toBeInTheDocument()
  })

  it('hides loading skeleton when data is ready', () => {
    mockQueryResult = {
      data: { enrolled: [], pending: [], ecdsaFallbackAddress: undefined },
      isLoading: false,
    }

    renderSection()

    expect(screen.queryByTestId('passkeys-loading')).not.toBeInTheDocument()
  })
})

describe('IdentitySection — enrolled passkey list', () => {
  beforeEach(() => {
    _mockPop = 'B'
    _mockLoading = false
  })

  it('shows "no passkeys" message when enrolled list is empty', () => {
    mockQueryResult = {
      data: { enrolled: [], pending: [], ecdsaFallbackAddress: undefined },
      isLoading: false,
    }

    renderSection()

    expect(screen.getByTestId('no-passkeys')).toBeInTheDocument()
  })

  it('renders a row for each enrolled passkey', () => {
    mockQueryResult = {
      data: {
        enrolled: [
          { pubkeyHash: '0xdeadbeef01234567deadbeef01234567deadbeef01234567deadbeef01234567' as `0x${string}`, isThisDevice: false },
          { pubkeyHash: '0xcafecafe01234567cafecafe01234567cafecafe01234567cafecafe01234567' as `0x${string}`, isThisDevice: false },
        ],
        pending: [],
        ecdsaFallbackAddress: undefined,
      },
      isLoading: false,
    }

    renderSection()

    // Short IDs are the first 8 chars after 0x prefix.
    expect(screen.getByTestId('enrolled-passkey-deadbeef')).toBeInTheDocument()
    expect(screen.getByTestId('enrolled-passkey-cafecafe')).toBeInTheDocument()
  })

  it('shows the add-passkey button', () => {
    mockQueryResult = {
      data: { enrolled: [], pending: [], ecdsaFallbackAddress: undefined },
      isLoading: false,
    }

    renderSection()

    expect(screen.getByTestId('add-passkey-btn')).toBeInTheDocument()
  })

  it('shows rotate and redownload buttons', () => {
    mockQueryResult = {
      data: { enrolled: [], pending: [], ecdsaFallbackAddress: undefined },
      isLoading: false,
    }

    renderSection()

    expect(screen.getByTestId('rotate-fallback-btn')).toBeInTheDocument()
    expect(screen.getByTestId('redownload-btn')).toBeInTheDocument()
  })
})
