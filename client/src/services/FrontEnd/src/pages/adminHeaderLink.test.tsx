/**
 * The header link of the reports pages goes back to the area the page was
 * opened from: /admin for admins, /moderation for moderators (AdminGate
 * refuses moderators).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('~/api/client', () => ({ apiFetch }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: true }) }))
vi.mock('~/utils/localizedRouter', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}))

import ReportsAdmin from './ReportsAdmin'
import BugReportsAdmin from './BugReportsAdmin'
import { adminHomeFor } from '~/utils/adminHome'

const pages = [
  { name: 'ReportsAdmin', Page: ReportsAdmin, slug: 'reports' },
  { name: 'BugReportsAdmin', Page: BugReportsAdmin, slug: 'bugs' },
]

describe('adminHomeFor', () => {
  it('points /admin pages at /admin', () => {
    expect(adminHomeFor('/admin/reports')).toEqual({ to: '/admin', label: 'Admin' })
  })
  it('points /moderation pages at /moderation', () => {
    expect(adminHomeFor('/moderation')).toEqual({ to: '/moderation', label: 'Moderation' })
    expect(adminHomeFor('/moderation/bugs')).toEqual({ to: '/moderation', label: 'Moderation' })
  })
  it('does not treat a path that only starts with the same letters as /moderation', () => {
    expect(adminHomeFor('/moderationx/reports')).toEqual({ to: '/admin', label: 'Admin' })
  })
  it('looks past a locale prefix', () => {
    expect(adminHomeFor('/ja/moderation/reports')).toEqual({ to: '/moderation', label: 'Moderation' })
    expect(adminHomeFor('/ja/admin/reports')).toEqual({ to: '/admin', label: 'Admin' })
    expect(adminHomeFor('/en/moderation/bugs')).toEqual({ to: '/moderation', label: 'Moderation' })
  })
})

describe.each(pages)('$name header link', ({ Page, slug }) => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValue({ reports: [], total: 0 })
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

  async function headerLink(path: string) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Page />
      </MemoryRouter>,
    )
    return screen.findByRole('link', { name: /^(Admin|Moderation)$/ })
  }

  it('goes to /admin when opened under /admin', async () => {
    const link = await headerLink(`/admin/${slug}`)
    expect(link.getAttribute('href')).toBe('/admin')
    expect(link.textContent).toBe('Admin')
  })

  it('goes to /moderation when opened under /moderation', async () => {
    const link = await headerLink(`/moderation/${slug}`)
    expect(link.getAttribute('href')).toBe('/moderation')
    expect(link.textContent).toBe('Moderation')
  })
})
