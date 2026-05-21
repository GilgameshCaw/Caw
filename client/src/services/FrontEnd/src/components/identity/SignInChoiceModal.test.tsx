/**
 * SignInChoiceModal.test.tsx
 *
 * Tests for SignInChoiceModal:
 *   - Renders both options when open
 *   - Calls onWalletPath when wallet button clicked
 *   - Calls onPasskeyPath when passkey button clicked
 *   - Recovery link navigates to /recovery and closes modal
 *   - Does not render content when open=false
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SignInChoiceModal, type SignInChoiceModalProps } from './SignInChoiceModal'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn()

vi.mock('~/utils/localizedRouter', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}))

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProps(overrides: Partial<SignInChoiceModalProps> = {}): SignInChoiceModalProps {
  return {
    open: true,
    onClose: vi.fn(),
    onWalletPath: vi.fn(),
    onPasskeyPath: vi.fn(),
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SignInChoiceModal', () => {
  beforeEach(() => {
    mockNavigate.mockClear()
  })

  it('renders both choice buttons and recovery link when open', () => {
    render(<SignInChoiceModal {...buildProps()} />)

    expect(screen.getByTestId('modal-wrapper')).toBeInTheDocument()
    expect(screen.getByTestId('wallet-choice-btn')).toBeInTheDocument()
    expect(screen.getByTestId('passkey-choice-btn')).toBeInTheDocument()
    expect(screen.getByTestId('recovery-link')).toBeInTheDocument()
  })

  it('does not render content when open=false', () => {
    render(<SignInChoiceModal {...buildProps({ open: false })} />)

    expect(screen.queryByTestId('modal-wrapper')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wallet-choice-btn')).not.toBeInTheDocument()
  })

  it('calls onWalletPath and onClose when wallet button clicked', async () => {
    const onClose = vi.fn()
    const onWalletPath = vi.fn()
    render(<SignInChoiceModal {...buildProps({ onClose, onWalletPath })} />)

    await userEvent.click(screen.getByTestId('wallet-choice-btn'))

    expect(onWalletPath).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onPasskeyPath and onClose when passkey button clicked', async () => {
    const onClose = vi.fn()
    const onPasskeyPath = vi.fn()
    render(<SignInChoiceModal {...buildProps({ onClose, onPasskeyPath })} />)

    await userEvent.click(screen.getByTestId('passkey-choice-btn'))

    expect(onPasskeyPath).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('navigates to /recovery and calls onClose when recovery link clicked', async () => {
    const onClose = vi.fn()
    render(<SignInChoiceModal {...buildProps({ onClose })} />)

    await userEvent.click(screen.getByTestId('recovery-link'))

    expect(mockNavigate).toHaveBeenCalledWith('/recovery')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('displays i18n keys for wallet and passkey options', () => {
    render(<SignInChoiceModal {...buildProps()} />)

    // useT stub returns key as-is; verify the keys are rendered
    expect(screen.getByText('signin_choice.wallet.label')).toBeInTheDocument()
    expect(screen.getByText('signin_choice.passkey.label')).toBeInTheDocument()
    expect(screen.getByText('signin_choice.recovery_link')).toBeInTheDocument()
  })
})
