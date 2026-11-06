import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { parseTipSetting } from '../../../src/utils/tipSetting'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module')

const rows = new Map<string, string>()
const prisma = {
  validatorSetting: {
    findMany: async () => [...rows].map(([key, value]) => ({ key, value })),
    findUnique: async ({ where }: any) => (rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null),
    upsert: async ({ where, update }: any) => {
      rows.set(where.key, update.value)
      return {}
    },
  },
}

describe('parseTipSetting', () => {
  it('reads whole numbers, including 0', () => {
    expect(parseTipSetting('0')).to.equal(0n)
    expect(parseTipSetting('1000')).to.equal(1000n)
    expect(parseTipSetting('450000000000000000000')).to.equal(450000000000000000000n)
  })

  for (const bad of ['', ' ', '1.5', '-1', '1e3', '0x10', 'abc', ' 5']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseTipSetting(bad)).to.equal(null)
    })
  }
})

describe('PATCH /api/validator-analytics/settings', () => {
  let server: Server
  let url: string
  const originalLoad = Module._load

  before(async () => {
    Module._load = function (request: string, ...rest: unknown[]) {
      if (/prismaClient$/.test(request)) return { prisma }
      if (/middleware\/auth$/.test(request)) return { requireAdmin: (_q: unknown, _s: unknown, next: () => void) => next() }
      return originalLoad.call(this, request, ...rest)
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../../../src/api/routes/validator-analytics').default
    const app = express()
    app.use(express.json())
    app.use(router)
    server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings`
  })

  after(() => {
    Module._load = originalLoad
    server.close()
  })

  beforeEach(() => rows.clear())

  const patch = async (key: string, value: unknown) => {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  for (const key of ['validatorBaseTip', 'priorityTip', 'minTipPerActionWei']) {
    for (const bad of ['', '1.5', '-1', '1e3', 'abc']) {
      it(`refuses ${key}=${JSON.stringify(bad)} and stores nothing`, async () => {
        const { status, body } = await patch(key, bad)
        expect(status).to.equal(400)
        expect(body.error).to.equal('invalid_tip_value')
        expect(rows.has(key)).to.equal(false)
      })
    }
  }

  it('stores a whole number, given as a string or a number', async () => {
    expect((await patch('validatorBaseTip', '1000')).status).to.equal(200)
    expect(rows.get('validatorBaseTip')).to.equal('1000')
    expect((await patch('minTipPerActionWei', 450000000000)).status).to.equal(200)
    expect(rows.get('minTipPerActionWei')).to.equal('450000000000')
  })

  it('still refuses a priority tip below the base tip', async () => {
    rows.set('validatorBaseTip', '1000')
    const { status, body } = await patch('priorityTip', '999')
    expect(status).to.equal(400)
    expect(body.error).to.equal('priority_below_base')
  })

  it('lets a good value through when the other tip row is malformed', async () => {
    rows.set('priorityTip', '1.5')
    expect((await patch('validatorBaseTip', '1000')).status).to.equal(200)
    expect((await patch('priorityTip', '3000')).status).to.equal(200)
    expect(rows.get('priorityTip')).to.equal('3000')
  })

  it('leaves the other settings to their own readers', async () => {
    expect((await patch('checkInterval', '')).status).to.equal(200)
    expect((await patch('acceptZeroTip', 'true')).status).to.equal(200)
  })
})
