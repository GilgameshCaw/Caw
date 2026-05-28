#!/usr/bin/env node
/**
 * Sanity-check CAW conservation across L1 and L2.
 *
 * Three invariants:
 *
 *   I1. L2 totalCaw == sum(cawBalanceOf(tokenId)) for tokenId in [1..nextId-1]
 *       (no CAW minted or burned outside of bookkeeping)
 *
 *   I2. L1 CAW.balanceOf(CawProfile) >= L2 totalCaw
 *       (every CAW on L2 is backed 1:1 by CAW locked on L1; the >= accounts
 *        for in-flight L1→L2 deposit LZ messages that haven't landed yet)
 *
 *   I3. drift_pct = (L1_locked - L2_total) / L1_locked * 100
 *       Should be tiny (< 0.01%) at rest. Larger means LZ messages in flight
 *       or, if persistent, a real conservation hole.
 *
 * Usage:
 *   node scripts/verify-conservation.js
 *
 * Reads from client/.env:
 *   L1_RPC_URL_HTTP, L2_RPC_URL_HTTP
 *
 * Reads addresses from client/src/abi/addresses.ts (per-install).
 */

const { ethers } = require('ethers')
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../../client/.env') })

// ---------------------------------------------------------------------------
// Address loading
// ---------------------------------------------------------------------------

function loadAddresses() {
  const addrPath = path.join(__dirname, '../../client/src/abi/addresses.ts')
  const src = fs.readFileSync(addrPath, 'utf8')
  const grab = (name) => {
    const m = src.match(new RegExp(`export const ${name} = "(0x[0-9a-fA-F]+)"`))
    if (!m) throw new Error(`addresses.ts missing ${name}`)
    return m[1]
  }
  return {
    cawL1:     grab('CAW_ADDRESS'),
    profileL1: grab('CAW_NAMES_ADDRESS'),
    profileL2: grab('CAW_NAMES_L2_ADDRESS'),
  }
}

// ---------------------------------------------------------------------------
// Minimal ABIs — just the views we need
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
]

const PROFILE_L1_ABI = [
  // ERC721Enumerable total minted count
  'function totalSupply() view returns (uint256)',
]

const PROFILE_L2_ABI = [
  'function totalCaw() view returns (uint256)',
  'function cawBalanceOf(uint32 tokenId) view returns (uint256)',
]

// ---------------------------------------------------------------------------
// Conservation check
// ---------------------------------------------------------------------------

