/**
 * RemovePasskeyDialog.test.tsx
 *
 * Component tests for the N=1 self-removal vault-password confirmation guard.
 *
 * Test framework: Vitest + @testing-library/react
 * These packages are NOT yet in package.json. Before running:
 *
 *   yarn add -D vitest @vitest/ui @testing-library/react \
 *     @testing-library/user-event @testing-library/jest-dom \
 *     jsdom @vitejs/plugin-react-swc
 *
 * Add a `test` script to package.json:
 *   "test": "vitest run"
 *
 * Add to vite.config.ts (inside defineConfig):
 *   test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] }
 *
 * Create src/test-setup.ts:
 *   import '@testing-library/jest-dom'
 *
 * The verifyVaultPassword callback is always mocked in these tests — the real
 * implementation lives in Step 4c's identity service layer and is out of scope.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RemovePasskeyDialog, type BackupBlob, type RemovePasskeyDialogProps } from './RemovePasskeyDialog'

// ─── Mock external dependencies ──────────────────────────────────────────────

// ModalWrapper uses createPortal — redirect to a simple div wrapper in tests
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

// Minimal i18n stub — returns the key so assertions can match on key strings
vi.mock('~/i18n/I18nProvider', () => ({
  useT: () => (key: string) => key,
}))

// ─── Test helpers ─────────────────────────────────────────────────────────────

const FALLBACK_ADDR = '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf' as `0x${string}`
const TARGET_HASH   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`

const VALID_BLOB: BackupBlob = {
  encryptedKey: 'deadbeef',
  ecdsaFallbackAddress: FALLBACK_ADDR,
  version: 'argon2id-v1',
}

const WRONG_ADDR_BLOB: BackupBlob = {
  encryptedKey: 'cafecafe',
  ecdsaFallbackAddress: '0x1111111111111111111111111111111111111111',
  version: 'argon2id-v1',
}

function blobToFile(blob: BackupBlob, name = 'backup.json'): File {
  const json = JSON.stringify(blob)
  return new File([json], name, { type: 'application/json' })
}

function malformedFile(name = 'bad.json'): File {
  return new File(['not { valid json{{'], name, { type: 'application/json' })
}

function missingFieldsFile(name = 'incomplete.json'): File {
  return new File([JSON.stringify({ foo: 'bar' })], name, { type: 'application/json' })
}

function buildProps(overrides: Partial<RemovePasskeyDialogProps> = {}): RemovePasskeyDialogProps {
  return {
    open: true,
    onClose: vi.fn(),
    targetPasskeyHash: TARGET_HASH,
    activePasskeyCount: 1,
    ecdsaFallbackAddr: FALLBACK_ADDR,
    verifyVaultPassword: vi.fn(),
    onConfirm: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function uploadFile(file: File): Promise<void> {
  const input = screen.getByTestId('file-input') as HTMLInputElement
  await userEvent.upload(input, file)
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('RemovePasskeyDialog — N=1 (last passkey)', () => {
  it('remove button is disabled by default (no file, no password)', () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    const btn = screen.getByTestId('vault-remove-btn')
    expect(btn).toBeDisabled()
  })

  it('remove button stays disabled after file upload with no password', async () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    await uploadFile(blobToFile(VALID_BLOB))
    const btn = screen.getByTestId('vault-remove-btn')
    expect(btn).toBeDisabled()
  })

  it('remove button stays disabled after password entry with no file', async () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    const pwInput = screen.getByTestId('vault-password-input')
    await userEvent.type(pwInput, 'mysecret')
    const btn = screen.getByTestId('vault-remove-btn')
    expect(btn).toBeDisabled()
  })

  it('remove button is enabled after valid file + password (with verifyVaultPassword provided)', async () => {
    const verifyVaultPassword = vi.fn().mockResolvedValue({ valid: true, addressMatches: true })
    render(<RemovePasskeyDialog {...buildProps({ verifyVaultPassword })} />)

    await uploadFile(blobToFile(VALID_BLOB))
    const pwInput = screen.getByTestId('vault-password-input')
    await userEvent.type(pwInput, 'mysecret')

    const btn = screen.getByTestId('vault-remove-btn')
    expect(btn).not.toBeDisabled()
  })

  it('remove button stays disabled when verifyVaultPassword is not provided', async () => {
    render(<RemovePasskeyDialog {...buildProps({ verifyVaultPassword: undefined })} />)

    await uploadFile(blobToFile(VALID_BLOB))
    const pwInput = screen.getByTestId('vault-password-input')
    await userEvent.type(pwInput, 'mysecret')

    const btn = screen.getByTestId('vault-remove-btn')
    expect(btn).toBeDisabled()
  })

  it('shows wrong-password error when verifyVaultPassword returns valid=false', async () => {
    const verifyVaultPassword = vi.fn().mockResolvedValue({ valid: false, addressMatches: false })
    render(<RemovePasskeyDialog {...buildProps({ verifyVaultPassword })} />)

    await uploadFile(blobToFile(VALID_BLOB))
    const pwInput = screen.getByTestId('vault-password-input')
    await userEvent.type(pwInput, 'wrongpass')

    const btn = screen.getByTestId('vault-remove-btn')
    await userEvent.click(btn)

    await waitFor(() => {
      expect(screen.getByTestId('error-wrong-password')).toBeInTheDocument()
    })
    expect(verifyVaultPassword).toHaveBeenCalledWith('wrongpass', VALID_BLOB)
  })

  it('remove button is re-disabled and error shown after wrong password', async () => {
    const verifyVaultPassword = vi.fn().mockResolvedValue({ valid: false, addressMatches: false })
    render(<RemovePasskeyDialog {...buildProps({ verifyVaultPassword })} />)

    await uploadFile(blobToFile(VALID_BLOB))
    await userEvent.type(screen.getByTestId('vault-password-input'), 'wrongpass')
    await userEvent.click(screen.getByTestId('vault-remove-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('error-wrong-password')).toBeInTheDocument()
    })
    // Button should be enabled again (user can retry), not disabled
    expect(screen.getByTestId('vault-remove-btn')).not.toBeDisabled()
  })

  it('calls onConfirm({ unlocked: true }) after successful vault verification', async () => {
    const verifyVaultPassword = vi.fn().mockResolvedValue({ valid: true, addressMatches: true })
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()

    render(<RemovePasskeyDialog {...buildProps({ verifyVaultPassword, onConfirm, onClose })} />)

    await uploadFile(blobToFile(VALID_BLOB))
    await userEvent.type(screen.getByTestId('vault-password-input'), 'correctpass')
    await userEvent.click(screen.getByTestId('vault-remove-btn'))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ unlocked: true })
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows wrong-address error when blob address does not match ecdsaFallbackAddr', async () => {
    const verifyVaultPassword = vi.fn().mockResolvedValue({ valid: true, addressMatches: false })
    render(<RemovePasskeyDialog {...buildProps({ verifyVaultPassword })} />)

    await uploadFile(blobToFile(WRONG_ADDR_BLOB))
    await userEvent.type(screen.getByTestId('vault-password-input'), 'correctpass')
    await userEvent.click(screen.getByTestId('vault-remove-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('error-wrong-address')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('error-wrong-password')).not.toBeInTheDocument()
  })

  it('shows bad-json error when uploaded file contains malformed JSON', async () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    await uploadFile(malformedFile())

    await waitFor(() => {
      expect(screen.getByTestId('error-bad-json')).toBeInTheDocument()
    })
    // Blob should not be set — remove button stays disabled even if password entered
    await userEvent.type(screen.getByTestId('vault-password-input'), 'pass')
    expect(screen.getByTestId('vault-remove-btn')).toBeDisabled()
  })

  it('shows bad-json error when uploaded JSON is missing required fields', async () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    await uploadFile(missingFieldsFile())

    await waitFor(() => {
      expect(screen.getByTestId('error-bad-json')).toBeInTheDocument()
    })
  })

  it('shows file name after a valid backup file is loaded', async () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    await uploadFile(blobToFile(VALID_BLOB, 'my-backup-2026.json'))

    await waitFor(() => {
      expect(screen.getByText('my-backup-2026.json')).toBeInTheDocument()
    })
  })

  it('clears stale wrong-password error when user starts re-typing password', async () => {
    const verifyVaultPassword = vi.fn().mockResolvedValue({ valid: false, addressMatches: false })
    render(<RemovePasskeyDialog {...buildProps({ verifyVaultPassword })} />)

    await uploadFile(blobToFile(VALID_BLOB))
    const pwInput = screen.getByTestId('vault-password-input')
    await userEvent.type(pwInput, 'wrong')
    await userEvent.click(screen.getByTestId('vault-remove-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('error-wrong-password')).toBeInTheDocument()
    })

    // Start re-typing — error should clear
    await userEvent.type(pwInput, 'X')
    expect(screen.queryByTestId('error-wrong-password')).not.toBeInTheDocument()
  })

  it('does not render when open=false', () => {
    render(<RemovePasskeyDialog {...buildProps({ open: false })} />)
    expect(screen.queryByTestId('modal-wrapper')).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RemovePasskeyDialog — N=2 (multiple passkeys)', () => {
  it('renders the simple confirm dialog, not the vault form', () => {
    render(<RemovePasskeyDialog {...buildProps({ activePasskeyCount: 2 })} />)
    expect(screen.queryByTestId('vault-password-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('upload-backup-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('simple-remove-btn')).toBeInTheDocument()
  })

  it('remove button is enabled by default (no guard required)', () => {
    render(<RemovePasskeyDialog {...buildProps({ activePasskeyCount: 2 })} />)
    expect(screen.getByTestId('simple-remove-btn')).not.toBeDisabled()
  })

  it('calls onConfirm({ unlocked: false }) on confirm click', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onClose   = vi.fn()
    render(
      <RemovePasskeyDialog
        {...buildProps({ activePasskeyCount: 2, onConfirm, onClose })}
      />,
    )

    await userEvent.click(screen.getByTestId('simple-remove-btn'))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ unlocked: false })
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose on cancel click without calling onConfirm', async () => {
    const onConfirm = vi.fn()
    const onClose   = vi.fn()
    render(
      <RemovePasskeyDialog
        {...buildProps({ activePasskeyCount: 2, onConfirm, onClose })}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('also works for N=3 and higher', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<RemovePasskeyDialog {...buildProps({ activePasskeyCount: 3, onConfirm })} />)

    expect(screen.getByTestId('simple-remove-btn')).not.toBeDisabled()
    await userEvent.click(screen.getByTestId('simple-remove-btn'))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({ unlocked: false })
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RemovePasskeyDialog — accessibility', () => {
  it('error messages use role="alert" for screen reader announcement', async () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    await uploadFile(malformedFile())

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert).toBeInTheDocument()
    })
  })

  it('password input has autocomplete=off, autocorrect=off, autocapitalize=off', () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    const input = screen.getByTestId('vault-password-input')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('autocorrect', 'off')
    expect(input).toHaveAttribute('autocapitalize', 'off')
  })

  it('file input accepts only .json files', () => {
    render(<RemovePasskeyDialog {...buildProps()} />)
    const input = screen.getByTestId('file-input')
    expect(input).toHaveAttribute('accept', '.json')
  })
})
