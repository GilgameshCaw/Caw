/**
 * translate.test.ts
 *
 * translateTextDetailed asks the node again with the text's own script as the
 * source language when the node answered but returned the text untranslated.
 * The node is replaced by a fake that behaves like MyMemory on a node with no
 * translation key: it detects the language itself, and a Chinese post with a
 * few Latin-script tokens comes back untouched, "detected" as Polish.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('~/api/client', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '~/api/client'
import { detectScript, translateTextDetailed } from './translate'

const mockedApiFetch = vi.mocked(apiFetch)

const MIXED_ZH = 'gm gm 币圈早安，今天行情不错'
const PLAIN_ZH = '今天天气很好，我们去公园散步。'

type Body = { text: string; targetLang: string; sourceLang?: string; isPrivate?: boolean }
const bodies = (): Body[] => mockedApiFetch.mock.calls.map(c => JSON.parse((c[1] as any).body))

/** A node that cannot detect the language itself: it translates only when told the source. */
function nodeThatNeedsTheSource() {
  mockedApiFetch.mockImplementation(async (_path: string, init: any) => {
    const b: Body = JSON.parse(init.body)
    // MyMemory detects nothing when it is told the source, so the node reports none.
    if (b.sourceLang) return { text: `[${b.sourceLang}->${b.targetLang}] ${b.text}`, sourceLanguage: '' } as any
    return { text: b.text, sourceLanguage: 'pl' } as any
  })
}

beforeEach(() => {
  mockedApiFetch.mockReset()
  try { localStorage.clear() } catch {}
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('detectScript', () => {
  it('keeps its default of 3 script characters', () => {
    expect(detectScript('币圈')).toBeNull()
    expect(detectScript('币圈早')).toBe('zh')
  })

  it('takes a lower minimum when asked', () => {
    expect(detectScript('币圈', 2)).toBe('zh')
    expect(detectScript('币', 2)).toBeNull()
  })

  it('ignores Latin-script tokens', () => {
    expect(detectScript(MIXED_ZH)).toBe('zh')
    expect(detectScript('gm gm $CAW #caw')).toBeNull()
    expect(detectScript('CAW 很棒 #caw $CAW', 2)).toBe('zh')
  })

  it('reads kana as Japanese even beside kanji', () => {
    expect(detectScript('今日は天気がいい')).toBe('ja')
  })
})

describe('translateTextDetailed: source hint after an untranslated answer', () => {
  it('asks again with the script language and returns that translation', async () => {
    nodeThatNeedsTheSource()
    const r = await translateTextDetailed(MIXED_ZH, 'fr')
    expect(r).toEqual({ text: `[zh->fr] ${MIXED_ZH}`, sourceLanguage: '', targetLanguage: 'fr' })
    const b = bodies()
    expect(b).toHaveLength(2)
    expect(b[0].sourceLang).toBeUndefined()
    expect(b[1]).toMatchObject({ targetLang: 'fr', sourceLang: 'zh' })
  })

  it('sends nothing extra when the first answer is a translation', async () => {
    mockedApiFetch.mockResolvedValue({ text: 'Il fait beau', sourceLanguage: 'zh' } as any)
    const r = await translateTextDetailed(PLAIN_ZH, 'fr')
    expect(r?.text).toBe('Il fait beau')
    const b = bodies()
    expect(b).toHaveLength(1)
    expect(b[0].sourceLang).toBeUndefined()
  })

  it('never names a source for a text with no non-Latin script', async () => {
    nodeThatNeedsTheSource()
    const r = await translateTextDetailed('gm gm $CAW #caw', 'fr')
    expect(r).toBeNull()
    // the detecting request, then the English fallback: neither names a source
    expect(bodies().map(b => b.sourceLang)).toEqual([undefined, undefined])
  })

  it('falls back to the plain English request, as before, if the hinted request fails too', async () => {
    // The guess may be what went wrong, so the last request does not repeat it.
    mockedApiFetch.mockImplementation(async (_path: string, init: any) => {
      const b: Body = JSON.parse(init.body)
      if (b.targetLang === 'en' && !b.sourceLang) return { text: 'good morning', sourceLanguage: 'zh' } as any
      return { text: b.text, sourceLanguage: 'pl' } as any
    })
    const r = await translateTextDetailed(MIXED_ZH, 'fr')
    expect(r).toEqual({ text: 'good morning', sourceLanguage: 'zh', targetLanguage: 'en' })
    expect(bodies().map(b => [b.targetLang, b.sourceLang])).toEqual([['fr', undefined], ['fr', 'zh'], ['en', undefined]])
  })

  it('does not ask for a translation into the language the script already is', async () => {
    nodeThatNeedsTheSource()
    // A Chinese viewer reading a Chinese post: "zh -> zh" is not asked, the English fallback is.
    const r = await translateTextDetailed(MIXED_ZH, 'zh')
    expect(r?.targetLanguage).toBe('en')
    expect(bodies().map(b => [b.targetLang, b.sourceLang])).toEqual([['zh', undefined], ['en', 'zh']])
  })

  it('does not guess when the first request failed outright', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockedApiFetch.mockRejectedValue(new Error('503'))
    const r = await translateTextDetailed(MIXED_ZH, 'fr')
    expect(r).toBeNull()
    expect(bodies().map(b => b.sourceLang)).toEqual([undefined, undefined])
  })

  it('leaves a DM on the browser route alone (Google detects it, nothing is sent to the node)', async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const q = new URL(String(url)).searchParams.get('q') || ''
      return { ok: true, json: async () => [[[q, q]], null, 'pl'] } as any
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await translateTextDetailed(MIXED_ZH, 'fr', { isPrivate: true })
    expect(r).toBeNull()
    expect(mockedApiFetch).not.toHaveBeenCalled()
    const sl = fetchMock.mock.calls.map(c => new URL(String(c[0])).searchParams.get('sl'))
    expect(sl).toEqual(['auto', 'auto'])
  })

  it('does name the source on the node route of a DM, which the user opted into', async () => {
    localStorage.setItem('caw:dmTranslateRoute', 'node')
    nodeThatNeedsTheSource()
    const r = await translateTextDetailed(MIXED_ZH, 'fr', { isPrivate: true })
    expect(r?.text).toBe(`[zh->fr] ${MIXED_ZH}`)
    expect(bodies().every(b => b.isPrivate === true)).toBe(true)
    expect(bodies()[1].sourceLang).toBe('zh')
  })
})
