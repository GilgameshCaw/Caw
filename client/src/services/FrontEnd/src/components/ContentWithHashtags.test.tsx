import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import ContentWithHashtags from './ContentWithHashtags'

vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/' }) }))
vi.mock('~/utils/localizedRouter', () => ({ useNavigate: () => vi.fn() }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (key: string) => key }))
vi.mock('~/api/client', () => ({ apiFetch: vi.fn() }))
vi.mock('~/components/PostVideo', () => ({ default: () => null }))
vi.mock('~/components/ImageLightbox', () => ({ default: () => null }))
vi.mock('~/components/Tooltip', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

// The app has only a root error boundary, so a throw while rendering a post
// takes down the whole page. This one turns that into something a test can see.
class Boundary extends React.Component<{ children: React.ReactNode }, { thrown: string | null }> {
  state = { thrown: null as string | null }
  static getDerivedStateFromError(err: unknown) {
    return { thrown: String(err) }
  }
  render() {
    return this.state.thrown ? <div data-testid="thrown">{this.state.thrown}</div> : this.props.children
  }
}

// The resolved values are cached per host + code at module level.
let codeCounter = 0

async function renderPost(makeText: (shortUrl: string) => string, body: unknown) {
  const shortUrl = `https://other-node.example/s/code${++codeCounter}`
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))
  vi.stubGlobal('fetch', fetchMock)
  const { container } = render(
    <Boundary>
      <ContentWithHashtags content={makeText(shortUrl)} />
    </Boundary>,
  )
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeNull())
  expect(screen.queryByTestId('thrown')).toBeNull()
  return { container, shortUrl }
}

describe('ContentWithHashtags, short URL on another node', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows the resolved URL and a preview card for a well-formed response', async () => {
    const { container, shortUrl } = await renderPost(url => url, {
      originalUrl: 'https://example.com/page',
      title: 'A title',
    })
    await waitFor(() => expect(screen.getByText('example.com/page')).toBeTruthy())
    expect(screen.getByText('A title')).toBeTruthy()
    const hrefs = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual([shortUrl, 'https://example.com/page'])
  })

  it.each([
    ['on its own line, empty body', (url: string) => url, {}],
    ['inside a sentence, empty body', (url: string) => `before ${url} after`, {}],
    ['on its own line, originalUrl not a string', (url: string) => url, { originalUrl: { a: 1 } }],
    ['on its own line, originalUrl not a URL', (url: string) => url, { originalUrl: 'nope' }],
  ])('keeps the post readable: %s', async (_name, makeText, body) => {
    const { container, shortUrl } = await renderPost(makeText, body)
    // The short URL itself stays as the link; no preview card, nothing thrown.
    const hrefs = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual([shortUrl])
    expect(screen.getByText(shortUrl)).toBeTruthy()
  })
})
