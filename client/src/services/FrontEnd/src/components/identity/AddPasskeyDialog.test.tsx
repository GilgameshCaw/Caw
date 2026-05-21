/**
 * AddPasskeyDialog.test.tsx
 *
 * Tests for AddPasskeyDialog — Propose phase state machine and the
 * 24-hour timelock countdown computation.
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddPasskeyDialog, type PendingPasskeyRow } from './AddPasskeyDialog'

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

// Mock enrollPasskey — returns a fake PasskeyPubkey.
vi.mock('~/services/identity/passkey', () => ({
  enrollPasskey: vi.fn().mockResolvedValue({
    pubkeyX: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pubkeyY: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    credentialId: 'mock-credential-id',
  }),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_PUBKEY_ID = '0xdeadbeef0000000000000000000000000000000000000000000000000000dead' as `0x${string}`

function buildPendingRow(proposedAt: number): PendingPasskeyRow {
  return {
    pubkeyId: FAKE_PUBKEY_ID,
    pubkeyX: '0xaaaa000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    pubkeyY: '0xbbbb000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    proposedAt,
  }
}

function buildProps(
  overrides: Partial<React.ComponentProps<typeof AddPasskeyDialog>> = {},
) {
  return {
    open: true,
    onClose: vi.fn(),
    pendingPasskeys: [],
    onPropose: vi.fn().mockResolvedValue({ txHash: '0xfeedcafe' }),
    onFinalize: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AddPasskeyDialog — Propose phase', () => {
  it('renders the propose button in idle state', () => {
    render(<AddPasskeyDialog {...buildProps()} />)
    expect(screen.getByTestId('propose-passkey-btn')).toBeInTheDocument()
  })

  it('calls enrollPasskey when propose button is clicked', async () => {
    const { enrollPasskey } = await import('~/services/identity/passkey')
    const onPropose = vi.fn().mockResolvedValue({ txHash: '0xfeedcafe' })

    render(<AddPasskeyDialog {...buildProps({ onPropose })} />)
    await userEvent.click(screen.getByTestId('propose-passkey-btn'))

    await waitFor(() => {
      expect(enrollPasskey).toHaveBeenCalled()
    })
  })

  it('calls onPropose with the enrolled passkey pubkey', async () => {
    const onPropose = vi.fn().mockResolvedValue({ txHash: '0xfeedcafe' })

    render(<AddPasskeyDialog {...buildProps({ onPropose })} />)
    await userEvent.click(screen.getByTestId('propose-passkey-btn'))

    await waitFor(() => {
      expect(onPropose).toHaveBeenCalledWith(
        expect.objectContaining({
          pubkeyX: expect.stringMatching(/^0x/),
          pubkeyY: expect.stringMatching(/^0x/),
        }),
      )
    })
  })

  it('shows the success state after proposal succeeds', async () => {
    const onPropose = vi.fn().mockResolvedValue({ txHash: '0xfeedcafe' })

    render(<AddPasskeyDialog {...buildProps({ onPropose })} />)
    await userEvent.click(screen.getByTestId('propose-passkey-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('proposed-success')).toBeInTheDocument()
    })
  })

  it('shows an error when onPropose rejects', async () => {
    const onPropose = vi.fn().mockRejectedValue(new Error('Submission failed'))

    render(<AddPasskeyDialog {...buildProps({ onPropose })} />)
    await userEvent.click(screen.getByTestId('propose-passkey-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('propose-error')).toBeInTheDocument()
      expect(screen.getByTestId('propose-error')).toHaveTextContent('Submission failed')
    })
  })

  it('does not render when open=false', () => {
    render(<AddPasskeyDialog {...buildProps({ open: false })} />)
    expect(screen.queryByTestId('modal-wrapper')).not.toBeInTheDocument()
  })
})

describe('AddPasskeyDialog — 24h timelock countdown', () => {
  it('shows "Ready to finalize" for a row whose timelock has elapsed', () => {
    // proposedAt = 25 hours ago in seconds
    const pastTimestamp = Math.floor(Date.now() / 1000) - 25 * 3600

    render(
      <AddPasskeyDialog
        {...buildProps({ pendingPasskeys: [buildPendingRow(pastTimestamp)] })}
      />,
    )

    // The countdown should show "Ready to finalize".
    const shortId = FAKE_PUBKEY_ID.slice(2, 10)
    expect(screen.getByTestId(`countdown-${shortId}`)).toHaveTextContent(
      'Ready to finalize',
    )
  })

  it('shows "Available in Nh Nm" for a row whose timelock has not elapsed', () => {
    // proposedAt = 1 hour ago → 23 hours remaining
    const recentTimestamp = Math.floor(Date.now() / 1000) - 1 * 3600

    render(
      <AddPasskeyDialog
        {...buildProps({ pendingPasskeys: [buildPendingRow(recentTimestamp)] })}
      />,
    )

    const shortId = FAKE_PUBKEY_ID.slice(2, 10)
    const countdownText = screen.getByTestId(`countdown-${shortId}`).textContent ?? ''
    // Should contain "Available in" and hours
    expect(countdownText).toMatch(/Available in/)
  })

  it('shows the Finalize button only when timelock is elapsed', () => {
    const pastTimestamp = Math.floor(Date.now() / 1000) - 25 * 3600
    const shortId = FAKE_PUBKEY_ID.slice(2, 10)

    render(
      <AddPasskeyDialog
        {...buildProps({ pendingPasskeys: [buildPendingRow(pastTimestamp)] })}
      />,
    )

    expect(screen.getByTestId(`finalize-btn-${shortId}`)).toBeInTheDocument()
  })

  it('does not show Finalize button when timelock is not elapsed', () => {
    const recentTimestamp = Math.floor(Date.now() / 1000) - 1 * 3600
    const shortId = FAKE_PUBKEY_ID.slice(2, 10)

    render(
      <AddPasskeyDialog
        {...buildProps({ pendingPasskeys: [buildPendingRow(recentTimestamp)] })}
      />,
    )

    expect(screen.queryByTestId(`finalize-btn-${shortId}`)).not.toBeInTheDocument()
  })

  it('calls onCancel when Cancel button is clicked', async () => {
    const pastTimestamp = Math.floor(Date.now() / 1000) - 25 * 3600
    const onCancel = vi.fn().mockResolvedValue(undefined)
    const shortId = FAKE_PUBKEY_ID.slice(2, 10)

    render(
      <AddPasskeyDialog
        {...buildProps({ pendingPasskeys: [buildPendingRow(pastTimestamp)], onCancel })}
      />,
    )

    await userEvent.click(screen.getByTestId(`cancel-btn-${shortId}`))

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith(FAKE_PUBKEY_ID)
    })
  })
})
