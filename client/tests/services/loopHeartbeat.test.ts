import { describe, it } from "mocha"
import { expect } from "chai"
import { runBeat, stallReason, type LoopBeats } from "../../src/utils/loopHeartbeat"

function recorder() {
  const calls: string[] = []
  const beats: LoopBeats = {
    heartbeat: (loop) => { calls.push(`ok:${loop}`) },
    heartbeatDegraded: (loop, reason) => { calls.push(`degraded:${loop}:${reason}`) },
  }
  return { calls, beats }
}

describe("runBeat", () => {
  it("heartbeats after an iteration that resolves", async () => {
    const { calls, beats } = recorder()
    expect(await runBeat("ChainSync:L2Events", beats, async () => 1)).to.equal(true)
    expect(calls).to.deep.equal(["ok:ChainSync:L2Events"])
  })

  it("reports degraded, with the reason, after an iteration that throws", async () => {
    // What ethers gives for an RPC that answers 402 Payment Required.
    const { calls, beats } = recorder()
    const seen: unknown[] = []
    const err = new Error("server response 402 Payment Required")
    expect(await runBeat("ChainSync:L2Events", beats, async () => { throw err }, e => seen.push(e))).to.equal(false)
    expect(calls).to.deep.equal(["degraded:ChainSync:L2Events:server response 402 Payment Required"])
    expect(seen).to.deep.equal([err])
  })

  it("never reports both, and never rethrows", async () => {
    const { calls, beats } = recorder()
    await runBeat("a", beats, async () => { throw new Error("x") })
    await runBeat("a", beats, async () => undefined)
    expect(calls).to.deep.equal(["degraded:a:x", "ok:a"])
  })

  it("still reports degraded when the error callback itself throws", async () => {
    const { calls, beats } = recorder()
    await runBeat("a", beats, async () => { throw new Error("rpc") }, () => { throw new Error("log failed") })
    expect(calls).to.deep.equal(["degraded:a:rpc"])
  })

  it("waits for the iteration before reporting", async () => {
    const { calls, beats } = recorder()
    const p = runBeat("a", beats, () => new Promise(r => setTimeout(r, 20)))
    expect(calls).to.deep.equal([])
    await p
    expect(calls).to.deep.equal(["ok:a"])
  })
})

describe("stallReason", () => {
  it("prefers the RPC error message, then ethers shortMessage, then message", () => {
    expect(stallReason({ error: { message: "rate limited" }, shortMessage: "s", message: "m" })).to.equal("rate limited")
    expect(stallReason({ shortMessage: "could not coalesce error", message: "m" })).to.equal("could not coalesce error")
    expect(stallReason(new Error("plain"))).to.equal("plain")
    expect(stallReason("text")).to.equal("text")
  })

  it("is one line of at most 160 characters", () => {
    const got = stallReason(new Error("a\n  b\tc " + "x".repeat(400)))
    expect(got.startsWith("a b c x")).to.equal(true)
    expect(got.length).to.equal(160)
    expect(/\n/.test(got)).to.equal(false)
  })
})
