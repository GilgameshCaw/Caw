#!/usr/bin/env node
/**
 * Create a second CawClient on the already-deployed CawClientManager.
 *
 * Use case: spin up a test environment with its own clientId so you can
 * drop the database and re-index from a clean slate without seeing actions
 * from the production/dev client. See client/src/services/RawEventsGatherer
 * — actions are filtered to a single clientId, so each client gets a
 * disjoint history.
 *
 * Usage:
 *   PRIVATE_KEYS=<deployerKey> node scripts/create-test-client.js [--name "..."]
 *
 * Env:
 *   PRIVATE_KEYS    Comma-separated; first key is used (must be the deployer
 *                   that owns the existing client / has ETH on local L1)
 *   RPC_DEV_L1      L1 RPC URL (default http://localhost:8545)
 *
 * Defaults — same as the first client, only `name` differs:
 *   feeAddress         deployer
 *   storageChainEid    40161 (devL2)
 *   withdrawFee        0.0015 ETH
 *   depositFee         0.0015 ETH
 *   authFee            0.0015 ETH
 *   mintFee            0.0015 ETH
 */

const { ethers } = require('ethers')
const fs = require('fs')
const path = require('path')

// Parameters mirror the first client (deploy.js phase 2 createClient step).
const CLIENT_MANAGER_ADDRESS = '0x4524922C4614DBbb79FCcdce6d2c41CaF563FE04'
const STORAGE_CHAIN_EID = 40161 // devL2 from deploy.js
const FEE_WEI = '1500000000000000' // 0.0015 ETH per fee — same as client 1
const ARTIFACT_PATH = path.join(
  __dirname,
  '../artifacts/contracts/CawClientManager.sol/CawClientManager.json',
)

function parseArgs(argv) {
  const out = { name: 'CAW Test Client' }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--name') out.name = argv[++i]
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv)
  const rpc = process.env.RPC_DEV_L1 || 'http://localhost:8545'
  const keys = (process.env.PRIVATE_KEYS || '').split(',').filter(Boolean)
  if (keys.length === 0) {
    throw new Error('PRIVATE_KEYS env var required (comma-separated; first key is used)')
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'))
  const provider = new ethers.JsonRpcProvider(rpc)
  const wallet = new ethers.Wallet(keys[0], provider)
  const manager = new ethers.Contract(CLIENT_MANAGER_ADDRESS, artifact.abi, wallet)

  const nextId = await manager.nextClientId()
  const feeAddress = await wallet.getAddress()

  console.log(`Creating client #${nextId} on CawClientManager ${CLIENT_MANAGER_ADDRESS}`)
  console.log(`  name             : ${opts.name}`)
  console.log(`  feeAddress       : ${feeAddress}`)
  console.log(`  storageChainEid  : ${STORAGE_CHAIN_EID}`)
  console.log(`  fees (each)      : ${FEE_WEI} wei`)

  const tx = await manager.createClient(
    opts.name,
    feeAddress,
    STORAGE_CHAIN_EID,
    FEE_WEI, // withdrawFee
    FEE_WEI, // depositFee
    FEE_WEI, // authFee
    FEE_WEI, // mintFee
  )
  console.log(`Submitted tx: ${tx.hash}`)
  const receipt = await tx.wait()
  console.log(`Confirmed in block ${receipt.blockNumber}`)

  // Pull the ClientCreated event for the new id (avoids race vs nextClientId
  // if another tx slipped in between our read and our send).
  const created = receipt.logs
    .map(l => { try { return manager.interface.parseLog(l) } catch { return null } })
    .find(p => p && p.name === 'ClientCreated')
  if (created) {
    const newId = Number(created.args[0])
    console.log(`\nNew clientId: ${newId}`)
    console.log(`Set this in your env to scope the new instance:`)
    console.log(`  Server: CLIENT_ID=${newId}`)
    console.log(`  Frontend: VITE_CLIENT_ID=${newId}`)
  } else {
    console.log('\nClientCreated event not found in receipt — check tx manually.')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
