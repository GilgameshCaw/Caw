import { describe, it } from "mocha"
import { expect } from "chai"
import { txsFromIndex, prismaIndexReader, type IndexReader } from "../../src/utils/replicationTxIndex"

// An index of executed actions, oldest first: one entry per action with the
// block and transaction it landed in. Mirrors what RawEvent / Action hold.
type Row = { block: number; tx: string; address?: string }
function readerOver(rows: Row[], calls: string[] = []): IndexReader {
  return {
    async countExecuted() { calls.push("count"); return rows.length },
    async blockOfNthNewest(n) {
      calls.push(`nth:${n}`)
      const row = rows[rows.length - n]
      return row ? row.block : null
    },
    async txsFromBlock(block) {
      calls.push(`from:${block}`)
      return rows.filter(r => r.block >= block).map(r => ({ transactionHash: r.tx, address: r.address ?? "0xAAAA" }))
    },
  }
}

// 70 actions: one per block 100..169, one transaction each.
const seventy: Row[] = Array.from({ length: 70 }, (_, i) => ({ block: 100 + i, tx: `0x${i}` }))

describe("txsFromIndex", () => {
  it("lists the transactions from the range start to the newest indexed action", async () => {
    // checkpoint 2 = positions 32..63; the index holds 70 actions.
    const got = await txsFromIndex(readerOver(seventy), 32, 32)
    expect(got).to.not.equal(null)
    expect(got!.endCount).to.equal(70)
    expect(got!.fromBlock).to.equal(132)
    expect(got!.txs.length).to.equal(38)
    expect(got!.txs[0].transactionHash).to.equal("0x32")
    expect(got!.txs[37].transactionHash).to.equal("0x69")
  })

  it("does not depend on how far behind the head the actions are", async () => {
    // Same 70 actions, 6,000,000 blocks apart: still three reads.
    const sparse = seventy.map((r, i) => ({ ...r, block: 1_000_000 + i * 86_000 }))
    const calls: string[] = []
    const got = await txsFromIndex(readerOver(sparse, calls), 32, 32)
    expect(got!.txs.length).to.equal(38)
    expect(calls).to.deep.equal(["count", "nth:38", `from:${1_000_000 + 32 * 86_000}`])
  })

  it("takes the whole block of the range start, so a batch is never cut", async () => {
    // Actions 30..34 share one transaction in block 500; the range starts at 32.
    const rows: Row[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ block: 100 + i, tx: `0xa${i}` })),
      ...Array.from({ length: 5 }, () => ({ block: 500, tx: "0xbatch" })),
      ...Array.from({ length: 35 }, (_, i) => ({ block: 600 + i, tx: `0xc${i}` })),
    ]
    const got = await txsFromIndex(readerOver(rows), 32, 32)
    expect(got!.fromBlock).to.equal(500)
    expect(got!.txs[0].transactionHash).to.equal("0xbatch")
    expect(got!.txs.filter(t => t.transactionHash === "0xbatch").length).to.equal(1)
    expect(got!.txs.length).to.equal(36)
  })

  it("returns null when the index does not hold the whole range", async () => {
    expect(await txsFromIndex(readerOver(seventy.slice(0, 63)), 32, 32)).to.equal(null)
    expect(await txsFromIndex(readerOver([]), 0, 32)).to.equal(null)
  })

  it("uses the range as soon as the index holds it, even if newer actions are missing", async () => {
    const got = await txsFromIndex(readerOver(seventy.slice(0, 64)), 32, 32)
    expect(got!.endCount).to.equal(64)
    expect(got!.txs.length).to.equal(32)
  })

  it("returns null on bad arguments and never reads", async () => {
    const calls: string[] = []
    expect(await txsFromIndex(readerOver(seventy, calls), -1, 32)).to.equal(null)
    expect(await txsFromIndex(readerOver(seventy, calls), 0, 0)).to.equal(null)
    expect(await txsFromIndex(readerOver(seventy, calls), 1.5, 32)).to.equal(null)
    expect(calls).to.deep.equal([])
  })

  it("lower-cases the emitting contract", async () => {
    const got = await txsFromIndex(readerOver(seventy.map(r => ({ ...r, address: "0xABCdef" }))), 32, 32)
    expect(got!.txs.every(t => t.address === "0xabcdef")).to.equal(true)
  })

  it("lets a failing read throw, so the caller can fall back", async () => {
    const reader = readerOver(seventy)
    reader.txsFromBlock = async () => { throw new Error("db down") }
    let thrown = ""
    await txsFromIndex(reader, 32, 32).catch(e => { thrown = e.message })
    expect(thrown).to.equal("db down")
  })
})

describe("prismaIndexReader", () => {
  it("binds chain, network and contracts as parameters and lower-cases the contracts", async () => {
    const seen: Array<{ q: string; v: any[] }> = []
    const db = { async $queryRawUnsafe(q: string, ...v: any[]) { seen.push({ q, v }); return [] as any } }
    const reader = prismaIndexReader(db, 84532, 1, ["0xAbC", ""])
    expect(await reader.countExecuted()).to.equal(0)
    expect(await reader.blockOfNthNewest(3)).to.equal(null)
    expect(await reader.txsFromBlock(10)).to.deep.equal([])
    expect(seen.length).to.equal(3)
    for (const s of seen) {
      expect(s.v.slice(0, 3)).to.deep.equal([84532, "1", ["0xabc"]])
      expect(s.q).to.not.contain("84532")
      expect(s.q).to.not.contain("0xabc")
    }
    expect(seen[1].v[3]).to.equal(2)
    expect(seen[2].v[3]).to.equal(10)
  })

  it("does not query for a position below 1", async () => {
    let n = 0
    const db = { async $queryRawUnsafe() { n++; return [] as any } }
    expect(await prismaIndexReader(db, 1, 1, ["0x1"]).blockOfNthNewest(0)).to.equal(null)
    expect(n).to.equal(0)
  })
})
