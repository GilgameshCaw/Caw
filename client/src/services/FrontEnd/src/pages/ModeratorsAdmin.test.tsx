import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const calls = vi.hoisted(() => [] as { url: string; init?: any }[])
vi.mock('~/api/client', () => ({
  apiFetch: vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    if (url === '/api/admin/users/elevated') return { users: [] }
    if (url === '/api/users/missing') throw new Error('User not found')
    if (url.startsWith('/api/users/')) return { tokenId: 777 } // the account the name belongs to
    return { success: true }
  }),
}))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/utils/localizedRouter', () => ({ Link: ({ children }: any) => <a>{children}</a> }))

import ModeratorsAdmin from './ModeratorsAdmin'

const assign = async (typed: string) => {
  calls.length = 0
  render(<ModeratorsAdmin />)
  fireEvent.change(screen.getByPlaceholderText('tokenId or @username'), { target: { value: typed } })
  fireEvent.click(screen.getByText('Set MODERATOR'))
}
const posted = () => calls.filter(c => c.init?.method === 'POST').map(c => c.url)
const lookups = () => calls.filter(c => c.url.startsWith('/api/users/')).map(c => c.url)

describe('ModeratorsAdmin target', () => {
  beforeEach(() => cleanup())
  afterEach(() => cleanup())

  it('looks up @2024 as a username, not as tokenId 2024', async () => {
    await assign('@2024')
    await waitFor(() => expect(posted().length).toBe(1))
    expect(lookups()).toEqual(['/api/users/2024'])
    expect(posted()).toEqual(['/api/admin/users/777/role'])
  })

  it('still takes bare digits as a tokenId, with no lookup', async () => {
    await assign('108')
    await waitFor(() => expect(posted().length).toBe(1))
    expect(lookups()).toEqual([])
    expect(posted()).toEqual(['/api/admin/users/108/role'])
  })

  it('still looks up @alice and alice', async () => {
    await assign('@alice')
    await waitFor(() => expect(posted()).toEqual(['/api/admin/users/777/role']))
    expect(lookups()).toEqual(['/api/users/alice'])
    cleanup()
    await assign('alice')
    await waitFor(() => expect(posted()).toEqual(['/api/admin/users/777/role']))
    expect(lookups()).toEqual(['/api/users/alice'])
  })

  it('assigns nothing when the @ name has no account', async () => {
    await assign('@missing')
    await screen.findByText('Could not resolve user. Enter a tokenId or @username.')
    expect(posted()).toEqual([])
  })

  it('assigns nothing for a lone @', async () => {
    await assign('@')
    await screen.findByText('Could not resolve user. Enter a tokenId or @username.')
    expect(posted()).toEqual([])
  })
})
