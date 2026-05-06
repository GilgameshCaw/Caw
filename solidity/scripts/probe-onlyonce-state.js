/**
 * Probe deployed testnet contracts for OnlyOnce / OnlyOwner state.
 *
 * Goal: before we set delegates and renounce ownership, audit which
 * one-shot setters have already been consumed and which slots remain
 * open. A renounce on a contract with an unfilled OnlyOnce slot is
 * irreversible: that slot can never be set again.
 *
 * Sources:
 *  - addresses: solidity/.deploy-state.json
 *  - chain config (RPC + EID): same CHAINS table deploy.js uses
 *  - state: read via public getters (peers, minter, uriGenerator,
 *    cawActions, cawProfile, bypassLZ, owner, delegate)
 *
 * No transactions are sent. Read-only.
 */

const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })

const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.deploy-state.json'), 'utf8'))

// Prefer named keys from solidity/.env (RPC_SEPOLIA, etc.) since those carry
// API tokens; fall back to deploy-time L*_RPC_URL, then public endpoints.
// Public Sepolia (eth-sepolia.public.blastapi.io) was returning 403 at probe
// time — having an Infura key keeps this script reliable.
const CHAINS = {
  testnetL1: {
    name: 'Sepolia',
    rpc: process.env.RPC_SEPOLIA || process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io',
    chainId: 11155111,
    lzEid: 40161,
  },
  testnetL2: {
    name: 'Base Sepolia',
    rpc: process.env.RPC_BASE_SEPOLIA || process.env.L2_RPC_URL || 'https://sepolia.base.org',
    chainId: 84532,
    lzEid: 40245,
  },
  testnetL2b: {
    name: 'Arbitrum Sepolia',
    rpc: process.env.RPC_ARBITRUM_SEPOLIA || process.env.L2B_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
    chainId: 421614,
    lzEid: 40231,
  },
}

// Minimal ABIs — only the getters we need.
const OAPP_ABI = [
  'function owner() view returns (address)',
  'function peers(uint32) view returns (bytes32)',
  'function endpoint() view returns (address)',
]
const ENDPOINT_ABI = [
  'function delegates(address) view returns (address)',
]
const PROFILE_ABI = [
  ...OAPP_ABI,
  'function minter() view returns (address)',
  'function uriGenerator() view returns (address)',
]
const PROFILE_L2_ABI = [
  ...OAPP_ABI,
  'function cawActions() view returns (address)',
  'function cawProfile() view returns (address)',
  'function bypassLZ() view returns (bool)',
]

const ZERO_ADDR  = '0x0000000000000000000000000000000000000000'
const ZERO_BYTES = '0x' + '00'.repeat(32)

function fmt(addr) {
  if (!addr || addr === ZERO_ADDR) return '<unset>'
  return addr
}
function fmtPeer(b) {
  if (!b || b === ZERO_BYTES) return '<unset>'
  return b
}
function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

async function getDelegate(provider, oapp) {
  // OApp.endpoint() → EndpointV2.delegates(oapp)
  try {
    const c = new ethers.Contract(oapp, OAPP_ABI, provider)
    const ep = await c.endpoint()
    if (!ep || ep === ZERO_ADDR) return { endpoint: '<none>', delegate: '<n/a>' }
    const e = new ethers.Contract(ep, ENDPOINT_ABI, provider)
    const d = await e.delegates(oapp)
    return { endpoint: ep, delegate: fmt(d) }
  } catch (err) {
    return { endpoint: '<err>', delegate: `<err: ${err.message.slice(0, 40)}>` }
  }
}

async function probeProfileL1(provider, addr, peerEids) {
  const c = new ethers.Contract(addr, PROFILE_ABI, provider)
  const [owner, minter, uri] = await Promise.all([
    c.owner().catch(e => `<err: ${e.message.slice(0, 40)}>`),
    c.minter().catch(() => ZERO_ADDR),
    c.uriGenerator().catch(() => ZERO_ADDR),
  ])
  const peers = {}
  for (const eid of peerEids) {
    peers[eid] = await c.peers(eid).catch(() => ZERO_BYTES)
  }
  const { endpoint, delegate } = await getDelegate(provider, addr)
  return { owner, minter, uri, peers, endpoint, delegate }
}

