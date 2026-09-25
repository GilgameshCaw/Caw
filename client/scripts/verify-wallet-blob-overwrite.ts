// Verifies that POST /api/wallet/blob never replaces a stored backup blob.
// Mounts the real wallet-blob router with the real Prisma client against a
// DISPOSABLE database, then exercises: first write, identical re-send,
// overwrite attempt, first write for an address that already has a profile,
// and concurrent first writes (different / identical blobs). No email is sent.
//
// Refuses to run unless the database name ends in "_verify". Creates random
// addresses and one synthetic User row, and deletes them at the end.
//
// Run (from client/):
//   WALLET_BLOB_VERIFY_DB_URL=postgresql://.../<name>_verify npx tsx scripts/verify-wallet-blob-overwrite.ts

import http from 'http'
import express from 'express'
import type { AddressInfo } from 'net'
import { ethers } from 'ethers'

const url = process.env.WALLET_BLOB_VERIFY_DB_URL
if (!url) {
  console.error('Set WALLET_BLOB_VERIFY_DB_URL to a disposable database whose name ends in "_verify".')
  process.exit(2)
}
const dbName = new URL(url).pathname.replace(/^\//, '')
if (!dbName.endsWith('_verify')) {
  console.error(`Refusing to run against "${dbName}": the database name must end in "_verify".`)
  process.exit(2)
}
process.env.DATABASE_URL = url

async function main() {
  const { prisma } = await import('../src/prismaClient')
  const { default: router } = await import('../src/api/routes/wallet-blob')

  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api/wallet', router)
  const server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const newAddr = () => ethers.Wallet.createRandom().address
  const newBlob = () => JSON.stringify({ version: 1, kdf: 'argon2id', salt: ethers.hexlify(ethers.randomBytes(16)), ciphertext: ethers.hexlify(ethers.randomBytes(48)) })
  const post = async (address: string, blob: string) => {
    const r = await fetch(`${base}/api/wallet/blob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, blob }),
    })
    return r.status
  }
  const stored = async (address: string) =>
    (await prisma.walletBlob.findUnique({ where: { address: address.toLowerCase() } }))?.blob ?? null

  let failures = 0
  const check = (label: string, ok: boolean, detail: unknown) => {
    if (!ok) failures++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} -> ${JSON.stringify(detail)}`)
  }

  const A = newAddr(), C = newAddr(), D = newAddr(), P = newAddr()
  const blobA = newBlob(), blobB = newBlob()
  const userId = 900000000 + Math.floor(Math.random() * 1000000)
  try {
    // 1) first write, pre-mint (no profile)
    const s1 = await post(A, blobA)
    check('1 first write (no profile): stored', s1 === 200 && (await stored(A)) === blobA, { status: s1 })

    // 2) identical re-send (the onboarding email step)
    const s2 = await post(A, blobA)
    check('2 identical re-send: accepted, unchanged', s2 === 200 && (await stored(A)) === blobA, { status: s2 })

    // 3) overwrite with a different blob (the attack)
    const s3 = await post(A, blobB)
    const after3 = await stored(A)
    check('3 overwrite attempt: rejected, original kept', s3 === 409 && after3 === blobA, { status: s3, originalKept: after3 === blobA })

    // 4) first write for an address that already has a profile
    await prisma.user.create({ data: { id: userId, tokenId: userId, username: `verify${userId}`, address: P } })
    const s4 = await post(P, newBlob())
    const after4 = await stored(P)
    check('4 first write for an existing profile: rejected, nothing stored', s4 === 409 && after4 === null, { status: s4, stored: after4 !== null })

    // 5) concurrent first writes with different blobs
    const c1 = newBlob(), c2 = newBlob()
    const [r1, r2] = await Promise.all([post(C, c1), post(C, c2)])
    const afterC = await stored(C)
    const winner = r1 === 200 ? c1 : r2 === 200 ? c2 : null
    check('5 concurrent different blobs: one accepted, one rejected, winner stored',
      [r1, r2].sort().join(',') === '200,409' && afterC === winner, { statuses: [r1, r2], winnerStored: afterC === winner })

    // 6) concurrent first writes with the identical blob
    const d = newBlob()
    const [q1, q2] = await Promise.all([post(D, d), post(D, d)])
    check('6 concurrent identical blobs: both accepted, stored', q1 === 200 && q2 === 200 && (await stored(D)) === d, { statuses: [q1, q2] })
  } finally {
    await prisma.walletBlob.deleteMany({ where: { address: { in: [A, C, D, P].map((a) => a.toLowerCase()) } } })
    await prisma.user.deleteMany({ where: { id: userId } })
    server.close()
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
