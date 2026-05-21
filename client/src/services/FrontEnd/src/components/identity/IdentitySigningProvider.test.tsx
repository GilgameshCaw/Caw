/**
 * IdentitySigningProvider.test.tsx
 *
 * Tests for the IdentitySigningProvider context and useIdentitySigning hook.
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  IdentitySigningProvider,
  useIdentitySigning,
} from './IdentitySigningProvider'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('~/hooks/useTheme', () => ({
  useTheme: () => ({ isDark: true }),
}))

// ─── Consumer component for testing ──────────────────────────────────────────

function TestConsumer(): JSX.Element {
  const { isSigning, message, startSigning, stopSigning } = useIdentitySigning()

  return (
    <div>
      <p data-testid="is-signing">{isSigning ? 'signing' : 'idle'}</p>
      <p data-testid="message">{message}</p>
      <button
        type="button"
        data-testid="start-btn"
        onClick={() => startSigning('Authenticate with passkey')}
      >
        Start
      </button>
      <button
        type="button"
        data-testid="stop-btn"
        onClick={() => stopSigning()}
      >
        Stop
      </button>
      <button
        type="button"
        data-testid="start-default-btn"
        onClick={() => startSigning()}
      >
        Start default
      </button>
    </div>
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IdentitySigningProvider', () => {
  it('initial state is idle with empty message', () => {
    render(
      <IdentitySigningProvider>
        <TestConsumer />
      </IdentitySigningProvider>,
    )

    expect(screen.getByTestId('is-signing').textContent).toBe('idle')
    expect(screen.getByTestId('message').textContent).toBe('')
  })

  it('startSigning sets isSigning=true and custom message', async () => {
    render(
      <IdentitySigningProvider>
        <TestConsumer />
      </IdentitySigningProvider>,
    )

    await userEvent.click(screen.getByTestId('start-btn'))

    expect(screen.getByTestId('is-signing').textContent).toBe('signing')
    expect(screen.getByTestId('message').textContent).toBe('Authenticate with passkey')
  })

  it('startSigning without argument uses default message', async () => {
    render(
      <IdentitySigningProvider>
        <TestConsumer />
      </IdentitySigningProvider>,
    )

    await userEvent.click(screen.getByTestId('start-default-btn'))

    expect(screen.getByTestId('is-signing').textContent).toBe('signing')
    expect(screen.getByTestId('message').textContent).toBe('Please authenticate with your passkey')
  })

  it('stopSigning clears isSigning and message', async () => {
    render(
      <IdentitySigningProvider>
        <TestConsumer />
      </IdentitySigningProvider>,
    )

    await userEvent.click(screen.getByTestId('start-btn'))
    expect(screen.getByTestId('is-signing').textContent).toBe('signing')

    await userEvent.click(screen.getByTestId('stop-btn'))
    expect(screen.getByTestId('is-signing').textContent).toBe('idle')
    expect(screen.getByTestId('message').textContent).toBe('')
  })

  it('shows the overlay when isSigning=true', async () => {
    render(
      <IdentitySigningProvider>
        <TestConsumer />
      </IdentitySigningProvider>,
    )

    expect(screen.queryByTestId('identity-signing-overlay')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('start-btn'))

    expect(screen.getByTestId('identity-signing-overlay')).toBeInTheDocument()
  })

  it('hides the overlay when stopSigning is called', async () => {
    render(
      <IdentitySigningProvider>
        <TestConsumer />
      </IdentitySigningProvider>,
    )

    await userEvent.click(screen.getByTestId('start-btn'))
    expect(screen.getByTestId('identity-signing-overlay')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('stop-btn'))
    expect(screen.queryByTestId('identity-signing-overlay')).not.toBeInTheDocument()
  })

  it('overlay shows the signing message', async () => {
    render(
      <IdentitySigningProvider>
        <TestConsumer />
      </IdentitySigningProvider>,
    )

    await userEvent.click(screen.getByTestId('start-btn'))

    expect(screen.getByTestId('identity-signing-overlay')).toHaveTextContent(
      'Authenticate with passkey',
    )
  })
})