async function probeProfileL2(provider, addr, peerEids) {
  const c = new ethers.Contract(addr, PROFILE_L2_ABI, provider)
  const [owner, cawActions, cawProfile, bypassLZ] = await Promise.all([
    c.owner().catch(e => `<err: ${e.message.slice(0, 40)}>`),
    c.cawActions().catch(() => ZERO_ADDR),
    c.cawProfile().catch(() => ZERO_ADDR),
    c.bypassLZ().catch(() => false),
  ])
  const peers = {}
  for (const eid of peerEids) {
    peers[eid] = await c.peers(eid).catch(() => ZERO_BYTES)
  }
  const { endpoint, delegate } = await getDelegate(provider, addr)
  return { owner, cawActions, cawProfile, bypassLZ, peers, endpoint, delegate }
}

async function probeOApp(provider, addr, peerEids) {
  const c = new ethers.Contract(addr, OAPP_ABI, provider)
  const owner = await c.owner().catch(e => `<err: ${e.message.slice(0, 40)}>`)
  const peers = {}
  for (const eid of peerEids) {
    peers[eid] = await c.peers(eid).catch(() => ZERO_BYTES)
  }
  const { endpoint, delegate } = await getDelegate(provider, addr)
  return { owner, peers, endpoint, delegate }
}

// CawActions is plain Ownable — no peers, no LZ endpoint, no delegate. We
// only audit its owner so we know whether it's still controllable.
async function probeOwnableOnly(provider, addr) {
  const c = new ethers.Contract(addr, ['function owner() view returns (address)'], provider)
  const owner = await c.owner().catch(e => `<err: ${e.message.slice(0, 40)}>`)
  return { owner }
}

