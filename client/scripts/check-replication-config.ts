// Quick read-only check of replication enrollment state.
// Usage: npx tsx client/scripts/check-replication-config.ts

import { JsonRpcProvider, Contract } from 'ethers'
import 'dotenv/config'

// Read addresses directly from the addresses.ts so this script stays in sync
// with whatever the deploy script wrote.
import {
  CAW_ACTIONS_REPLICATOR_L2_ADDRESS,
  CLIENT_MANAGER_ADDRESS,
  CAW_NAMES_L2_ADDRESS,
  CAW_NAMES_ADDRESS as CAW_NAMES_L1,
} from '../src/abi/addresses'

const CLIENT_ID = 1
const DEST_EID = 40231 // Arbitrum Sepolia per LZ v2

const replicatorAbi = [
  'function clientChainEnabled(uint32, uint32) view returns (bool)',
  'function clientChains(uint32, uint256) view returns (uint32)',
  'function isAvailableChain(uint32) view returns (bool)',
  'function clientReplicationEnabled(uint32) view returns (bool)',
  'function cawNameL2() view returns (address)',
]

const clientManagerAbi = [
  'function getClientChainEids(uint32) view returns (uint32[])',
  'function getClientOwner(uint32) view returns (address)',
  'function clients(uint32) view returns (address owner, uint32 storageChainEid, uint32 instanceId, uint8 clientType)',
  'function clientReplicationEnabled(uint32) view returns (bool)',
  'function getReplications(uint32) view returns (tuple(address target, uint32 eid)[])',
  'function cawName() view returns (address)',
  'event ClientReplicationAdded(uint32 indexed clientId, uint32 indexed eid, address target)',
]

const cawNameOAppAbi = [
  'function peers(uint32) view returns (bytes32)',
  'function mainnetLzId() view returns (uint32)',
]

