import { expect } from 'chai'
import { Prisma } from '@prisma/client'
import { adminJsonReplacer } from '../../src/utils/decimalJson'

const dump = (v: unknown) => JSON.stringify(v, adminJsonReplacer)

describe('adminJsonReplacer', () => {
  it('writes a Decimal above 1e21 as plain digits, not exponent notation', () => {
    const d = new Prisma.Decimal('355660137410000000000000000')
    expect(JSON.stringify({ v: d })).to.equal('{"v":"3.5566013741e+26"}') // what the detail route returned before
    expect(dump({ v: d })).to.equal('{"v":"355660137410000000000000000"}')
  })

  it('leaves a Decimal below 1e21 unchanged', () => {
    expect(dump({ v: new Prisma.Decimal('5290000000000000000') })).to.equal('{"v":"5290000000000000000"}')
  })

  it('does not round a fractional Decimal', () => {
    expect(dump({ v: new Prisma.Decimal('1234.5678') })).to.equal('{"v":"1234.5678"}')
  })

  it('writes a bigint as a decimal string', () => {
    expect(dump({ n: 9007199254740993n })).to.equal('{"n":"9007199254740993"}')
  })

  it('handles Decimal and bigint inside an array of records', () => {
    const rows = [
      { id: 3, startPrice: new Prisma.Decimal('355660137410000000000000000'), endPrice: null, blockNumber: 47338158n },
      { id: 1, startPrice: new Prisma.Decimal('5290000000000000000'), endPrice: new Prisma.Decimal('0'), blockNumber: 1n },
    ]
    expect(JSON.parse(dump(rows))).to.deep.equal([
      { id: 3, startPrice: '355660137410000000000000000', endPrice: null, blockNumber: '47338158' },
      { id: 1, startPrice: '5290000000000000000', endPrice: '0', blockNumber: '1' },
    ])
  })

  it('keeps other values as they were', () => {
    const when = new Date('2026-09-26T13:44:35.485Z')
    expect(JSON.parse(dump({ s: 'x', n: 1, b: true, z: null, d: when }))).to.deep.equal({
      s: 'x', n: 1, b: true, z: null, d: '2026-09-26T13:44:35.485Z',
    })
  })
})