async function main() {
  const A = STATE.addresses
  const deployer = STATE.deployerAddress

  const providers = {
    L1:  new ethers.JsonRpcProvider(CHAINS.testnetL1.rpc),
    L2:  new ethers.JsonRpcProvider(CHAINS.testnetL2.rpc),
    L2b: new ethers.JsonRpcProvider(CHAINS.testnetL2b.rpc),
  }
  const eid = {
    L1:  CHAINS.testnetL1.lzEid,
    L2:  CHAINS.testnetL2.lzEid,
    L2b: CHAINS.testnetL2b.lzEid,
  }

  console.log('='.repeat(78))
  console.log('CAW testnet OnlyOnce / OnlyOwner audit')
  console.log('Deployer:', deployer)
  console.log('Sepolia EID:', eid.L1, '| Base Sep EID:', eid.L2, '| Arb Sep EID:', eid.L2b)
  console.log('='.repeat(78))

  const lines = []
  function row(network, contract, addr, owner, extras) {
    const ownedByDeployer = owner && owner.toLowerCase() === deployer.toLowerCase()
    const ownerTag = !owner ? '<err>' : (owner === ZERO_ADDR ? 'RENOUNCED' : (ownedByDeployer ? 'deployer' : 'OTHER:' + owner))
    lines.push({ network, contract, addr, owner: ownerTag, ...extras })
  }

  // ---------- Sepolia (L1) ----------
  console.log('\n--- Sepolia (L1) ---')
  {
    const p = await probeProfileL1(providers.L1, A.CawProfile, [eid.L1, eid.L2, eid.L2b])
    console.log('CawProfile          ', A.CawProfile)
    console.log('  owner          :', fmt(p.owner))
    console.log('  endpoint       :', p.endpoint)
    console.log('  delegate       :', p.delegate)
    console.log('  minter         :', fmt(p.minter),       '   →', p.minter === ZERO_ADDR ? 'setMinter UNFILLED'       : 'setMinter consumed')
    console.log('  uriGenerator   :', fmt(p.uri),          '   →', p.uri === ZERO_ADDR    ? 'setUriGenerator UNFILLED' : 'setUriGenerator consumed')
    for (const e of [eid.L1, eid.L2, eid.L2b]) {
      console.log(`  peers(${e})    :`, fmtPeer(p.peers[e]),
        '   →', p.peers[e] === ZERO_BYTES ? `setPeer(${e}) UNFILLED` : `setPeer(${e}) consumed`)
    }
    row('Sepolia', 'CawProfile', A.CawProfile, p.owner, { delegate: p.delegate })
  }
  {
    // CawProfileL2_L1 is co-deployed on Sepolia with bypassLZ=true.
    const p = await probeProfileL2(providers.L1, A.CawProfileL2_L1, [eid.L1])
    console.log('CawProfileL2_L1     ', A.CawProfileL2_L1)
    console.log('  owner          :', fmt(p.owner))
    console.log('  endpoint       :', p.endpoint)
    console.log('  delegate       :', p.delegate)
    console.log('  bypassLZ       :', p.bypassLZ)
    console.log('  cawProfile     :', fmt(p.cawProfile),   '   →', p.cawProfile === ZERO_ADDR ? 'setL1Peer UNFILLED'    : 'setL1Peer consumed')
    console.log('  cawActions     :', fmt(p.cawActions),   '   →', p.cawActions === ZERO_ADDR ? 'setCawActions UNFILLED': 'setCawActions consumed')
    row('Sepolia', 'CawProfileL2_L1', A.CawProfileL2_L1, p.owner, { delegate: p.delegate })
  }
  {
    // CawActions is plain Ownable, no LZ surface.
    const p = await probeOwnableOnly(providers.L1, A.CawActions_L1)
    console.log('CawActions_L1       ', A.CawActions_L1, '(plain Ownable, no LZ surface)')
    console.log('  owner          :', fmt(p.owner))
    row('Sepolia', 'CawActions_L1', A.CawActions_L1, p.owner, { delegate: 'n/a (no LZ)' })
  }

  // ---------- Base Sepolia (L2) ----------
  console.log('\n--- Base Sepolia (L2) ---')
  {
    const p = await probeProfileL2(providers.L2, A.CawProfileL2_L2, [eid.L1])
    console.log('CawProfileL2_L2     ', A.CawProfileL2_L2)
    console.log('  owner          :', fmt(p.owner))
    console.log('  endpoint       :', p.endpoint)
    console.log('  delegate       :', p.delegate)
    console.log('  bypassLZ       :', p.bypassLZ)
    console.log('  cawProfile     :', fmt(p.cawProfile))
    console.log('  cawActions     :', fmt(p.cawActions),   '   →', p.cawActions === ZERO_ADDR ? 'setCawActions UNFILLED': 'setCawActions consumed')
    console.log(`  peers(${eid.L1})  :`, fmtPeer(p.peers[eid.L1]),
      '   →', p.peers[eid.L1] === ZERO_BYTES ? `setPeer(${eid.L1}) UNFILLED (L1 peer not set)` : `setPeer(${eid.L1}) consumed`)
    row('Base Sep', 'CawProfileL2_L2', A.CawProfileL2_L2, p.owner, { delegate: p.delegate })
  }
  {
    const p = await probeOwnableOnly(providers.L2, A.CawActions_L2)
    console.log('CawActions_L2       ', A.CawActions_L2, '(plain Ownable, no LZ surface)')
    console.log('  owner          :', fmt(p.owner))
    row('Base Sep', 'CawActions_L2', A.CawActions_L2, p.owner, { delegate: 'n/a (no LZ)' })
  }
  {
    const p = await probeOApp(providers.L2, A.CawActionsArchive_L2, [eid.L1, eid.L2, eid.L2b])
    console.log('CawActionsArchive_L2', A.CawActionsArchive_L2)
    console.log('  owner          :', fmt(p.owner))
    console.log('  endpoint       :', p.endpoint)
    console.log('  delegate       :', p.delegate)
    for (const e of [eid.L1, eid.L2, eid.L2b]) {
      console.log(`  peers(${e})    :`, fmtPeer(p.peers[e]))
    }
    row('Base Sep', 'CawActionsArchive_L2', A.CawActionsArchive_L2, p.owner, { delegate: p.delegate })
  }
  {
    const p = await probeOApp(providers.L2, A.CawChallengeRelay_L2, [eid.L1, eid.L2, eid.L2b])
    console.log('CawChallengeRelay_L2', A.CawChallengeRelay_L2)
    console.log('  owner          :', fmt(p.owner))
    console.log('  endpoint       :', p.endpoint)
    console.log('  delegate       :', p.delegate)
    for (const e of [eid.L1, eid.L2, eid.L2b]) {
      console.log(`  peers(${e})    :`, fmtPeer(p.peers[e]))
    }
    row('Base Sep', 'CawChallengeRelay_L2', A.CawChallengeRelay_L2, p.owner, { delegate: p.delegate })
  }

  // ---------- Arbitrum Sepolia (L2b) ----------
  console.log('\n--- Arbitrum Sepolia (L2b) ---')
  {
    const p = await probeProfileL2(providers.L2b, A.CawProfileL2_L2b, [eid.L1])
    console.log('CawProfileL2_L2b    ', A.CawProfileL2_L2b)
    console.log('  owner          :', fmt(p.owner))
    console.log('  endpoint       :', p.endpoint)
    console.log('  delegate       :', p.delegate)
    console.log('  bypassLZ       :', p.bypassLZ)
    console.log('  cawProfile     :', fmt(p.cawProfile))
    console.log('  cawActions     :', fmt(p.cawActions),   '   →', p.cawActions === ZERO_ADDR ? 'setCawActions UNFILLED': 'setCawActions consumed')
    console.log(`  peers(${eid.L1})  :`, fmtPeer(p.peers[eid.L1]),
      '   →', p.peers[eid.L1] === ZERO_BYTES ? `setPeer(${eid.L1}) UNFILLED (L1 peer not set)` : `setPeer(${eid.L1}) consumed`)
    row('Arb Sep', 'CawProfileL2_L2b', A.CawProfileL2_L2b, p.owner, { delegate: p.delegate })
  }
  {
    const p = await probeOwnableOnly(providers.L2b, A.CawActions_L2b)
    console.log('CawActions_L2b      ', A.CawActions_L2b, '(plain Ownable, no LZ surface)')
    console.log('  owner          :', fmt(p.owner))
    row('Arb Sep', 'CawActions_L2b', A.CawActions_L2b, p.owner, { delegate: 'n/a (no LZ)' })
  }
  {
    const p = await probeOApp(providers.L2b, A.CawActionsArchive_L2b, [eid.L1, eid.L2, eid.L2b])
    console.log('CawActionsArchive_L2b', A.CawActionsArchive_L2b)
    console.log('  owner          :', fmt(p.owner))
    console.log('  endpoint       :', p.endpoint)
    console.log('  delegate       :', p.delegate)
    for (const e of [eid.L1, eid.L2, eid.L2b]) {
      console.log(`  peers(${e})    :`, fmtPeer(p.peers[e]))
    }
    row('Arb Sep', 'CawActionsArchive_L2b', A.CawActionsArchive_L2b, p.owner, { delegate: p.delegate })
  }
  {
    const p = await probeOApp(providers.L2b, A.CawChallengeRelay_L2b, [eid.L1, eid.L2, eid.L2b])
    console.log('CawChallengeRelay_L2b', A.CawChallengeRelay_L2b)
    console.log('  owner          :', fmt(p.owner))
    console.log('  endpoint       :', p.endpoint)
    console.log('  delegate       :', p.delegate)
    for (const e of [eid.L1, eid.L2, eid.L2b]) {
      console.log(`  peers(${e})    :`, fmtPeer(p.peers[e]))
    }
    row('Arb Sep', 'CawChallengeRelay_L2b', A.CawChallengeRelay_L2b, p.owner, { delegate: p.delegate })
  }

  // Summary table
  console.log('\n' + '='.repeat(78))
  console.log('SUMMARY')
  console.log('='.repeat(78))
  console.log(pad('Network', 10), pad('Contract', 24), pad('Owner', 10), pad('Delegate', 44))
  console.log('-'.repeat(78))
  for (const r of lines) {
    console.log(pad(r.network, 10), pad(r.contract, 24), pad(r.owner, 10), pad(r.delegate || '-', 44))
  }

  // Drop providers so node exits without the JsonRpcProvider keep-alive
  // poller looping forever after main() returns.
  for (const p of Object.values(providers)) p.destroy?.()
}

main().catch(err => { console.error(err); process.exit(1) })
