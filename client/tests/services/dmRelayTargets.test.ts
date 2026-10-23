import { expect } from 'chai'
import { relayTargets } from '../../src/services/DmRelayService/peerTargets'
import type { PeerInstance } from '../../src/services/InstanceRegistryService'

// Peer-cache entries as getPeers returns them (sorted by instanceId).
function peer(instanceId: number, apiUrl: string, active = true): PeerInstance {
  return {
    instanceId,
    networkId: 1,
    owner: '0x0000000000000000000000000000000000000001',
    apiUrl,
    validatorAddress: '0x0000000000000000000000000000000000000001',
    active,
  }
}

const PATH = '/api/dm/relay'

describe('relayTargets — one relay POST per peer URL', () => {
  let warn: typeof console.warn
  let warnings: string[]
  beforeEach(() => {
    warn = console.warn
    warnings = []
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')) }
  })
  afterEach(() => { console.warn = warn })

  it('sends once to instances that share a URL, keeping the lowest instanceId', () => {
    const peers = [
      peer(1, 'https://self.example'),
      peer(2, 'https://a.example'),
      peer(3, 'https://a.example/'),
      peer(4, 'https://a.example:443'),
      peer(5, 'https://A.EXAMPLE'),
      peer(6, 'https://a.example/some/path'),
    ]
    const targets = relayTargets(peers, 1, PATH)
    expect(targets).to.deep.equal([
      { instanceId: 2, apiUrl: 'https://a.example', url: 'https://a.example/api/dm/relay' },
    ])
  })

  it('treats a trailing dot on the hostname as the same URL, fetching the first spelling', () => {
    const peers = [
      peer(1, 'https://self.example'),
      peer(2, 'https://a.example.'),
      peer(3, 'https://a.example'),
      peer(4, 'https://A.EXAMPLE..'),
      peer(5, 'https://a.example.:443'),
      peer(6, 'https://a.example.:8443'),
    ]
    expect(relayTargets(peers, 1, PATH)).to.deep.equal([
      { instanceId: 2, apiUrl: 'https://a.example.', url: 'https://a.example./api/dm/relay' },
      { instanceId: 6, apiUrl: 'https://a.example.:8443', url: 'https://a.example.:8443/api/dm/relay' },
    ])
  })

  it('skips entries on our own URL written with a trailing dot', () => {
    const peers = [
      peer(1, 'https://self.example'),
      peer(2, 'https://self.example.'),
      peer(3, 'https://b.example'),
    ]
    expect(relayTargets(peers, 1, PATH).map(t => t.instanceId)).to.deep.equal([3])
  })

  it('skips other instances registered on our own URL', () => {
    const peers = [
      peer(1, 'https://self.example'),
      peer(2, 'https://self.example/'),
      peer(3, 'https://self.example'),
      peer(4, 'https://b.example'),
    ]
    expect(relayTargets(peers, 3, PATH).map(t => t.instanceId)).to.deep.equal([4])
  })

  it('still dedupes when our own entry is not in the cache', () => {
    const peers = [
      peer(1, 'https://a.example'),
      peer(2, 'https://a.example'),
      peer(3, 'https://b.example'),
    ]
    expect(relayTargets(peers, 99, PATH).map(t => t.instanceId)).to.deep.equal([1, 3])
  })

  it('keeps different scheme or host as separate targets', () => {
    const peers = [
      peer(1, 'https://self.example'),
      peer(2, 'https://a.example'),
      peer(3, 'http://a.example'),
      peer(4, 'https://www.a.example'),
    ]
    expect(relayTargets(peers, 1, PATH).map(t => t.url)).to.deep.equal([
      'https://a.example/api/dm/relay',
      'http://a.example/api/dm/relay',
      'https://www.a.example/api/dm/relay',
    ])
  })

  it('drops inactive peers and malformed apiUrls as before', () => {
    const peers = [
      peer(1, 'https://self.example'),
      peer(2, 'https://a.example', false),
      peer(3, 'https://b.example?x='),
      peer(4, 'not a url'),
      peer(5, 'https://a.example'),
    ]
    expect(relayTargets(peers, 1, PATH).map(t => t.instanceId)).to.deep.equal([5])
    expect(warnings).to.have.length(2)
    expect(warnings[0]).to.include('Skipping peer 3')
    expect(warnings[1]).to.include('Skipping peer 4')
  })

  it('uses the given path for the identity relay', () => {
    const targets = relayTargets([peer(1, 'https://self.example'), peer(2, 'https://a.example/x')], 1, '/api/dm/identity/relay')
    expect(targets.map(t => t.url)).to.deep.equal(['https://a.example/api/dm/identity/relay'])
  })

  it('reduces a registry of 80 active entries on 9 URLs to 8 POSTs', () => {
    // Group sizes from one testnet node's /api/instances (2026-10-22);
    // our own URL has 1 entry.
    const sizes = [1, 2, 1, 17, 55, 1, 1, 1, 1]
    const peers: PeerInstance[] = []
    let id = 1
    sizes.forEach((n, host) => {
      for (let i = 0; i < n; i++) peers.push(peer(id++, `https://node${host}.example`))
    })
    expect(peers).to.have.length(80)
    const targets = relayTargets(peers, 1, PATH)
    expect(targets).to.have.length(8)
    expect(new Set(targets.map(t => t.url)).size).to.equal(8)
  })
})
