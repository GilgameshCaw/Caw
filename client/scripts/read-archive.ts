// Pull all archived checkpoints from CawActionsArchive on Arbitrum Sepolia
// (L2b) and decode them back into actions. The archive just re-emits the raw
// LZ payload via `ActionsArchived(srcEid, guid, data)`, so reconstructing
// means scanning its event log and ABI-decoding the payload.
//
// Usage:
//   cd client && npx tsx scripts/read-archive.ts [--fromBlock N] [--toBlock latest]
//
// Output: prints one line per checkpoint with action counts, and (with --verbose)
// dumps the full action list.

import 'dotenv/config'
import { JsonRpcProvider, Contract, AbiCoder, Interface } from 'ethers'
import SmlTxt from 'smltxt'
import { CAW_ACTIONS_ARCHIVE_L2B_ADDRESS } from '../src/abi/addresses'

const ARCHIVE_EVENT_ABI = [
  'event ActionsArchived(uint32 indexed sourceChainId, bytes32 indexed guid, bytes data)'
]

// Payload shapes across deployments:
//   Pre-smltxt legacy:       abi.encode(actions[text=string], v, r, s)
//   Option-C pre-smltxt:     abi.encode(actions[text=string], r)
//   Option-C + smltxt:       abi.encode(actions[text=bytes],  r)
// Try the newest first, fall back.
const ACTION_TUPLE_BYTES =
  'tuple(uint8 actionType, uint32 senderId, uint32 receiverId, uint32 receiverCawonce, ' +
  'uint32 clientId, uint32 cawonce, uint32[] recipients, uint64[] amounts, bytes text)[]'
const ACTION_TUPLE_STRING =
  'tuple(uint8 actionType, uint32 senderId, uint32 receiverId, uint32 receiverCawonce, ' +
  'uint32 clientId, uint32 cawonce, uint32[] recipients, uint64[] amounts, string text)[]'

let _smltxt: SmlTxt | undefined
function smltxt() { return _smltxt ??= SmlTxt.fromPkg() }

/** Hex 0x… → plaintext via smltxt; returns '' on empty or decode failure. */
function decompressHex(hex: string): string {
  if (!hex || hex === '0x') return ''
  try {
    const bytes = new Uint8Array(
      (hex.startsWith('0x') ? hex.slice(2) : hex).match(/.{1,2}/g)!.map(b => parseInt(b, 16))
    )
    return smltxt().decompress(bytes)
  } catch { return '' }
}

type Shape = 'option-c+smltxt' | 'option-c+string' | 'legacy'
function tryDecode(payload: string):
  { actions: any[]; r: string[]; v?: number[]; s?: string[]; shape: Shape } | null {
  const coder = new AbiCoder()
  // Shape 1: Option-C + smltxt (bytes text, no v/s)
  try {
    const [actions, r] = coder.decode([ACTION_TUPLE_BYTES, 'bytes32[]'], payload)
    return { actions: Array.from(actions), r: Array.from(r), shape: 'option-c+smltxt' }
  } catch { /* fall through */ }
  // Shape 2: Option-C pre-smltxt (string text, no v/s)
  try {
    const [actions, r] = coder.decode([ACTION_TUPLE_STRING, 'bytes32[]'], payload)
    return { actions: Array.from(actions), r: Array.from(r), shape: 'option-c+string' }
  } catch { /* fall through */ }
  // Shape 3: legacy (string text, with v/s)
  try {
    const [actions, v, r, s] = coder.decode(
      [ACTION_TUPLE_STRING, 'uint8[]', 'bytes32[]', 'bytes32[]'],
      payload
    )
    return {
      actions: Array.from(actions),
      v: Array.from(v).map((x: any) => Number(x)),
      r: Array.from(r),
      s: Array.from(s),
      shape: 'legacy',
    }
  } catch { /* fall through */ }
  return null
}

async function main() {
  const verbose = process.argv.includes('--verbose')
  const fromBlockArg = process.argv.find(a => a.startsWith('--fromBlock='))
  const toBlockArg = process.argv.find(a => a.startsWith('--toBlock='))

  const rpcUrl = process.env.RPC_ARBITRUM_SEPOLIA
    || process.env.L2B_RPC_URL
    || 'https://sepolia-rollup.arbitrum.io/rpc'
  const provider = new JsonRpcProvider(rpcUrl)
  const contract = new Contract(CAW_ACTIONS_ARCHIVE_L2B_ADDRESS, ARCHIVE_EVENT_ABI, provider)

  const latest = await provider.getBlockNumber()
  const fromBlock = fromBlockArg ? parseInt(fromBlockArg.split('=')[1]) : Math.max(0, latest - 500_000)
  const toBlock = toBlockArg ? parseInt(toBlockArg.split('=')[1]) : latest

  console.log(`Scanning ${CAW_ACTIONS_ARCHIVE_L2B_ADDRESS} (Arbitrum Sepolia)`)
  console.log(`Block range: ${fromBlock} → ${toBlock}`)

  const iface = new Interface(ARCHIVE_EVENT_ABI)
  const events: any[] = []
  const CHUNK = 10_000
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock)
    try {
      const batch = await contract.queryFilter(contract.filters.ActionsArchived(), start, end)
      events.push(...batch)
    } catch (err: any) {
      console.warn(`  chunk [${start}..${end}] failed: ${err?.shortMessage || err?.message}`)
    }
  }
  console.log(`Found ${events.length} ActionsArchived event(s)\n`)

  for (const ev of events) {
    const args: any = (ev as any).args ?? iface.parseLog(ev as any)?.args
    const srcEid = Number(args.sourceChainId)
    const guid: string = args.guid
    const payload: string = args.data

    const decoded = tryDecode(payload)
    if (!decoded) {
      console.log(`tx=${ev.transactionHash} block=${ev.blockNumber} srcEid=${srcEid} — DECODE FAILED (payload ${payload.length - 2} hex chars)`)
      continue
    }

    console.log(
      `tx=${ev.transactionHash} block=${ev.blockNumber} srcEid=${srcEid} ` +
      `actions=${decoded.actions.length} shape=${decoded.shape} guid=${guid.slice(0, 12)}…`
    )

    if (verbose) {
      for (let i = 0; i < decoded.actions.length; i++) {
        const a = decoded.actions[i]
        // For smltxt payloads `a.text` is 0x-hex; decompress to show plaintext.
        // For legacy string payloads it's already plaintext.
        const plaintext = decoded.shape.includes('smltxt')
          ? decompressHex(String(a.text))
          : String(a.text)
        const preview = plaintext.slice(0, 80)
        console.log(
          `  [${i}] type=${a.actionType} sender=${a.senderId} ` +
          `cawonce=${a.cawonce} client=${a.clientId} ` +
          `text=${JSON.stringify(preview)}${plaintext.length > 80 ? '…' : ''}`
        )
      }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
