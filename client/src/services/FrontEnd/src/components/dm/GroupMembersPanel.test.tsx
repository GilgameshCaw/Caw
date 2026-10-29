/**
 * GroupMembersPanel.test.tsx
 *
 * The invite "Hours" and "Max uses" fields must let the owner clear the value
 * and type a new one; they are only coerced to a number on Mint / blur.
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GroupMembersPanel from './GroupMembersPanel'

vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/api/client', () => ({ apiFetch: vi.fn() }))
vi.mock('~/components/Avatar', () => ({ UserAvatar: () => null }))

async function setup() {
  const onMintInvite = vi.fn(async (_id: string, p: { expiresAt: string; maxUses: number }) => ({
    id: 'i1', token: 't1', expiresAt: p.expiresAt, maxUses: p.maxUses, useCount: 0,
  }))
  render(
    <GroupMembersPanel
      isOpen
      onClose={() => {}}
      conversationId="c1"
      members={[]}
      currentUserId={1}
      myRole="OWNER"
      onAddMembers={vi.fn()}
      onRemoveMember={vi.fn()}
      onLeaveGroup={vi.fn()}
      onRenameGroup={vi.fn()}
      onMintInvite={onMintInvite}
      onRevokeInvite={vi.fn()}
      onListInvites={async () => ({ invites: [] })}
    />,
  )
  await act(async () => {}) // let the initial onListInvites resolve
  const [hours, maxUses] = screen.getAllByRole('spinbutton') as HTMLInputElement[]
  return { hours, maxUses, onMintInvite, user: userEvent.setup() }
}

describe('GroupMembersPanel / invite fields', () => {
  it('shows the defaults', async () => {
    const { hours, maxUses } = await setup()
    expect(hours.value).toBe('24')
    expect(maxUses.value).toBe('5')
  })

  it('lets Max uses be cleared and a new value typed', async () => {
    const { maxUses, user, onMintInvite } = await setup()
    await user.clear(maxUses)
    expect(maxUses.value).toBe('')
    await user.type(maxUses, '3')
    expect(maxUses.value).toBe('3')
    await user.click(screen.getByText('Mint'))
    expect(onMintInvite).toHaveBeenCalledTimes(1)
    expect(onMintInvite.mock.calls[0][1].maxUses).toBe(3)
  })

  it('lets Hours be cleared and a new value typed', async () => {
    const { hours, user, onMintInvite } = await setup()
    await user.clear(hours)
    expect(hours.value).toBe('')
    await user.type(hours, '48')
    expect(hours.value).toBe('48')
    const before = Date.now()
    await user.click(screen.getByText('Mint'))
    const ms = new Date(onMintInvite.mock.calls[0][1].expiresAt).getTime() - before
    expect(ms).to.be.within(48 * 3600e3 - 5000, 48 * 3600e3 + 5000)
  })

  it('keeps a fractional Hours value, as before, but whole numbers for Max uses', async () => {
    const { hours, maxUses, user, onMintInvite } = await setup()
    await user.clear(hours)
    await user.type(hours, '1.5')
    await user.clear(maxUses)
    await user.type(maxUses, '2.5')
    const before = Date.now()
    await user.click(screen.getByText('Mint'))
    const params = onMintInvite.mock.calls[0][1]
    expect(new Date(params.expiresAt).getTime() - before).to.be.within(1.5 * 3600e3 - 5000, 1.5 * 3600e3 + 5000)
    expect(params.maxUses).toBe(2)
    expect(hours.value).toBe('1.5')
    expect(maxUses.value).toBe('2')
  })

  it('drops the fraction of Max uses instead of rounding it', async () => {
    const { maxUses, user, onMintInvite } = await setup()
    await user.clear(maxUses)
    await user.type(maxUses, '2.9')
    await user.click(screen.getByText('Mint'))
    expect(onMintInvite.mock.calls[0][1].maxUses).toBe(2)
  })

  it('puts 1 back when Hours is left empty or below 1', async () => {
    const { hours, user } = await setup()
    await user.clear(hours)
    await user.tab()
    expect(hours.value).toBe('1')
    await user.clear(hours)
    await user.type(hours, '0.2')
    await user.tab()
    expect(hours.value).toBe('1')
  })

  it('puts 1 back when the field is left empty', async () => {
    const { maxUses, user } = await setup()
    await user.clear(maxUses)
    await user.tab()
    expect(maxUses.value).toBe('1')
  })

  it('clamps Max uses to the 1..100 the server accepts', async () => {
    const { maxUses, user, onMintInvite } = await setup()
    await user.clear(maxUses)
    await user.type(maxUses, '500')
    await user.click(screen.getByText('Mint'))
    expect(onMintInvite.mock.calls[0][1].maxUses).toBe(100)
    expect(maxUses.value).toBe('100')
  })
})
