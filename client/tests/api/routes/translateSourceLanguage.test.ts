/**
 * POST /api/translate: how the source language is sent to the provider and
 * what is reported back.
 *
 * No database, no network, no HTTP server: the route's own handler is taken out
 * of the router and called with a minimal req/res, and `fetch` is replaced so
 * that MyMemory (the keyless provider every node has) answers from a table.
 * Any other provider URL gets a 500, so the chain falls through to MyMemory
 * even if a translation key is set in the environment of the test run.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'

describe('POST /api/translate: source language', function () {
  this.timeout(30000)

  let handler: (req: any, res: any) => Promise<unknown>
  let normalize: (raw: unknown) => string
  const realFetch = globalThis.fetch
  let urls: string[]
  // What MyMemory answers for the request it was just sent.
  let answer: (langpair: string) => { translatedText: string; detectedLanguage?: string }

  before(async () => {
    const mod = await import('../../../src/api/routes/translate')
    normalize = mod.normalizeDetectedLanguage
    const router: any = mod.default
    const layer = router.stack.find((l: any) => l.route && l.route.path === '/' && l.route.methods.post)
    expect(layer, 'POST / is registered').to.not.equal(undefined)
    const stack = layer.route.stack.map((s: any) => s.handle)
    // [rate limiter, the handler]
    handler = stack[stack.length - 1]

    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      urls.push(url)
      if (!url.includes('api.mymemory.translated.net')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as any
      }
      const langpair = decodeURIComponent(new URL(url).searchParams.get('langpair') || '')
      const a = answer(langpair)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          responseStatus: 200,
          responseData: { translatedText: a.translatedText, detectedLanguage: a.detectedLanguage },
        }),
        text: async () => '',
      } as any
    }) as any
  })

  after(() => { globalThis.fetch = realFetch })

  beforeEach(() => { urls = [] })

  async function post(body: any) {
    const res: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) { this.statusCode = code; return this },
      json(b: any) { this.body = b; return this },
    }
    await handler({ body }, res)
    return { status: res.statusCode, json: res.body }
  }

  const myMemoryCalls = () => urls.filter(u => u.includes('api.mymemory.translated.net'))
  const langpairOf = (url: string) => decodeURIComponent(new URL(url).searchParams.get('langpair') || '')

  it('reports a region-tagged detection ("zh-CN") as its primary subtag', async () => {
    answer = () => ({ translatedText: 'Bonjour', detectedLanguage: 'zh-CN' })
    const r = await post({ text: '早上好 (region tag)', targetLang: 'fr' })
    expect(r.status).to.equal(200)
    expect(r.json.sourceLanguage).to.equal('zh')
  })

  it('reports an unknown detection as empty, not as a placeholder', async () => {
    answer = () => ({ translatedText: 'Hello', detectedLanguage: 'und' })
    const r = await post({ text: 'placeholder detection', targetLang: 'fr' })
    expect(r.status).to.equal(200)
    expect(r.json.sourceLanguage).to.equal('')
  })

  it('without a source language, MyMemory is asked to detect it', async () => {
    answer = () => ({ translatedText: 'Bonjour', detectedLanguage: 'zh-CN' })
    await post({ text: '早上好 (autodetect)', targetLang: 'fr' })
    expect(myMemoryCalls().map(langpairOf)).to.deep.equal(['autodetect|fr'])
  })

  it('with a source language, it is the source of the pair, and a detection nobody made is not reported', async () => {
    // MyMemory returns no detectedLanguage when it is told the source.
    answer = () => ({ translatedText: 'Bonjour à tous' })
    const r = await post({ text: 'gm gm 币圈早安 (given source)', targetLang: 'fr', sourceLang: 'zh' })
    expect(r.status).to.equal(200)
    expect(myMemoryCalls().map(langpairOf)).to.deep.equal(['zh|fr'])
    expect(r.json.text).to.equal('Bonjour à tous')
    expect(r.json.sourceLanguage).to.equal('')
  })

  it('an untranslated answer to the detecting request does not stand in for the one with a source', async () => {
    // The failure this guards: detection takes "gm gm 币圈早安…" for Polish and
    // MyMemory hands the text back; the same text asked again with the source
    // given must reach the provider again, not be answered from the cache.
    const text = 'gm gm 币圈早安，今天行情不错 (cache)'
    answer = (langpair) => langpair.startsWith('autodetect')
      ? { translatedText: text, detectedLanguage: 'pl' }
      : { translatedText: 'gm gm Bonjour à tous les passionnés de cryptomonnaies.' }
    const first = await post({ text, targetLang: 'fr' })
    expect(first.json.text).to.equal(text)
    const second = await post({ text, targetLang: 'fr', sourceLang: 'zh' })
    expect(second.json.text).to.not.equal(text)
    expect(myMemoryCalls().map(langpairOf)).to.deep.equal(['autodetect|fr', 'zh|fr'])
  })

  it('a source language that is not a language code is still refused', async () => {
    answer = () => ({ translatedText: 'x' })
    const r = await post({ text: 'bad source', targetLang: 'fr', sourceLang: 'zh&x=1' })
    expect(r.status).to.equal(400)
    expect(urls).to.deep.equal([])
  })

  describe('normalizeDetectedLanguage', () => {
    const cases: Array<[unknown, string]> = [
      ['zh-CN', 'zh'], ['zh-TW', 'zh'], ['ZH', 'zh'], ['pt_BR', 'pt'], ['ja', 'ja'], ['fil', 'fil'],
      ['', ''], ['auto', ''], ['und', ''], ['x', ''], ['zh&x', ''], [undefined, ''], [null, ''], [42, ''], [['zh'], ''],
    ]
    for (const [raw, want] of cases) {
      it(`${JSON.stringify(raw)} -> ${JSON.stringify(want)}`, () => {
        expect(normalize(raw)).to.equal(want)
      })
    }
  })
})
