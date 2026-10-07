/**
 * ReportsAdmin: cancelling the "Action" resolution-note prompt must leave the
 * report untouched. prompt() returns null on cancel; an empty string means
 * "confirmed without a note" and still goes through (the note is optional).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('~/api/client', () => ({ apiFetch }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: true }) }))
vi.mock('~/utils/localizedRouter', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}))

import ReportsAdmin from './ReportsAdmin'

const report = {
  id: 1,
  reporterId: 7,
  postId: 5,
  postAuthorId: 4,
  reason: 'SPAM',
  details: null,
  status: 'PENDING',
  reviewedAt: null,
  reviewedBy: null,
  resolution: 'earlier note',
  createdAt: '2026-10-06T00:00:00.000Z',
}

const patchCalls = () => apiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')

async function clickAction(promptResult: string | null) {
  const promptStub = vi.fn(() => promptResult)
  vi.stubGlobal('prompt', promptStub)
  render(
    <MemoryRouter>
      <ReportsAdmin />
    </MemoryRouter>,
  )
  const button = await screen.findByRole('button', { name: 'Action' })
  await userEvent.click(button)
  return promptStub
}

describe('ReportsAdmin "Action" button', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return { success: true }
      return { reports: [report], total: 1 }
    })
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('does not update the report when the prompt is cancelled', async () => {
    const promptStub = await clickAction(null)
    expect(promptStub).toHaveBeenCalledTimes(1)
    expect(patchCalls()).toHaveLength(0)
  })

  it('marks the report ACTIONED with the note', async () => {
    await clickAction('handled')
    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    const [path, init] = patchCalls()[0]
    expect(path).toBe('/api/reports/1')
    expect(JSON.parse(init.body)).toEqual({ status: 'ACTIONED', resolution: 'handled' })
  })

  it('an empty note still goes through (the note is optional)', async () => {
    await clickAction('')
    await waitFor(() => expect(patchCalls()).toHaveLength(1))
    expect(JSON.parse(patchCalls()[0][1].body)).toEqual({ status: 'ACTIONED' })
  })
})
