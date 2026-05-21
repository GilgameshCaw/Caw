/**
 * Recovery.test.tsx
 *
 * Tests for the Recovery page state machine:
 *   file-select → password → success
 *
 * Tests cover:
 *  - Valid file upload advances to password step
 *  - Invalid JSON file shows error without advancing
 *  - Missing required fields shows "not a valid backup" error
 *  - Wrong password shows retry message (file NOT cleared)
 *  - Corrupted blob (OperationError from AES-GCM) shows decrypt-failed error
 *  - Successful decrypt advances to success step
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...(actual as object),
    useNavigate: vi.fn(() => vi.fn()),
  }
})

vi.mock('~/hooks/useTheme', () => ({
  useTheme: vi.fn(() => ({ isDark: true })),
}))

vi.mock('~/i18n/I18nProvider', () => ({
  useT: vi.fn(() => (key: string) => key),
}))

vi.mock('~/utils/localizedRouter', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
    React.createElement('a', { href: to }, children),
}))

// ─── backupBlob mocks ─────────────────────────────────────────────────────────

const mockDecryptBackupBlob = vi.fn()
const mockValidateBackupBlobShape = vi.fn()

vi.mock('~/services/identity/backupBlob', () => ({
  decryptBackupBlob: (...args: unknown[]) => mockDecryptBackupBlob(...args),
  validateBackupBlobShape: (...args: unknown[]) => mockValidateBackupBlobShape(...args),
}))

// ─── RecoveryProvider mock ────────────────────────────────────────────────────

const mockSetKey = vi.fn()
const mockClearKey = vi.fn()

vi.mock('~/components/identity/RecoveryProvider', () => ({
  useRecoveryContext: vi.fn(() => ({
    privateKey: null,
    address: null,
    isInRecoveryMode: false,
    setKey: mockSetKey,
    clearKey: mockClearKey,
  })),
}))

// ─── viem/accounts mock ───────────────────────────────────────────────────────

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
  })),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

import Recovery from './Recovery'

function renderRecovery() {
  return render(
    React.createElement(MemoryRouter, null,
      React.createElement(Recovery)
    )
  )
}

/** Build a minimal valid BackupBlob JSON string */
const VALID_BLOB_JSON = JSON.stringify({
  version: 1,
  argon2: { memorySize: 65536, iterations: 3, parallelism: 1 },
  salt: '0xdeadbeefdeadbeefdeadbeefdeadbeef',
  iv: '0xdeadbeefdeadbeefdead0000',
  ciphertext: '0x' + 'aa'.repeat(48),
  pubkeyAddress: '0xaAbBcCdDeEfF001122334455667788990011aabb',
})

/** Simulate uploading a file via the hidden input */
function simulateFileUpload(container: HTMLElement, content: string, type = 'application/json') {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).not.toBeNull()
  const file = new File([content], 'backup.json', { type })
  // FileReader reads in happy-dom; trigger change
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Recovery page — file-select step', () => {
  it('renders the file select step initially', () => {
    renderRecovery()
    expect(screen.getByText('recovery.title')).toBeInTheDocument()
    expect(screen.getByText('recovery.file_select.cta')).toBeInTheDocument()
  })

  it('advances to password step on valid file upload', async () => {
    mockValidateBackupBlobShape.mockReturnValue(true)
    const { container } = renderRecovery()

    simulateFileUpload(container, VALID_BLOB_JSON)

    await waitFor(() => {
      expect(screen.getByText('recovery.password.decrypt_cta')).toBeInTheDocument()
    })
  })

  it('shows error on invalid JSON upload', async () => {
    mockValidateBackupBlobShape.mockReturnValue(false)
    const { container } = renderRecovery()

    simulateFileUpload(container, 'not valid json at all {{{')

    await waitFor(() => {
      expect(screen.getByText('recovery.error.not_valid_backup')).toBeInTheDocument()
    })
    // Should still be on file-select step
    expect(screen.getByText('recovery.file_select.cta')).toBeInTheDocument()
  })

  it('shows error when JSON is valid but blob shape is wrong', async () => {
    mockValidateBackupBlobShape.mockReturnValue(false)
    const { container } = renderRecovery()

    simulateFileUpload(container, JSON.stringify({ foo: 'bar' }))

    await waitFor(() => {
      expect(screen.getByText('recovery.error.not_valid_backup')).toBeInTheDocument()
    })
    expect(screen.getByText('recovery.file_select.cta')).toBeInTheDocument()
  })
})

describe('Recovery page — password step', () => {
  async function advanceToPasswordStep(container: HTMLElement) {
    mockValidateBackupBlobShape.mockReturnValue(true)
    simulateFileUpload(container, VALID_BLOB_JSON)
    await waitFor(() => {
      expect(screen.getByText('recovery.password.decrypt_cta')).toBeInTheDocument()
    })
  }

  it('shows wrong-password error on failed decrypt (non-corrupted)', async () => {
    const { container } = renderRecovery()
    await advanceToPasswordStep(container)

    // Decrypt throws a generic error (wrong password)
    mockDecryptBackupBlob.mockRejectedValue(new Error('Incorrect vault password.'))

    const input = screen.getByPlaceholderText('recovery.password.placeholder') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'wrongpassword' } })
    fireEvent.click(screen.getByText('recovery.password.decrypt_cta'))

    await waitFor(() => {
      expect(screen.getByText('recovery.error.wrong_password')).toBeInTheDocument()
    })
    // File is NOT cleared — still on password step, not back to file-select
    expect(screen.getByText('recovery.password.decrypt_cta')).toBeInTheDocument()
  })

  it('shows decrypt-failed error when error message mentions "corrupted"', async () => {
    const { container } = renderRecovery()
    await advanceToPasswordStep(container)

    mockDecryptBackupBlob.mockRejectedValue(new Error('Incorrect vault password or corrupted backup blob.'))

    const input = screen.getByPlaceholderText('recovery.password.placeholder') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'anypassword' } })
    fireEvent.click(screen.getByText('recovery.password.decrypt_cta'))

    await waitFor(() => {
      expect(screen.getByText('recovery.error.decrypt_failed')).toBeInTheDocument()
    })
  })

  it('advances to success step on successful decrypt', async () => {
    const { container } = renderRecovery()
    await advanceToPasswordStep(container)

    // Return 32-byte Uint8Array
    const fakePrivKeyBytes = new Uint8Array(32).fill(0x41)
    mockDecryptBackupBlob.mockResolvedValue(fakePrivKeyBytes)

    const input = screen.getByPlaceholderText('recovery.password.placeholder') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'correctpassword' } })

    await act(async () => {
      fireEvent.click(screen.getByText('recovery.password.decrypt_cta'))
    })

    await waitFor(() => {
      expect(screen.getByText('recovery.success.heading')).toBeInTheDocument()
    })
    expect(mockSetKey).toHaveBeenCalledOnce()
    const calledKey: string = mockSetKey.mock.calls[0][0]
    expect(calledKey).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('goes back to file-select when "Change file" is clicked', async () => {
    const { container } = renderRecovery()
    await advanceToPasswordStep(container)

    fireEvent.click(screen.getByText('recovery.password.change_file'))

    await waitFor(() => {
      expect(screen.getByText('recovery.file_select.cta')).toBeInTheDocument()
    })
  })
})
