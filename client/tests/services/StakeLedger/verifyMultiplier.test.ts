// Tests for StakeLedger.verifyMultiplier() — the at-block multiplier check.
//
// Must set CLIENT_ID before importing the module (the IIFE runs at import
// time and throws if the env var is absent).

import { expect } from 'chai'

// Set CLIENT_ID env var before the module loads.
process.env.CLIENT_ID = '1'

import {
  verifyMultiplier,
  _peekState,
  _resetForTests,
  _setContractForTests,
  _injectStateForTests,
  _nonArchiveWarnWasEmitted,
  type RuntimeState,
} from '../../../src/services/StakeLedger/index'
import { PRECISION } from '../../../src/services/StakeLedger/contractMath'

// Helper: build a minimal RuntimeState with sensible defaults.
function makeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    multiplier: PRECISION,
    totalCaw: 0n,
    ownership: new Map(),
    lastBlock: 100n,
    lastLogIndex: 0,
    halted: false,
    ...overrides,
  }
}

// Helper: build a mock contract whose rewardMultiplier() resolves to a fixed
// value, optionally keyed by whether a blockTag was supplied.
function mockContract(opts: {
  headValue?: bigint
  blockTagValue?: bigint
  blockTagError?: Error
}): { rewardMultiplier: (...args: any[]) => Promise<bigint> } {
  return {
    rewardMultiplier: async (...args: any[]) => {
      const hasBlockTag = args.length > 0 && args[0] != null && typeof args[0] === 'object' && 'blockTag' in args[0]
      if (hasBlockTag) {
        if (opts.blockTagError) throw opts.blockTagError
        if (opts.blockTagValue !== undefined) return opts.blockTagValue
      }
      if (opts.headValue !== undefined) return opts.headValue
      throw new Error('mock: no value configured')
    },
  }
}

