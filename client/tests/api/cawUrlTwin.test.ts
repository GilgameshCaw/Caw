import { expect } from 'chai'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { slugify as apiSlugify, cawPath } from '../../src/api/util/cawUrl'
import { slugify as feSlugify, cawUrl } from '../../src/services/FrontEnd/src/utils/cawUrl'

// The API's cawUrl.ts is a copy of the FE's. The server uses it for the
// 301 on /users/:u/caw/:idSlug, the prerender canonical and the sitemap;
// the FE uses its own copy for links and the in-app URL. If the two give
// different slugs for the same post, crawlers and people get different
// canonical URLs for it.

const API_FILE = resolve(__dirname, '../../src/api/util/cawUrl.ts')
const FE_FILE = resolve(__dirname, '../../src/services/FrontEnd/src/utils/cawUrl.ts')

function stopWords(file: string): Set<string> {
  const src = readFileSync(file, 'utf8')
  const m = src.match(/const STOP_WORDS = new Set<string>\(\[([\s\S]*?)\]\)/)
  if (!m) throw new Error(`STOP_WORDS literal not found in ${file}`)
  const body = m[1].replace(/\/\/.*$/gm, '')
  return new Set([...body.matchAll(/'([^']*)'/g)].map(x => x[1]))
}

const SAMPLES: Array<string | null | undefined> = [
  null,
  undefined,
  '',
  'The cat is on the table',
  'Der Hund ist sehr müde heute',
  'El perro está en la casa',
  'Le chat est sur la table',
  'Une belle journée',
  'Eu amo um gato preto',
  'Fui em casa com uma amiga e mas sem ela',
  'Ik ben niet moe vandaag',
  'Ik zit op de bank',
  'Più bello che mai',
  'Questi sono i miei amici',
  'Il gatto è sul tavolo',
  'Check https://example.com/x and www.example.org now',
  '#caw @alice hello world',
  'the a an',
  '猫が好き',
  'one two three four five six seven eight nine ten',
  'supercalifragilisticexpialidocious antidisestablishmentarianism words',
]

describe('cawUrl twins (API vs FE)', () => {
  it('have the same stop-word list', () => {
    const api = stopWords(API_FILE)
    const fe = stopWords(FE_FILE)
    expect(fe.size).to.be.greaterThan(200)
    const feOnly = [...fe].filter(w => !api.has(w))
    const apiOnly = [...api].filter(w => !fe.has(w))
    expect({ feOnly, apiOnly }).to.deep.equal({ feOnly: [], apiOnly: [] })
  })

  it('give the same slug', () => {
    for (const text of SAMPLES) {
      expect(apiSlugify(text), JSON.stringify(text)).to.equal(feSlugify(text))
    }
  })

  it('give the same path', () => {
    for (const [i, content] of SAMPLES.entries()) {
      const id = 1000 + i
      const api = cawPath({ id, username: 'alice', content })
      const fe = cawUrl({ id, user: { username: 'alice' }, content })
      expect(api, JSON.stringify(content)).to.equal(fe)
    }
  })

  it('drop Portuguese, Dutch and Italian stop words on the server', () => {
    expect(apiSlugify('Eu amo um gato preto')).to.equal('eu-amo-gato-preto')
    expect(apiSlugify('Ik ben niet moe vandaag')).to.equal('moe-vandaag')
    expect(apiSlugify('Più bello che mai')).to.equal('piu-bello-mai')
    expect(cawPath({ id: 7, username: 'alice', content: 'Eu amo um gato preto' }))
      .to.equal('/users/alice/caw/7-eu-amo-gato-preto')
  })
})
