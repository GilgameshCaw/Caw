import { expect } from 'chai'
import { buildPollMarker, parsePoll, stripPollMarker } from '../../src/tools/pollMarker'

// An option without an image used to contribute an empty slot to the ::pi:
// sidecar, which put "::" inside it. parsePoll ends the sidecar at the first
// "::", so every later hash, the ::pd:: duration and the ::pm:: flag were
// dropped, and what was left of the marker showed up in the post body.

const H1 = 'aaaaaaaa'
const H2 = 'bbbbbbbb'
const H3 = 'cccccccc'
const meta = { host: 'x.example.com' }
const OPTS = ['Yes', 'No', 'Maybe']

describe('buildPollMarker / parsePoll round trip', () => {
  it('leaves text-only and every-option-has-an-image markers byte for byte as before', () => {
    expect(buildPollMarker(OPTS, undefined, undefined, '1d', false))
      .to.equal('::poll:Yes:No:Maybe::::pd:1d::')
    expect(buildPollMarker(OPTS, [H1, H2, H3], meta, '7d', true))
      .to.equal('::poll:Yes:No:Maybe::::pi:x.example.com:aaaaaaaa:bbbbbbbb:cccccccc::::pd:7d::::pm::')
  })

  const partial: Array<[string, string[]]> = [
    ['the first option has no image', ['', H2, H3]],
    ['the middle option has no image', [H1, '', H3]],
    ['the last option has no image', [H1, H2, '']],
    ['only the middle option has an image', ['', H2, '']],
    ['only the first option has an image', [H1, '', '']],
  ]

  for (const [name, hashes] of partial) {
    it(`keeps hashes, duration and multi-select when ${name}`, () => {
      const marker = buildPollMarker(OPTS, hashes, meta, '1d', true)!
      const text = `Vote now ${marker}`
      const parsed = parsePoll(text)!
      expect(parsed.options).to.deep.equal(OPTS)
      expect(parsed.imageHashes).to.deep.equal(hashes)
      expect(parsed.imageHost).to.equal('x.example.com')
      expect(parsed.durationSeconds).to.equal(86400)
      expect(parsed.durationValue).to.equal('1d')
      expect(parsed.multiSelect).to.equal(true)
      // The whole marker is consumed, so nothing of it is left in the body.
      expect(parsed.marker).to.equal(marker)
      expect(stripPollMarker(text)).to.equal('Vote now')
    })
  }

  it('never emits "::" inside the image sidecar', () => {
    const marker = buildPollMarker(OPTS, [H1, '', H3], meta, '1d', true)!
    const sidecar = marker.slice(marker.indexOf('::pi:'), marker.indexOf('::pd:'))
    expect(sidecar.slice('::pi:'.length, -2)).to.not.include('::')
  })

  it('handles a non-default port and http scheme with a gap', () => {
    const marker = buildPollMarker(['a', 'b'], [H1, ''], { host: 'localhost', port: 5274, scheme: 'http' }, '6h', true)!
    const parsed = parsePoll(marker)!
    expect(parsed.imageHashes).to.deep.equal([H1, ''])
    expect(parsed.imagePort).to.equal(5274)
    expect(parsed.imageScheme).to.equal('http')
    expect(parsed.durationSeconds).to.equal(21600)
    expect(parsed.multiSelect).to.equal(true)
    expect(parsed.end).to.equal(marker.length)
  })

  it('does not treat the placeholder as an image hash', () => {
    const parsed = parsePoll(buildPollMarker(OPTS, [H1, '', ''], meta)!)!
    expect(parsed.imageHashes).to.deep.equal([H1, '', ''])
  })

  it('omits the image sidecar when no option has an image', () => {
    expect(buildPollMarker(OPTS, ['', '', ''], meta, '1d')).to.equal('::poll:Yes:No:Maybe::::pd:1d::')
  })
})
