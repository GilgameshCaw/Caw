import { describe, it } from "mocha"
import { expect } from "chai"
import { ethers } from "ethers"
import { recoverSigner, sessionExpiryConflict } from "../../src/api/util/scheduledSessionExpiry"

const domain = { name: "CAW", version: "1", chainId: 84532, verifyingContract: "0x" + "11".repeat(20) }
const types = { ActionData: [{ name: "senderId", type: "uint32" }, { name: "cawonce", type: "uint256" }] }
const data = { senderId: 7, cawonce: 3 }

async function signed(wallet: ethers.Wallet) {
  return { data, domain, types, signature: await wallet.signTypedData(domain, types, data) }
}

describe("recoverSigner", () => {
  it("returns the address that signed the action, lower-cased", async () => {
    const wallet = ethers.Wallet.createRandom()
    expect(recoverSigner(await signed(wallet))).to.equal(wallet.address.toLowerCase())
  })

  it("recovers a different address when a signed field is changed", async () => {
    const wallet = ethers.Wallet.createRandom()
    const s = await signed(wallet)
    const tampered = { ...s, data: { ...data, cawonce: 4 } }
    expect(recoverSigner(tampered)).to.not.equal(wallet.address.toLowerCase())
  })

  it("returns null for a passkey-length signature (not 65 bytes)", async () => {
    const wallet = ethers.Wallet.createRandom()
    const s = await signed(wallet)
    expect(recoverSigner({ ...s, signature: "0x" + "ab".repeat(200) })).to.equal(null)
  })

  it("returns null for a malformed signature or a missing part", async () => {
    const wallet = ethers.Wallet.createRandom()
    const s = await signed(wallet)
    expect(recoverSigner({ ...s, signature: "0x1234" })).to.equal(null)
    expect(recoverSigner({ data, types, signature: s.signature })).to.equal(null)
    expect(recoverSigner(undefined)).to.equal(null)
  })
})

describe("sessionExpiryConflict", () => {
  const owner = "0x" + "aa".repeat(20)
  const signer = "0x" + "bb".repeat(20)
  const scheduledSec = 1_800_000_000
  const live = { expirySec: scheduledSec + 3600, revoked: false }

  it("reports a conflict when the session expires before the scheduled time", () => {
    const got = sessionExpiryConflict({ owner, signer, session: { expirySec: scheduledSec - 1, revoked: false }, scheduledSec })
    expect(got).to.deep.equal({ sessionAddress: signer, expiresAt: scheduledSec - 1, reason: "expired" })
  })

  it("reports a conflict when the session expires exactly at the scheduled time", () => {
    const got = sessionExpiryConflict({ owner, signer, session: { expirySec: scheduledSec, revoked: false }, scheduledSec })
    expect(got).to.deep.equal({ sessionAddress: signer, expiresAt: scheduledSec, reason: "expired" })
  })

  it("reports a conflict for a revoked session, even one that is still live", () => {
    const got = sessionExpiryConflict({ owner, signer, session: { ...live, revoked: true }, scheduledSec })
    expect(got).to.deep.equal({ sessionAddress: signer, expiresAt: live.expirySec, reason: "revoked" })
  })

  it("reports no conflict when the session outlives the scheduled time", () => {
    expect(sessionExpiryConflict({ owner, signer, session: live, scheduledSec })).to.equal(null)
  })

  it("never checks the owner's own signature", () => {
    const expired = { expirySec: scheduledSec - 1, revoked: false }
    expect(sessionExpiryConflict({ owner, signer: owner, session: expired, scheduledSec })).to.equal(null)
  })

  it("reports no conflict for an unknown session, an unregistered one, or an unrecovered signer", () => {
    expect(sessionExpiryConflict({ owner, signer, session: null, scheduledSec })).to.equal(null)
    expect(sessionExpiryConflict({ owner, signer, session: { expirySec: 0, revoked: false }, scheduledSec })).to.equal(null)
    expect(sessionExpiryConflict({ owner, signer: null, session: live, scheduledSec })).to.equal(null)
  })
})
