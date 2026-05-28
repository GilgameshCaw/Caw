#!/usr/bin/env node
/**
 * Create a second CawNetwork on the already-deployed CawNetworkManager.
 *
 * Use case: spin up a test environment with its own networkId so you can
 * drop the database and re-index from a clean slate without seeing actions
 * from the production/dev network. See client/src/services/RawEventsGatherer
 * — actions are filtered to a single networkId, so each network gets a
 * disjoint history.
 *
 * Usage:
 *   node scripts/create-test-network.js [--name "..."]
 *
 * Reads from client/.env (loaded automatically):
 *   L1_RPC_URL_HTTP         L1 (Sepolia) RPC URL
 *   VALIDATOR_PRIVATE_KEY   Wallet that owns the existing network / has ETH
 *
 * Defaults — same as the first network, only `name` differs:
 *   feeAddress         the validator wallet
 *   storageChainEid    40245 (Base Sepolia — same as network 1)
 *   withdrawFee        0.0015 ETH
 *   depositFee         0.0015 ETH
 *   authFee            0.0015 ETH
 *   mintFee            0.0015 ETH
 */

const { ethers } = require('ethers')
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../../client/.env') })

// Parameters mirror the live network 1 (read from chain on Sepolia).
const NETWORK_MANAGER_ADDRESS = '0x4524922C4614DBbb79FCcdce6d2c41CaF563FE04'
const STORAGE_CHAIN_EID = 40245 // Base Sepolia — matches network 1
const FEE_WEI = '1500000000000000' // 0.0015 ETH per fee — same as network 1
const ARTIFACT_PATH = path.join(
  __dirname,
  '../artifacts/contracts/CawNetworkManager.sol/CawNetworkManager.json',
)

function parseArgs(argv) {
  const out = { name: 'CAW Test Network' }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--name') out.name = argv[++i]
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv)
  const rpc = process.env.L1_RPC_URL_HTTP
  const key = process.env.VALIDATOR_PRIVATE_KEY
  if (!rpc) {
    throw new Error('L1_RPC_URL_HTTP missing — expected in client/.env')
  }
  if (!key) {
    throw new Error('VALIDATOR_PRIVATE_KEY missing — expected in client/.env')
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'))
  const provider = new ethers.JsonRpcProvider(rpc)
  const wallet = new ethers.Wallet(key, provider)
  const manager = new ethers.Contract(NETWORK_MANAGER_ADDRESS, artifact.abi, wallet)

  const nextId = await manager.nextNetworkId()
  const feeAddress = await wallet.getAddress()

  console.log(`Creating network #${nextId} on CawNetworkManager ${NETWORK_MANAGER_ADDRESS}`)
  console.log(`  name             : ${opts.name}`)
  console.log(`  feeAddress       : ${feeAddress}`)
  console.log(`  storageChainEid  : ${STORAGE_CHAIN_EID}`)
  console.log(`  fees (each)      : ${FEE_WEI} wei`)

  const tx = await manager.createNetwork(
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

  // Read back the new id from chain. Using `nextNetworkId - 1` is robust even
  // when our local ABI's event signature has drifted from the deployed
  // contract (in which case parseLog on the receipt returns null). It also
  // handles the case where another tx slipped in between our pre-tx read of
  // nextId and our send — we still find *our* network by matching the
  // expected name in a small backwards walk.
  const newNext = await manager.nextNetworkId()
  let newId = Number(newNext) - 1
  // Confirm the network at that id is the one we just created.
  for (let probe = newId; probe >= 1; probe--) {
    const c = await manager.getNetwork(probe)
    if (c.name === opts.name && c.ownerAddress.toLowerCase() === feeAddress.toLowerCase()) {
      newId = probe
      break
    }
  }
  console.log(`\nNew networkId: ${newId}`)
  console.log(`Set this in your env to scope the new instance:`)
  console.log(`  Server: CLIENT_ID=${newId}`)
  console.log(`  Frontend: VITE_CLIENT_ID=${newId}`)
}

main().catch(e => { console.error(e); process.exit(1) })
