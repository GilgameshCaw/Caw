/**
 * ReDownloadBackupDialog.test.tsx
 *
 * Tests for ReDownloadBackupDialog — happy path with mocked in-memory key,
 * and the no-key notice path.
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReDownloadBackupDialog } from './ReDownloadBackupDialog'

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

// Prevent actual downloads.
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

const MOCK_KEY = new Uint8Array(32).fill(0xde)
const FALLBACK_ADDR = '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' as `0x${string}`

function buildProps(overrides: Partial<React.ComponentProps<typeof ReDownloadBackupDialog>> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    inMemoryPrivateKey: MOCK_KEY,
    ecdsaFallbackAddress: FALLBACK_ADDR,
    username: 'testuser',
    ...overrides,
  }
}

async function fillPasswords(newPw: string, confirmPw: string) {
  await userEvent.type(screen.getByTestId('new-password-input'), newPw)
  await userEvent.type(screen.getByTestId('confirm-password-input'), confirmPw)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReDownloadBackupDialog — no in-memory key', () => {
  it('shows the no-key notice when inMemoryPrivateKey is null', () => {
    render(<ReDownloadBackupDialog {...buildProps({ inMemoryPrivateKey: null })} />)
    expect(screen.getByTestId('no-key-notice')).toBeInTheDocument()
  })

  it('does not show the download form when no key', () => {
    render(<ReDownloadBackupDialog {...buildProps({ inMemoryPrivateKey: null })} />)
    expect(screen.queryByTestId('download-btn')).not.toBeInTheDocument()
  })

  it('does not render when open=false', () => {
    render(<ReDownloadBackupDialog {...buildProps({ open: false })} />)
    expect(screen.queryByTestId('modal-wrapper')).not.toBeInTheDocument()
  })
})

describe('ReDownloadBackupDialog — happy path with in-memory key', () => {
  it('shows the download form', () => {
    render(<ReDownloadBackupDialog {...buildProps()} />)
    expect(screen.getByTestId('download-btn')).toBeInTheDocument()
  })

  it('download button is disabled initially', () => {
    render(<ReDownloadBackupDialog {...buildProps()} />)
    expect(screen.getByTestId('download-btn')).toBeDisabled()
  })

  it('download button is disabled when passwords are too short', async () => {
    render(<ReDownloadBackupDialog {...buildProps()} />)
    await fillPasswords('short', 'short')
    expect(screen.getByTestId('download-btn')).toBeDisabled()
  })

  it('download button is disabled when passwords mismatch', async () => {
    render(<ReDownloadBackupDialog {...buildProps()} />)
    await fillPasswords('SuperSecurePassphrase!99', 'DifferentPass!99')
    expect(screen.getByTestId('download-btn')).toBeDisabled()
  })

  it('download button is enabled with matching strong passwords', async () => {
    render(<ReDownloadBackupDialog {...buildProps()} />)
    await fillPasswords('SuperSecurePassphrase!99', 'SuperSecurePassphrase!99')
    expect(screen.getByTestId('download-btn')).not.toBeDisabled()
  })

  it('calls encryptBackupBlob with the in-memory key and new password', async () => {
    const { encryptBackupBlob } = await import('~/services/identity/backupBlob')

    render(<ReDownloadBackupDialog {...buildProps()} />)
    await fillPasswords('SuperSecurePassphrase!99', 'SuperSecurePassphrase!99')
    await userEvent.click(screen.getByTestId('download-btn'))

    await waitFor(() => {
      expect(encryptBackupBlob).toHaveBeenCalledWith(
        MOCK_KEY,
        'SuperSecurePassphrase!99',
        FALLBACK_ADDR,
      )
    })
  })

  it('shows success state after download', async () => {
    render(<ReDownloadBackupDialog {...buildProps()} />)
    await fillPasswords('SuperSecurePassphrase!99', 'SuperSecurePassphrase!99')
    await userEvent.click(screen.getByTestId('download-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('download-success')).toBeInTheDocument()
    })
  })

  it('shows error when encryptBackupBlob throws', async () => {
    const { encryptBackupBlob } = await import('~/services/identity/backupBlob')
    vi.mocked(encryptBackupBlob).mockRejectedValueOnce(new Error('Crypto failure'))

    render(<ReDownloadBackupDialog {...buildProps()} />)
    await fillPasswords('SuperSecurePassphrase!99', 'SuperSecurePassphrase!99')
    await userEvent.click(screen.getByTestId('download-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('download-error')).toBeInTheDocument()
      expect(screen.getByTestId('download-error')).toHaveTextContent('Crypto failure')
    })
  })

  it('shows the strength meter when a password is entered', async () => {
    render(<ReDownloadBackupDialog {...buildProps()} />)
    await userEvent.type(screen.getByTestId('new-password-input'), 'test')
    expect(screen.getByTestId('strength-meter')).toBeInTheDocument()
  })

  it('shows the fallback address in the form', () => {
    render(<ReDownloadBackupDialog {...buildProps()} />)
    expect(screen.getByText(FALLBACK_ADDR)).toBeInTheDocument()
  })
})
