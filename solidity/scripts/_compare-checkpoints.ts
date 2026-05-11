import 'dotenv/config'
import { JsonRpcProvider, Contract, AbiCoder, Interface } from 'ethers'
import { cawActionsAbi } from '../src/abi/generated'
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_REPLICATOR_L2_ADDRESS } from '../src/abi/addresses'

const ACTION_TUPLE = 'tuple(uint8 actionType, uint32 senderId, uint32 receiverId, uint32 receiverCawonce, uint32 networkId, uint32 cawonce, uint32[] recipients, uint64[] amounts, bytes text)'

async function main() {
  const p = new JsonRpcProvider(process.env.L2_RPC_URL)
  const iface = new Interface(cawActionsAbi as any)
  const c = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi as any, p)

  // Get all events
  const events = await c.queryFilter(c.filters.ActionsProcessed(), 40241500)
  console.log(`Found ${events.length} ActionsProcessed events\n`)

  // Decode all actions
  const allActions: any[] = []
  for (const ev of events) {
    const tx = await p.getTransaction(ev.transactionHash)
    if (!tx) continue
    const decoded = iface.decodeFunctionData('processActions', tx.data)
    const multiData = decoded[1]
    for (let i = 0; i < multiData.actions.length; i++) {
      const a = multiData.actions[i]
      if (Number(a.networkId) !== 1) continue
      allActions.push(a)
    }
  }
  console.log(`Total network-1 actions: ${allActions.length}\n`)

  const coder = new AbiCoder()
  for (let cp = 1; cp <= 7; cp++) {
    const start = (cp - 1) * 128
    const end = cp * 128
    if (end > allActions.length) { console.log(`checkpoint ${cp}: not enough actions`); continue }
    const cpActions = allActions.slice(start, end)
    const r = new Array(128).fill('0x' + '00'.repeat(32)) // dummy r for size calc

    const payload = coder.encode([`${ACTION_TUPLE}[]`, 'bytes32[]'], [cpActions, r])
    const payloadBytes = (payload.length - 2) / 2

    // Total text bytes
    let totalText = 0
    for (const a of cpActions) {
      const hex = String(a.text)
      totalText += hex === '0x' ? 0 : (hex.length - 2) / 2
    }

    // Estimate LOG gas: 375 base + 8 per byte of data + 375 per topic
    const logGas = 375 + 8 * payloadBytes + 375 * 3 // 3 indexed topics in ActionsArchived

    console.log(`checkpoint ${cp}: payload=${payloadBytes} bytes (${(payloadBytes/1024).toFixed(1)}KB), textBytes=${totalText}, est. LOG gas=${logGas.toLocaleString()}`)
  }
}
main().catch(console.error)