async function main() {
  const l2Http = process.env.L2_RPC_URL_HTTP
  const l1Http = (process.env.L1_RPC_URL || '').replace(/^wss:/, 'https:').replace('/ws/', '/')
  if (!l2Http) throw new Error('Missing L2_RPC_URL_HTTP')
  if (!l1Http) throw new Error('Missing L1 RPC (derived from L1_RPC_URL)')

  const l2 = new JsonRpcProvider(l2Http)
  const l1 = new JsonRpcProvider(l1Http)

  const replicator = new Contract(CAW_ACTIONS_REPLICATOR_L2_ADDRESS, replicatorAbi, l2)
  const clientManager = new Contract(CLIENT_MANAGER_ADDRESS, clientManagerAbi, l1)

  console.log(`\n== L2 CawActionsReplicator @ ${CAW_ACTIONS_REPLICATOR_L2_ADDRESS} ==`)
  console.log(`   (Base Sepolia)`)

  const cawNameL2Ref = await replicator.cawNameL2()
  console.log(`   cawNameL2 (only authorised caller): ${cawNameL2Ref}`)
  console.log(`   expected CawNameL2 address:         ${CAW_NAMES_L2_ADDRESS}`)
  console.log(`   match: ${cawNameL2Ref.toLowerCase() === CAW_NAMES_L2_ADDRESS.toLowerCase() ? '✓' : '✗'}`)

  const isAvailable = await replicator.isAvailableChain(DEST_EID)
  console.log(`\n   isAvailableChain(${DEST_EID}): ${isAvailable}`)

  const isEnabled = await replicator.clientChainEnabled(CLIENT_ID, DEST_EID)
  console.log(`   clientChainEnabled(${CLIENT_ID}, ${DEST_EID}): ${isEnabled}  ← this is the revert`)

  const clientReplOn = await replicator.clientReplicationEnabled(CLIENT_ID)
  console.log(`   clientReplicationEnabled(${CLIENT_ID}): ${clientReplOn}`)

  console.log(`\n   clientChains(${CLIENT_ID}, …):`)
  const chains: number[] = []
  for (let i = 0; i < 10; i++) {
    try {
      const e = await replicator.clientChains(CLIENT_ID, i)
      chains.push(Number(e))
    } catch {
      break
    }
  }
  if (chains.length === 0) console.log(`     (empty — client has no enrolled chains on L2)`)
  else chains.forEach((e, i) => console.log(`     [${i}] ${e}`))

  console.log(`\n== L1 CawClientManager @ ${CLIENT_MANAGER_ADDRESS} ==`)
  console.log(`   (Ethereum Sepolia)`)

  try {
    const owner = await clientManager.getClientOwner(CLIENT_ID)
    console.log(`   getClientOwner(${CLIENT_ID}): ${owner}`)
  } catch (e: any) {
    console.log(`   getClientOwner(${CLIENT_ID}) reverted: ${e?.shortMessage || e?.message}`)
  }

  try {
    const eids = await clientManager.getClientChainEids(CLIENT_ID)
    console.log(`   getClientChainEids(${CLIENT_ID}): [${eids.map(String).join(', ')}]`)
    const includesTarget = eids.some((e: any) => Number(e) === DEST_EID)
    console.log(`   includes ${DEST_EID}? ${includesTarget ? '✓' : '✗'}`)
  } catch (e: any) {
    console.log(`   getClientChainEids(${CLIENT_ID}) reverted: ${e?.shortMessage || e?.message}`)
  }

  try {
    const client = await clientManager.clients(CLIENT_ID)
    console.log(`   clients(${CLIENT_ID}).storageChainEid: ${Number(client.storageChainEid)}`)
    console.log(`   (This is the LZ destination that addReplication auto-syncs to.)`)
  } catch (e: any) {
    console.log(`   clients(${CLIENT_ID}) reverted: ${e?.shortMessage || e?.message}`)
  }

  // Look for the ClientReplicationAdded event history to see when/if it fired.
  console.log(`\n== ClientReplicationAdded events on L1 ==`)
  try {
    const filter = clientManager.filters.ClientReplicationAdded(CLIENT_ID)
    // Look back ~200k blocks (Sepolia block time ~12s → ~27 days)
    const latest = await l1.getBlockNumber()
    const fromBlock = Math.max(0, latest - 200_000)
    const events = await clientManager.queryFilter(filter, fromBlock, latest)
    if (events.length === 0) {
      console.log(`   No ClientReplicationAdded(clientId=${CLIENT_ID}) events in last ${latest - fromBlock} blocks`)
    } else {
      for (const ev of events) {
        const e = ev as any
        console.log(`   block ${e.blockNumber} tx ${e.transactionHash}`)
        console.log(`     eid=${e.args?.eid} target=${e.args?.target}`)
        // Check whether an LZ fee was paid (i.e. the sync message was sent)
        const tx = await l1.getTransaction(e.transactionHash)
        const receipt = await l1.getTransactionReceipt(e.transactionHash)
        console.log(`     tx.value (LZ fee sent with addReplication): ${tx?.value ?? 'n/a'} wei`)
        console.log(`     status: ${receipt?.status === 1 ? 'success' : 'failed'}`)
      }
    }
  } catch (e: any) {
    console.log(`   Failed to query events: ${e?.message}`)
  }

  // Verify the L1 clientManager.cawName() matches the configured CawName
  console.log(`\n== L1 clientManager.cawName() vs. configured CAW_NAMES_ADDRESS ==`)
  try {
    const cm_cawName = await clientManager.cawName()
    console.log(`   clientManager.cawName():        ${cm_cawName}`)
    console.log(`   configured CAW_NAMES_ADDRESS:   ${CAW_NAMES_L1}`)
    console.log(`   match: ${cm_cawName.toLowerCase() === CAW_NAMES_L1.toLowerCase() ? '✓' : '✗ ← LZ syncs go via a stale CawName contract'}`)
  } catch (e: any) {
    console.log(`   cawName() reverted: ${e?.shortMessage || e?.message}`)
  }

  // Verify the L2 CawNameL2 peer is whatever sent the LZ message the scan API reported.
  // LZ scan showed receiver 0xb43c3c5809bc9c82bc8f20b03b2d0dd12386d1e2 on base-sepolia,
  // which should equal our CAW_NAMES_L2_ADDRESS if configuration is correct.
  console.log(`\n== LayerZero peer sanity ==`)
  console.log(`   LZ scan showed destination receiver: 0xb43c3c5809bc9c82bc8f20b03b2d0dd12386d1e2`)
  console.log(`   configured CAW_NAMES_L2_ADDRESS:     ${CAW_NAMES_L2_ADDRESS}`)
  const receiverMatch = '0xb43c3c5809bc9c82bc8f20b03b2d0dd12386d1e2' === CAW_NAMES_L2_ADDRESS.toLowerCase()
  console.log(`   match: ${receiverMatch ? '✓' : '✗ ← LZ messages are being delivered to a DIFFERENT CawNameL2'}`)

  // Check the CURRENT CawName's LZ peer for Base Sepolia.
  console.log(`\n== Current CawName LZ peer for Base Sepolia (40245) ==`)
  const BASE_SEPOLIA_EID = 40245
  try {
    const currentCawName = new Contract(CAW_NAMES_L1, cawNameOAppAbi, l1)
    const peerBytes = await currentCawName.peers(BASE_SEPOLIA_EID)
    // peer is left-padded bytes32 of the address
    const peerAddress = '0x' + peerBytes.slice(26)
    console.log(`   CawName(${CAW_NAMES_L1}).peers(${BASE_SEPOLIA_EID}): ${peerAddress}`)
    console.log(`   configured CAW_NAMES_L2_ADDRESS:                   ${CAW_NAMES_L2_ADDRESS}`)
    const ok = peerAddress.toLowerCase() === CAW_NAMES_L2_ADDRESS.toLowerCase()
    console.log(`   match: ${ok ? '✓ (sync via current CawName should land on current CawNameL2)' : '✗ (current CawName also points at the wrong L2)'}`)
  } catch (e: any) {
    console.log(`   peers() query failed: ${e?.shortMessage || e?.message}`)
  }

  console.log(`\n== Diagnosis ==`)
  if (!isAvailable) {
    console.log(`✗ ${DEST_EID} is not an available chain on the L2 replicator.`)
    console.log(`   Admin must call CawActionsReplicator.registerChain(…) on L2 first.`)
  } else if (!isEnabled) {
    console.log(`✗ Client ${CLIENT_ID} is not enrolled for destination ${DEST_EID} on L2.`)
    console.log(`   Fix: client owner calls CawName.syncReplication(${CLIENT_ID}, <BASE_SEPOLIA_LZ_EID>, 0)`)
    console.log(`        on L1 with enough ETH for LZ fees. After the LZ message lands on L2,`)
    console.log(`        clientChainEnabled(${CLIENT_ID}, ${DEST_EID}) will flip to true.`)
  } else {
    console.log(`✓ Replication enrollment looks correct for client ${CLIENT_ID} → ${DEST_EID}.`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
