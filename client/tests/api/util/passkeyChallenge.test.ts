import { describe, it, before, beforeEach, after } from "mocha"
import { expect } from "chai"

// passkeyVerify.ts creates its own Redis client when it is imported. Point it at
// a closed port, and keep that client from dialling at all while the module is
// loaded (see before()), so no test run reaches a real Redis and the process can
// end by itself. The helpers under test use the in-memory stub below.
process.env.REDIS_URL = "redis://127.0.0.1:1"

// The part of ioredis the helpers use: set with EX and NX, and del.
class StubStore {
  data = new Map<string, string>()
  setCalls: unknown[][] = []
  delCalls: string[] = []
  async set(key: string, value: string, ...flags: unknown[]) {
    this.setCalls.push([key, value, ...flags])
    if (flags.includes("NX") && this.data.has(key)) return null
    this.data.set(key, value)
    return "OK"
  }
  async del(key: string) {
    this.delCalls.push(key)
    return this.data.delete(key) ? 1 : 0
  }
}

describe("passkey challenges: one per ceremony", () => {
  let mod: typeof import("../../../src/api/util/passkeyVerify")
  let store: StubStore

  before(async () => {
    const IORedis = (await import("ioredis")).default
    const realConnect = IORedis.prototype.connect
    IORedis.prototype.connect = (async () => undefined) as any
    try {
      mod = await import("../../../src/api/util/passkeyVerify")
    } finally {
      IORedis.prototype.connect = realConnect
    }
  })
  beforeEach(() => {
    store = new StubStore()
    mod._setChallengeStoreForTest(store as any)
  })
  after(() => mod._setChallengeStoreForTest(null))

  it("issues a 32-byte 0x challenge, stored with a 5 minute expiry and only if the key is new", async () => {
    const c = await mod.issuePasskeyChallenge(7)
    expect(c).to.match(/^0x[0-9a-f]{64}$/)
    expect(store.setCalls).to.have.length(1)
    const [key, , ...flags] = store.setCalls[0]
    expect(key).to.equal(`passkey-challenge:7:${c}`)
    expect(flags).to.deep.equal(["EX", 300, "NX"])
  })

  it("a challenge can be used once", async () => {
    const c = await mod.issuePasskeyChallenge(7)
    expect(await mod.consumePasskeyChallenge(7, c)).to.equal(true)
    expect(await mod.consumePasskeyChallenge(7, c)).to.equal(false)
  })

  it("two concurrent uses of one challenge: exactly one passes", async () => {
    const c = await mod.issuePasskeyChallenge(7)
    const results = await Promise.all([mod.consumePasskeyChallenge(7, c), mod.consumePasskeyChallenge(7, c)])
    expect(results.filter(Boolean)).to.have.length(1)
  })

  it("a new challenge for the same tokenId does not cancel an earlier one", async () => {
    const first = await mod.issuePasskeyChallenge(7)
    const second = await mod.issuePasskeyChallenge(7) // e.g. another tab, or a request from someone else
    expect(second).to.not.equal(first)
    expect(await mod.consumePasskeyChallenge(7, first)).to.equal(true)
    expect(await mod.consumePasskeyChallenge(7, second)).to.equal(true)
  })

  it("a challenge issued for one tokenId is not accepted for another", async () => {
    const c = await mod.issuePasskeyChallenge(7)
    expect(await mod.consumePasskeyChallenge(8, c)).to.equal(false)
    expect(await mod.consumePasskeyChallenge(7, c)).to.equal(true)
  })

  it("the hex digits may be upper case, as before", async () => {
    const c = await mod.issuePasskeyChallenge(7)
    expect(await mod.consumePasskeyChallenge(7, "0x" + c.slice(2).toUpperCase())).to.equal(true)
  })

  it("a string that is not a challenge is refused without touching the store", async () => {
    for (const bad of ["", "0x1234", "x".repeat(10_000), "0x" + "g".repeat(64), "0x" + "a".repeat(63), "0x" + "a".repeat(65), 5 as any, undefined as any]) {
      expect(await mod.consumePasskeyChallenge(7, bad)).to.equal(false)
    }
    expect(store.delCalls).to.have.length(0)
  })

  it("a challenge kept under the old one-slot key is not accepted (what a deploy leaves behind for one TTL)", async () => {
    const c = "0x" + "ab".repeat(32)
    store.data.set("passkey-challenge:7", c)
    expect(await mod.consumePasskeyChallenge(7, c)).to.equal(false)
  })

  it("fails loudly if the key already exists (a collision of 32 random bytes cannot happen in practice)", async () => {
    const original = store.set.bind(store)
    store.set = async () => null // NX refused
    let threw = false
    try {
      await mod.issuePasskeyChallenge(7)
    } catch {
      threw = true
    }
    store.set = original
    expect(threw).to.equal(true)
  })
})
