import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readMetaTags, readTitle } from '../../../src/api/util/htmlMeta'

describe('readMetaTags', () => {
  it('reads either attribute order and either quote style', () => {
    const a = readMetaTags(`<meta property="og:image" content="https://x/a.png">`)
    const b = readMetaTags(`<meta content='https://x/b.png' property='og:image'/>`)
    expect(a.property('og:image')).to.equal('https://x/a.png')
    expect(b.property('og:image')).to.equal('https://x/b.png')
  })

  it('ignores case in the tag, attribute names and keys, and keeps the case of the value', () => {
    const m = readMetaTags(`<META\n  PROPERTY="OG:Title"\n  Content="Hello World">`)
    expect(m.property('og:title')).to.equal('Hello World')
  })

  it('keeps property and name apart', () => {
    const m = readMetaTags(`<meta name="twitter:image" content="n"><meta property="og:title" content="p">`)
    expect(m.name('twitter:image')).to.equal('n')
    expect(m.property('twitter:image')).to.equal(undefined)
    expect(m.name('og:title')).to.equal(undefined)
  })

  it('does not end a tag at a ">" inside a quoted value', () => {
    const m = readMetaTags(`<meta property="og:title" content="A > B"><meta content="C > D" name="description">`)
    expect(m.property('og:title')).to.equal('A > B')
    expect(m.name('description')).to.equal('C > D')
  })

  it('keeps the other quote inside a value', () => {
    const m = readMetaTags(`<meta property="og:title" content="it's here">`)
    expect(m.property('og:title')).to.equal(`it's here`)
  })

  it('takes the first non-empty value', () => {
    const m = readMetaTags(`<meta property="og:title" content=""><meta property="og:title" content="one"><meta property="og:title" content="two">`)
    expect(m.property('og:title')).to.equal('one')
  })

  it('does not read a longer attribute name as content', () => {
    const m = readMetaTags(`<meta property="og:image" data-content="wrong" content="right">`)
    expect(m.property('og:image')).to.equal('right')
  })

  it('ignores other tags that start the same way', () => {
    const m = readMetaTags(`<metadata property="og:title" content="no"><meta property="og:title" content="yes">`)
    expect(m.property('og:title')).to.equal('yes')
  })

  it('finds a good tag after a tag that never closes its window', () => {
    const m = readMetaTags(`<meta a="${'x'.repeat(10000)}"><meta property="og:title" content="after">`)
    expect(m.property('og:title')).to.equal('after')
  })

  for (const [label, html] of [
    ['unclosed tags', '<meta '.repeat(170_000)],
    ['unclosed tags with one ">" at the end', '<meta '.repeat(170_000) + '>'],
    ['unclosed quotes', '<meta a="'.repeat(110_000)],
    ['alternating quotes', `<meta a="'`.repeat(100_000)],
    ['attribute names and no values', '<meta ' + 'a '.repeat(500_000)],
    ['equals signs', '<meta ' + '='.repeat(1_000_000)],
    ['a matching prefix over and over', '<meta property="og:image" '.repeat(40_000)],
  ] as const) {
    it(`stays fast on 1 MB of ${label}`, () => {
      const t0 = Date.now()
      readMetaTags(html)
      expect(Date.now() - t0).to.be.lessThan(200)
    })
  }
})

describe('readTitle', () => {
  it('reads a plain title, with attributes and any case', () => {
    expect(readTitle('<head><title>Hi</title></head>')).to.equal('Hi')
    expect(readTitle('<TITLE lang="en">Hi</TITLE>')).to.equal('Hi')
  })

  it('skips an empty title and one holding a tag, as the regex did', () => {
    expect(readTitle('<title></title><title>Next</title>')).to.equal('Next')
    expect(readTitle('<title><b>x</b></title>')).to.equal(undefined)
  })

  it('returns undefined when there is none', () => {
    expect(readTitle('<p>no title</p>')).to.equal(undefined)
    expect(readTitle('<title>never closed')).to.equal(undefined)
    expect(readTitle('<titlebar>x</titlebar>')).to.equal(undefined)
  })

  for (const [label, html] of [
    ['unclosed tags', '<title '.repeat(150_000)],
    ['unclosed tags with one ">" at the end', '<title '.repeat(150_000) + '>'],
    ['open tags with no text', '<title>'.repeat(150_000)],
    ['open tags with text', '<title>a'.repeat(125_000)],
  ] as const) {
    it(`stays fast on 1 MB of ${label}`, () => {
      const t0 = Date.now()
      readTitle(html)
      expect(Date.now() - t0).to.be.lessThan(200)
    })
  }
})
