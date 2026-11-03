// The server-side hashtag extraction (post indexing, the search index) has to
// agree with what the composer highlighter and the feed renderer show: they
// take a URL as one piece before looking for tags, so the `#fragment` of a
// link is not a hashtag on screen. Pure functions; no database.

import { expect } from 'chai'
import { extractHashtagBodies, extractHashtagBodiesWithDisplay } from '../../src/tools/hashtagRegex'

describe('extractHashtagBodies', () => {
  it('finds hashtags and cashtags, in Japanese and with the fullwidth sigil too', () => {
    expect(extractHashtagBodies('hello #caw and $ETH')).to.deep.equal(['caw', 'eth'])
    expect(extractHashtagBodies('#日本語 ＃ハッシュ')).to.deep.equal(['日本語', 'ハッシュ'])
  })

  it('lowercases, dedupes, and skips pure numbers', () => {
    expect(extractHashtagBodies('#Caw #caw #CAW #5 $100')).to.deep.equal(['caw'])
  })

  it('does not read the fragment of a URL as a hashtag', () => {
    expect(extractHashtagBodies('see https://example.com/docs#install for details')).to.deep.equal([])
    expect(extractHashtagBodies('https://github.com/GilgameshCaw/Caw/pull/12#issuecomment-345')).to.deep.equal([])
    expect(extractHashtagBodies('https://caw.social/users/maria#top and https://x.com/a?b=1#frag')).to.deep.equal([])
    expect(extractHashtagBodies('http://example.com/#anchor')).to.deep.equal([])
  })

  it('still finds a real hashtag next to a link', () => {
    expect(extractHashtagBodies('real tag #caw next to a link https://example.com/#anchor')).to.deep.equal(['caw'])
    expect(extractHashtagBodies('https://example.com/a#frag #caw')).to.deep.equal(['caw'])
    expect(extractHashtagBodies('#first https://example.com/a#frag #second')).to.deep.equal(['first', 'second'])
  })

  it('reads a URL the way the renderer does: it ends before trailing sentence punctuation', () => {
    expect(extractHashtagBodies('look (https://example.com/a#frag), #caw.')).to.deep.equal(['caw'])
    expect(extractHashtagBodies('see https://example.com/a#frag. Then #caw')).to.deep.equal(['caw'])
    // no space after the dot: the renderer takes `.#caw` as part of the URL, so it is no tag
    expect(extractHashtagBodies('https://example.com/a#frag.#caw')).to.deep.equal([])
  })

  it('reads a tag from where it starts, also when a link follows it directly', () => {
    expect(extractHashtagBodies('#foo https://example.com/x bar')).to.deep.equal(['foo'])
    expect(extractHashtagBodies('#foohttps://example.com/x')).to.deep.equal(['foohttps'])
  })

  it('takes a mention first, as the renderer does: @https://x.com/a#b is the mention @https, then plain text', () => {
    expect(extractHashtagBodies('@https://x.com/a#b.')).to.deep.equal(['b'])
    expect(extractHashtagBodies('hi @maria #caw')).to.deep.equal(['caw'])
  })

  it('honours maxLen', () => {
    expect(extractHashtagBodies(`#${'a'.repeat(101)} #ok`)).to.deep.equal(['ok'])
  })
})

describe('extractHashtagBodiesWithDisplay', () => {
  it('keeps the first casing typed, and ignores a URL fragment', () => {
    expect(extractHashtagBodiesWithDisplay('#Caw https://example.com/a#Frag #CAW')).to.deep.equal([
      { name: 'caw', displayName: 'Caw' },
    ])
  })
})
