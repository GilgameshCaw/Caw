// Debug the hash chain for a specific checkpoint.
// Fetches networkCurrentHash progressively + compares each step of our local
// recomputation against what's actually stored on-chain for Networks that
// have indexed but not processed the chain (if available).

import 'dotenv/config'
import { JsonRpcProvider, Contract, AbiCoder, keccak256, solidityPacked, Interface } from 'ethers'
import {
  CAW_ACTIONS_ADDRESS,
} from '../src/abi/addresses'
import { cawActionsAbi } from '../src/abi/generated'

const HASH_ABI = [
  'function networkCurrentHash(uint32) view returns (bytes32)',
  'function networkActionCount(uint32) view returns (uint256)',
  'function networkHashAtCheckpoint(uint32, uint256) view returns (bytes32)',
]

const CLIENT_ID = 1
const CHECKPOINT = 3
const ACTION_TUPLE = 'tuple(uint8 actionType, uint32 senderId, uint32 receiverId, uint32 receiverCawonce, uint32 networkId, uint32 cawonce, uint32[] recipients, uint64[] amounts, bytes text)'

async function main() {
  const rpc = process.env.L2_RPC_URL_HTTP || process.env.L2_RPC_URL || 'https://sepolia.base.org'
  const provider = new JsonRpcProvider(rpc.replace(/^wss:/, 'https:').replace('/ws/', '/'))
  const view = new Contract(CAW_ACTIONS_ADDRESS, HASH_ABI, provider)

  console.log(`\n== On-chain state ==`)
  const currentCount = await view.networkActionCount(CLIENT_ID)
  const currentHash = await view.networkCurrentHash(CLIENT_ID)
  console.log(`   networkActionCount(${CLIENT_ID}):     ${currentCount}`)
  console.log(`   networkCurrentHash(${CLIENT_ID}):     ${currentHash}`)
  console.log(`   checkpoint ${CHECKPOINT - 1} hash:          ${await view.networkHashAtCheckpoint(CLIENT_ID, CHECKPOINT - 1)}`)
  const cpHash = await view.networkHashAtCheckpoint(CLIENT_ID, CHECKPOINT)
  console.log(`   checkpoint ${CHECKPOINT} hash:              ${cpHash}`)
  if (cpHash === '0x' + '00'.repeat(32)) {
    console.log(`   (checkpoint ${CHECKPOINT} not yet reached)`)
  }

  // Now scan ActionsProcessed events for checkpoint 3 and walk the chain
  console.log(`\n== Reconstructing checkpoint ${CHECKPOINT} from events ==`)
  const eventFilter = {
    address: CAW_ACTIONS_ADDRESS,
    topics: [
      '0x' + keccak256(Buffer.from('ActionsProcessed(uint32,uint256,tuple(uint8,uint32,uint32,uint32,uint32,uint32,uint32[],uint64[],bytes)[],uint8[],bytes32[],bytes32[],uint32[],string[])')).slice(2, 66)
    ],
  }

  // The event topic hash won't match an arbitrary encoding — use the iface instead.
  const iface = new Interface(cawActionsAbi)

  // Find last 50k blocks of ActionsProcessed events
  const latest = await provider.getBlockNumber()
  const fromBlock = latest - 50_000
  console.log(`   scanning blocks ${fromBlock} → ${latest}`)

  const contract = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi as any, provider)
  const events = await contract.queryFilter(contract.filters.ActionsProcessed(), fromBlock, latest)
  console.log(`   found ${events.length} ActionsProcessed events`)

  // Rebuild orderedEntries the same way the validator does
  type Entry = { blockNumber: number; txIndex: number; pos: number; action: any; r: string }
  const entries: Entry[] = []
  for (const ev of events) {
    const tx = await provider.getTransaction(ev.transactionHash)
    if (!tx) continue
    const decoded = iface.decodeFunctionData('processActions', tx.data)
    const multiData = decoded[1]
    for (let i = 0; i < multiData.actions.length; i++) {
      const a = multiData.actions[i]
      if (Number(a.networkId) !== CLIENT_ID) continue
      entries.push({
        blockNumber: tx.blockNumber!,
        txIndex: tx.index!,
        pos: i,
        action: a,
        r: multiData.r[i],
      })
    }
  }
  entries.sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.pos - b.pos)
  console.log(`   total actions for client ${CLIENT_ID}: ${entries.length}`)

  // Walk the chain from checkpoint N-1 to N
  const startIdx = (CHECKPOINT - 1) * 128
  const endIdx = CHECKPOINT * 128
  if (entries.length < endIdx) {
    console.log(`   ✗ Not enough actions reconstructed (have ${entries.length}, need ${endIdx})`)
    return
  }
  const checkpointEntries = entries.slice(startIdx, endIdx)
  console.log(`   checkpoint ${CHECKPOINT} actions: [${startIdx}..${endIdx}), cawonces: ${checkpointEntries[0].action.cawonce}..${checkpointEntries[checkpointEntries.length - 1].action.cawonce}`)

  const coder = new AbiCoder()
  let hash: string = CHECKPOINT === 1
    ? '0x' + '00'.repeat(32)
    : await view.networkHashAtCheckpoint(CLIENT_ID, CHECKPOINT - 1)

  console.log(`\n   seed hash: ${hash}`)
  for (let i = 0; i < 128; i++) {
    const e = checkpointEntries[i]
    const cloned = {
      actionType: Number(e.action.actionType),
      senderId: Number(e.action.senderId),
      receiverId: Number(e.action.receiverId),
      receiverCawonce: Number(e.action.receiverCawonce),
      networkId: Number(e.action.networkId),
      cawonce: Number(e.action.cawonce),
      recipients: Array.from(e.action.recipients).map(Number),
      amounts: Array.from(e.action.amounts).map((x: any) => BigInt(x)),
      text: e.action.text,
    }
    const actionHash = keccak256(coder.encode([ACTION_TUPLE], [cloned]))
    hash = keccak256(solidityPacked(['bytes32', 'bytes32', 'bytes32'], [hash, e.r, actionHash]))
    if (i < 3 || i === 127) {
      console.log(`   step ${i}: cawonce=${cloned.cawonce} textLen=${String(cloned.text).length} actionHash=${actionHash.slice(0, 18)}… → chain=${hash.slice(0, 18)}…`)
    }
  }

  console.log(`\n   locally computed final: ${hash}`)
  console.log(`   on-chain checkpoint ${CHECKPOINT} hash: ${cpHash}`)
  console.log(`   match: ${hash === cpHash ? '✓' : '✗'}`)

  if (hash !== cpHash) {
    // Walk the chain once more but this time compare each step to networkCurrentHash
    // at the time that action was processed. We need to find the block where
    // cumulative action count reached N for each step.
    console.log(`\n   Looking for the first divergent step by comparing against clientCurrentHash at historical blocks…`)
    // This would require eth_call with blockTag for each step. Simpler: pick a
    // specific step and compare the action body encoding.
    const testIdx = 0
    const e = checkpointEntries[testIdx]
    console.log(`\n   Action ${testIdx + startIdx} (cawonce=${e.action.cawonce}) raw:`)
    console.log(`     actionType: ${e.action.actionType} (BN: ${typeof e.action.actionType})`)
    console.log(`     senderId:   ${e.action.senderId}`)
    console.log(`     cawonce:    ${e.action.cawonce}`)
    console.log(`     text (hex head): ${String(e.action.text).slice(0, 60)}…`)
    console.log(`     text type: ${typeof e.action.text}`)
    console.log(`     text length: ${String(e.action.text).length}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
