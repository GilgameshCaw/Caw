import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import LinkPreview from './LinkPreview'

const api = vi.hoisted(() => ({ body: null as unknown }))

vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/api/client', () => ({ apiFetch: vi.fn(async () => api.body) }))

// The app has only a root error boundary, so a throw during render takes down
// the whole page. This one turns that into something a test can see.
class Boundary extends React.Component<{ children: React.ReactNode }, { thrown: string | null }> {
  state = { thrown: null as string | null }
  static getDerivedStateFromError(err: unknown) {
    return { thrown: String(err) }
  }
  render() {
    return this.state.thrown ? <div data-testid="thrown">{this.state.thrown}</div> : this.props.children
  }
}

// LinkPreview caches per code at module level, so every render gets its own.
let codeCounter = 0

async function renderPreview(body: unknown, opts: { originHost?: string; ok?: boolean } = {}) {
  api.body = body
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: opts.ok ?? true,
    status: opts.ok === false ? 404 : 200,
    json: async () => body,
  })))
  const { container } = render(
    <Boundary>
      <LinkPreview code={`code${++codeCounter}`} originHost={opts.originHost} />
    </Boundary>,
  )
  await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeNull())
  expect(screen.queryByTestId('thrown')).toBeNull()
  return container
}

const OTHER_NODE = 'https://other-node.example'

describe('LinkPreview', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows a card for a well-formed response from another node', async () => {
    const container = await renderPreview(
      { code: 'x', originalUrl: 'https://www.example.com/a', title: 'A title', clickCount: 0 },
      { originHost: OTHER_NODE },
    )
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://www.example.com/a')
    expect(screen.getByText('example.com')).toBeTruthy()
    expect(screen.getByText('A title')).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`${OTHER_NODE}/api/shorturl/`))
  })

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a URL that does not parse', { originalUrl: 'not a url' }],
    ['a number', { originalUrl: 42 }],
    ['an object', { originalUrl: { href: 'https://example.com' } }],
    ['a data: URL', { originalUrl: 'data:text/plain,x', siteName: 'site' }],
    ['a javascript: URL', { originalUrl: 'javascript:void(0)', siteName: 'site' }],
  ])('renders nothing when originalUrl is %s', async (_name, body) => {
    const container = await renderPreview(body, { originHost: OTHER_NODE })
    expect(container.querySelector('a')).toBeNull()
  })

  it('drops optional fields that are not strings', async () => {
    const container = await renderPreview(
      { originalUrl: 'https://example.com/a', title: { a: 1 }, description: 5, siteName: ['x'], imageUrl: {} },
      { originHost: OTHER_NODE },
    )
    expect(screen.getByText('example.com')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('h4')).toBeNull()
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders nothing when the other node answers with an error', async () => {
    const container = await renderPreview({ originalUrl: 'https://example.com/a' }, { originHost: OTHER_NODE, ok: false })
    expect(container.querySelector('a')).toBeNull()
  })

  it('leaves a numeric reference above U+10FFFF as written, for this node too', async () => {
    await renderPreview({
      originalUrl: 'https://example.com/a',
      siteName: 'site',
      title: 'a &#9999999; b',
      description: 'c &#x110000; d',
    })
    expect(screen.getByText('a &#9999999; b')).toBeTruthy()
    expect(screen.getByText('c &#x110000; d')).toBeTruthy()
  })

  it('still decodes valid references', async () => {
    await renderPreview({
      originalUrl: 'https://example.com/a',
      siteName: 'site',
      title: 'a &amp; b &#39;c&#39; &#x41; &#x10FFFF;',
    })
    expect(screen.getByText(`a & b 'c' A ${String.fromCodePoint(0x10ffff)}`)).toBeTruthy()
  })
})