describe('StakeLedger / verifyMultiplier', () => {
  beforeEach(() => {
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
  })

  // -----------------------------------------------------------------------
  // Happy path: state-at-lastBlock matches ledger → no halt
  // -----------------------------------------------------------------------
  describe('happy path — multiplier matches at lastBlock', () => {
    it('does not halt when chain value equals ledger value', async () => {
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 42n }))
      _setContractForTests(mockContract({ blockTagValue: PRECISION }))

      await verifyMultiplier()

      const s = _peekState()!
      expect(s.halted).to.equal(false)
    })

    it('passes the correct blockTag to the contract call', async () => {
      let capturedBlockTag: number | undefined
      const contract = {
        rewardMultiplier: async (...args: any[]) => {
          capturedBlockTag = args[0]?.blockTag
          return PRECISION
        },
      }
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 77n }))
      _setContractForTests(contract)

      await verifyMultiplier()

      expect(capturedBlockTag).to.equal(77)
    })
  })

  // -----------------------------------------------------------------------
  // Divergence path: chain value differs → halt + error log
  // -----------------------------------------------------------------------
  describe('divergence path — multiplier mismatch', () => {
    it('halts the ledger when chain value differs from ledger value', async () => {
      const wrongMultiplier = PRECISION * 2n
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 10n }))
      _setContractForTests(mockContract({ blockTagValue: wrongMultiplier }))

      const logs: string[] = []
      const origError = console.error
      console.error = (...args: any[]) => { logs.push(args.join(' ')) }
      try {
        await verifyMultiplier()
      } finally {
        console.error = origError
      }

      const s = _peekState()!
      expect(s.halted).to.equal(true)
      expect(logs.some(l => l.includes('DIVERGENCE'))).to.equal(true)
      expect(logs.some(l => l.includes('block 10'))).to.equal(true)
    })

    it('includes both chain and ledger values in the error message', async () => {
      const chainValue = PRECISION * 3n
      const ledgerValue = PRECISION * 5n
      _injectStateForTests(makeState({ multiplier: ledgerValue, lastBlock: 5n }))
      _setContractForTests(mockContract({ blockTagValue: chainValue }))

      const logs: string[] = []
      const origError = console.error
      console.error = (...args: any[]) => { logs.push(args.join(' ')) }
      try {
        await verifyMultiplier()
      } finally {
        console.error = origError
      }

      expect(logs.some(l => l.includes(chainValue.toString()) && l.includes(ledgerValue.toString()))).to.equal(true)
    })

    it('does not call the contract again after halt', async () => {
      let callCount = 0
      const contract = {
        rewardMultiplier: async (..._args: any[]) => {
          callCount++
          return PRECISION * 2n
        },
      }
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 1n }))
      _setContractForTests(contract)

      const origError = console.error
      console.error = () => {}
      try {
        await verifyMultiplier() // triggers halt
        await verifyMultiplier() // should early-return on halted
      } finally {
        console.error = origError
      }

      expect(callCount).to.equal(1)
    })
  })

  // -----------------------------------------------------------------------
  // lastBlock = 0n path: skip without RPC call
  // -----------------------------------------------------------------------
  describe('lastBlock=0 — fresh boot, no actions processed', () => {
    it('returns without calling the contract', async () => {
      let called = false
      _setContractForTests({
        rewardMultiplier: async () => { called = true; return PRECISION },
      })
      _injectStateForTests(makeState({ lastBlock: 0n }))

      await verifyMultiplier()

      expect(called).to.equal(false)
    })

    it('does not halt', async () => {
      _setContractForTests({
        rewardMultiplier: async () => { return PRECISION * 999n },
      })
      _injectStateForTests(makeState({ lastBlock: 0n }))

      await verifyMultiplier()

      expect(_peekState()!.halted).to.equal(false)
    })
  })

  // -----------------------------------------------------------------------
  // Archive RPC failure path: "missing trie node" → fall back to HEAD,
  // emit one-time warn, do NOT halt
  // -----------------------------------------------------------------------
  describe('archive-RPC-failure — falls back to HEAD comparison', () => {
    it('does not halt when HEAD value matches and block read throws "missing trie node"', async () => {
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 500n }))
      _setContractForTests(mockContract({
        blockTagError: new Error('missing trie node'),
        headValue: PRECISION,
      }))

      const warns: string[] = []
      const origWarn = console.warn
      console.warn = (...args: any[]) => { warns.push(args.join(' ')) }
      try {
        await verifyMultiplier()
      } finally {
        console.warn = origWarn
      }

      expect(_peekState()!.halted).to.equal(false)
      expect(warns.some(w => w.includes('historical state read failed'))).to.equal(true)
      expect(warns.some(w => w.includes('archive RPC'))).to.equal(true)
    })

    it('does not halt on "header not found" error', async () => {
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 200n }))
      _setContractForTests(mockContract({
        blockTagError: new Error('header not found'),
        headValue: PRECISION,
      }))

      const origWarn = console.warn
      console.warn = () => {}
      try {
        await verifyMultiplier()
      } finally {
        console.warn = origWarn
      }

      expect(_peekState()!.halted).to.equal(false)
    })

    it('does not halt on "state not available" error', async () => {
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 300n }))
      _setContractForTests(mockContract({
        blockTagError: new Error('state not available'),
        headValue: PRECISION,
      }))

      const origWarn = console.warn
      console.warn = () => {}
      try {
        await verifyMultiplier()
      } finally {
        console.warn = origWarn
      }

      expect(_peekState()!.halted).to.equal(false)
    })

    it('emits non-archive warn only once across multiple calls', async () => {
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 100n }))
      _setContractForTests(mockContract({
        blockTagError: new Error('missing trie node'),
        headValue: PRECISION,
      }))

      const warns: string[] = []
      const origWarn = console.warn
      console.warn = (...args: any[]) => { warns.push(args.join(' ')) }
      try {
        await verifyMultiplier()
        await verifyMultiplier()
        await verifyMultiplier()
      } finally {
        console.warn = origWarn
      }

      const archiveWarns = warns.filter(w => w.includes('historical state read failed'))
      expect(archiveWarns.length).to.equal(1)
    })

    it('sets _nonArchiveWarnWasEmitted flag after first failure', async () => {
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 100n }))
      _setContractForTests(mockContract({
        blockTagError: new Error('missing trie node'),
        headValue: PRECISION,
      }))

      expect(_nonArchiveWarnWasEmitted()).to.equal(false)

      const origWarn = console.warn
      console.warn = () => {}
      try {
        await verifyMultiplier()
      } finally {
        console.warn = origWarn
      }

      expect(_nonArchiveWarnWasEmitted()).to.equal(true)
    })

    it('halts when HEAD value also differs (divergence still detectable via HEAD)', async () => {
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 100n }))
      _setContractForTests(mockContract({
        blockTagError: new Error('missing trie node'),
        headValue: PRECISION * 2n,
      }))

      const origWarn = console.warn
      const origError = console.error
      console.warn = () => {}
      console.error = () => {}
      try {
        await verifyMultiplier()
      } finally {
        console.warn = origWarn
        console.error = origError
      }

      // HEAD differs from ledger → divergence still caught even without archive
      expect(_peekState()!.halted).to.equal(true)
    })

    it('skips check (warn + return) on transient non-archive RPC error', async () => {
      _injectStateForTests(makeState({ multiplier: PRECISION, lastBlock: 50n }))
      _setContractForTests({
        rewardMultiplier: async (...args: any[]) => {
          // Any error that is NOT in the archive pattern list
          throw new Error('network timeout')
        },
      })

      const warns: string[] = []
      const origWarn = console.warn
      console.warn = (...args: any[]) => { warns.push(args.join(' ')) }
      try {
        await verifyMultiplier()
      } finally {
        console.warn = origWarn
      }

      expect(_peekState()!.halted).to.equal(false)
      expect(warns.some(w => w.includes('RPC read failed') && w.includes('skipping check'))).to.equal(true)
    })
  })
})
