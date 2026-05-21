/**
 * RotateEcdsaFallbackDialog.test.tsx
 *
 * Tests for RotateEcdsaFallbackDialog — password validation, strength
 * meter, mismatch error, and the ETH-funding notice.
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RotateEcdsaFallbackDialog } from './RotateEcdsaFallbackDialog'

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

// Mock identity services — we don't need real crypto in component tests.
vi.mock('~/services/identity/secp256k1Key', () => ({
  generateSecp256k1Keypair: vi.fn().mockReturnValue({
    privateKey: new Uint8Array(32).fill(0xab),
    publicKey: '0x04' + 'aa'.repeat(64),
    address: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12' as `0x${string}`,
  }),
}))

vi.mock('~/services/identity/backupBlob', () => ({
  encryptBackupBlob: vi.fn().mockResolvedValue({
    version: 1,
    argon2: { memorySize: 65536, iterations: 3, parallelism: 1 },
    salt: '0x' + '00'.repeat(16),
    iv: '0x' + '00'.repeat(12),
    ciphertext: '0x' + 'aa'.repeat(48),
    pubkeyAddress: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12',
  }),
}))

// Prevent actual file downloads in tests.
vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:mock'),
  revokeObjectURL: vi.fn(),
})

const createElementOriginal = document.createElement.bind(document)
vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
  const el = createElementOriginal(tag)
  if (tag === 'a') {
    Object.defineProperty(el, 'click', { value: vi.fn() })
  }
  return el
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WALLET_ADDR = '0x1234567890123456789012345678901234567890' as `0x${string}`

function buildProps(overrides: Partial<React.ComponentProps<typeof RotateEcdsaFallbackDialog>> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    walletAddress: WALLET_ADDR,
    onRotate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function fillPasswords(newPw: string, confirmPw: string) {
  const newInput = screen.getByTestId('new-password-input')
  const confirmInput = screen.getByTestId('confirm-password-input')
  await userEvent.type(newInput, newPw)
  await userEvent.type(confirmInput, confirmPw)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RotateEcdsaFallbackDialog — password validation', () => {
  it('Rotate button is disabled initially', () => {
    render(<RotateEcdsaFallbackDialog {...buildProps()} />)
    expect(screen.getByTestId('rotate-confirm-btn')).toBeDisabled()
  })

  it('Rotate button is disabled when passwords are too short', async () => {
    render(<RotateEcdsaFallbackDialog {...buildProps()} />)
    await fillPasswords('short', 'short')
    expect(screen.getByTestId('rotate-confirm-btn')).toBeDisabled()
  })

  it('shows mismatch error when passwords do not match', async () => {
    render(<RotateEcdsaFallbackDialog {...buildProps()} />)
    await fillPasswords('SuperSecurePassphrase!99', 'DifferentPassword!99')

    // Mismatch error is rendered via role="alert" or visible text
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('Rotate button is disabled when passwords mismatch', async () => {
    render(<RotateEcdsaFallbackDialog {...buildProps()} />)
    await fillPasswords('SuperSecurePassphrase!99', 'Mismatch!99')
    expect(screen.getByTestId('rotate-confirm-btn')).toBeDisabled()
  })

  it('Rotate button is enabled with matching strong passwords', async () => {
    render(<RotateEcdsaFallbackDialog {...buildProps()} />)
    await fillPasswords('SuperSecurePassphrase!99', 'SuperSecurePassphrase!99')
    expect(screen.getByTestId('rotate-confirm-btn')).not.toBeDisabled()
  })
})

describe('RotateEcdsaFallbackDialog — strength meter', () => {
  it('renders StrengthMeter when password is entered', async () => {
    render(<RotateEcdsaFallbackDialog {...buildProps()} />)
    await userEvent.type(screen.getByTestId('new-password-input'), 'test')
    expect(screen.getByTestId('strength-meter')).toBeInTheDocument()
  })

  it('does not render StrengthMeter when password is empty', () => {
    render(<RotateEcdsaFallbackDialog {...buildProps()} />)
    expect(screen.queryByTestId('strength-meter')).not.toBeInTheDocument()
  })
})

describe('RotateEcdsaFallbackDialog — ETH funding notice', () => {
  it('shows ETH funding notice when needsEthFunding=true', () => {
    render(<RotateEcdsaFallbackDialog {...buildProps({ needsEthFunding: true })} />)
    expect(screen.getByTestId('eth-funding-notice')).toBeInTheDocument()
  })

  it('does not show the rotate form when needsEthFunding=true', () => {
    render(<RotateEcdsaFallbackDialog {...buildProps({ needsEthFunding: true })} />)
    expect(screen.queryByTestId('rotate-confirm-btn')).not.toBeInTheDocument()
  })

  it('shows the wallet address in the ETH funding notice', () => {
    render(
      <RotateEcdsaFallbackDialog
        {...buildProps({ needsEthFunding: true })}
      />,
    )
    expect(screen.getByTestId('eth-funding-notice')).toHaveTextContent(WALLET_ADDR)
  })

  it('copies address to clipboard when copy button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(
      <RotateEcdsaFallbackDialog
        {...buildProps({ needsEthFunding: true })}
      />,
    )

    await userEvent.click(screen.getByTestId('copy-address-btn'))
    expect(writeText).toHaveBeenCalledWith(WALLET_ADDR)
  })

  it('shows the rotate form when needsEthFunding=false', () => {
    render(<RotateEcdsaFallbackDialog {...buildProps({ needsEthFunding: false })} />)
    expect(screen.getByTestId('rotate-confirm-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('eth-funding-notice')).not.toBeInTheDocument()
  })
})

describe('RotateEcdsaFallbackDialog — submit flow', () => {
  it('calls onRotate with new address and blob JSON after confirmation', async () => {
    const onRotate = vi.fn().mockResolvedValue(undefined)

    render(
      <RotateEcdsaFallbackDialog
        {...buildProps({ onRotate, needsEthFunding: false })}
      />,
    )

    await fillPasswords('SuperSecurePassphrase!99', 'SuperSecurePassphrase!99')
    await userEvent.click(screen.getByTestId('rotate-confirm-btn'))

    await waitFor(() => {
      expect(onRotate).toHaveBeenCalledWith(
        expect.stringMatching(/^0x/),
        expect.stringContaining('"version"'),
      )
    })
  })

  it('shows success state after successful rotation', async () => {
    const onRotate = vi.fn().mockResolvedValue(undefined)

    render(
      <RotateEcdsaFallbackDialog
        {...buildProps({ onRotate, needsEthFunding: false })}
      />,
    )

    await fillPasswords('SuperSecurePassphrase!99', 'SuperSecurePassphrase!99')
    await userEvent.click(screen.getByTestId('rotate-confirm-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('rotate-success')).toBeInTheDocument()
    })
  })

  it('shows error state when onRotate throws', async () => {
    const onRotate = vi.fn().mockRejectedValue(new Error('Contract reverted'))

    render(
      <RotateEcdsaFallbackDialog
        {...buildProps({ onRotate, needsEthFunding: false })}
      />,
    )

    await fillPasswords('SuperSecurePassphrase!99', 'SuperSecurePassphrase!99')
    await userEvent.click(screen.getByTestId('rotate-confirm-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('rotate-error')).toBeInTheDocument()
      expect(screen.getByTestId('rotate-error')).toHaveTextContent('Contract reverted')
    })
  })
})