async function main() {
  const l1Rpc = process.env.L1_RPC_URL_HTTP
  const l2Rpc = process.env.L2_RPC_URL_HTTP
  if (!l1Rpc) throw new Error('L1_RPC_URL_HTTP missing in client/.env')
  if (!l2Rpc) throw new Error('L2_RPC_URL_HTTP missing in client/.env')

  const addrs = loadAddresses()
  console.log('Addresses:')
  console.log(`  CAW (L1):         ${addrs.cawL1}`)
  console.log(`  CawProfile (L1):  ${addrs.profileL1}`)
  console.log(`  CawProfileL2:     ${addrs.profileL2}`)
  console.log()

  const l1 = new ethers.JsonRpcProvider(l1Rpc)
  const l2 = new ethers.JsonRpcProvider(l2Rpc)

  const caw       = new ethers.Contract(addrs.cawL1,     ERC20_ABI,       l1)
  const profileL1 = new ethers.Contract(addrs.profileL1, PROFILE_L1_ABI,  l1)
  const profileL2 = new ethers.Contract(addrs.profileL2, PROFILE_L2_ABI,  l2)

  // Pin to a single block on each chain so balances don't drift mid-script.
  const [l1Block, l2Block] = await Promise.all([
    l1.getBlockNumber(),
    l2.getBlockNumber(),
  ])
  console.log(`Pinned: L1 block ${l1Block}, L2 block ${l2Block}`)
  console.log()

  // ── L2 side ──────────────────────────────────────────────────────────────
  // totalCaw (claimed ledger) + sum of per-token balances (derived ledger)
  console.log('Reading L2 state…')
  const totalCaw = await profileL2.totalCaw({ blockTag: l2Block })

  // L1 totalSupply tells us the highest minted tokenId range.
  const totalMinted = await profileL1.totalSupply({ blockTag: l1Block })
  const nMinted = Number(totalMinted)
  console.log(`  L1 totalSupply (minted profiles): ${nMinted}`)
  console.log(`  L2 totalCaw (claimed):            ${ethers.formatEther(totalCaw)} CAW`)

  // Sum per-token balances. We iterate [1..nMinted] which works as long as
  // tokenIds are sequentially allocated starting at 1 (they are).
  // Batch the reads with Promise.all in chunks to avoid hammering the RPC.
  const CHUNK = 50
  let sumBalances = 0n
  for (let start = 1; start <= nMinted; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, nMinted)
    const ids = []
    for (let i = start; i <= end; i++) ids.push(i)
    const balances = await Promise.all(
      ids.map(id => profileL2.cawBalanceOf(id, { blockTag: l2Block })),
    )
    for (const b of balances) sumBalances += b
    process.stdout.write(`\r  Summed tokens 1..${end}/${nMinted}`)
  }
  if (nMinted > 0) console.log()

  console.log(`  L2 sum(cawBalanceOf):             ${ethers.formatEther(sumBalances)} CAW`)

  // ── L1 side ──────────────────────────────────────────────────────────────
  console.log('Reading L1 state…')
  const l1Locked = await caw.balanceOf(addrs.profileL1, { blockTag: l1Block })
  console.log(`  L1 CAW.balanceOf(CawProfile):     ${ethers.formatEther(l1Locked)} CAW`)
  console.log()

  // ── Invariants ───────────────────────────────────────────────────────────
  const i1Drift = totalCaw - sumBalances
  const i1OK = i1Drift === 0n
  const i2OK = l1Locked >= totalCaw
  const i2Diff = l1Locked - totalCaw
  const i3Pct = l1Locked > 0n
    ? Number((i2Diff * 1_000_000n) / l1Locked) / 10_000  // 4-decimal percent
    : 0

  console.log('────────────────────────────────────────────────')
  console.log('Conservation invariants')
  console.log('────────────────────────────────────────────────')
  console.log(`I1: L2 totalCaw == sum(cawBalanceOf)`)
  console.log(`    ${i1OK ? 'PASS' : 'FAIL'}  drift = ${ethers.formatEther(i1Drift)} CAW`)
  if (!i1OK) {
    console.log(`    ↑ a non-zero drift means a CAW conservation hole on L2.`)
    console.log(`      The contract minted/burned CAW outside of bookkeeping.`)
    console.log(`      This is a CRITICAL bug — investigate immediately.`)
  }
  console.log()
  console.log(`I2: L1 locked >= L2 totalCaw`)
  console.log(`    ${i2OK ? 'PASS' : 'FAIL'}  L1 - L2 = ${ethers.formatEther(i2Diff)} CAW (${i3Pct.toFixed(4)}%)`)
  if (!i2OK) {
    console.log(`    ↑ L2 claims more CAW than L1 has locked.`)
    console.log(`      This means L2 minted CAW that's not backed by L1 deposit.`)
    console.log(`      CRITICAL bug — investigate immediately.`)
  } else if (i3Pct > 0.01) {
    console.log(`    ↑ drift > 0.01% — likely LZ messages in flight (normal during`)
    console.log(`      active deposits). Re-run after a few minutes; if it persists,`)
    console.log(`      investigate stuck LZ messages.`)
  }
  console.log()

  const allOK = i1OK && i2OK
  console.log(allOK ? 'All invariants hold ✓' : 'CONSERVATION VIOLATED — see above')
  process.exit(allOK ? 0 : 1)
}

main().catch(e => {
  console.error('verify-conservation failed:', e)
  process.exit(2)
})
