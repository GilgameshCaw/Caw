// Diagnose why LZ messages from a given OApp on Base Sepolia to a destination
// chain are stuck "WAITING on DVN". Queries the EndpointV2 for the send-library
// + DVN + executor config of a specific (oapp, dstEid) pair.
//
// Usage:
//   cd client && npx tsx scripts/check-lz-config.ts <oappAddress> <dstEid>
//
// Common dstEids:
//   40161 = Sepolia
//   40231 = Arbitrum Sepolia
//   40245 = Base Sepolia

import 'dotenv/config'
import { JsonRpcProvider, Contract, AbiCoder } from 'ethers'
import {
  CAW_ACTIONS_REPLICATOR_L2_ADDRESS,
  CAW_NAMES_L2_ADDRESS,
} from '../src/abi/addresses'

// Base Sepolia EndpointV2
const BASE_SEPOLIA_ENDPOINT = '0x6EDCE65403992e310A62460808c4b910D972f10f'

const ENDPOINT_ABI = [
  'function getSendLibrary(address oapp, uint32 dstEid) view returns (address lib)',
  'function getReceiveLibrary(address oapp, uint32 srcEid) view returns (address lib, bool isDefault)',
  'function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes config)',
  'function defaultSendLibrary(uint32 eid) view returns (address)',
  'function defaultReceiveLibrary(uint32 eid) view returns (address)',
]

// LZ v2 configType values for UlnConfig
const CONFIG_TYPE_EXECUTOR = 1 // (uint32 maxMessageSize, address executor)
const CONFIG_TYPE_ULN      = 2 // UlnConfig (confirmations, DVN lists, etc.)

const UlnConfigType =
  'tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, ' +
  'uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)'
const ExecutorConfigType = 'tuple(uint32 maxMessageSize, address executor)'

const KNOWN_DVNS_BASE_SEPOLIA: Record<string, string> = {
  '0xe1a12515f9ab2764b887bf60b923ca494ebbb2d6': 'LayerZero Labs',
  '0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193': 'LayerZero Labs (alt)',
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 2 && !args[0]) {
    console.log('Usage: npx tsx scripts/check-lz-config.ts <oappAddress> <dstEid>')
    console.log('Defaults to checking the L2 replicator → Arbitrum Sepolia if no args given.')
    console.log()
  }
  const oapp = (args[0] || CAW_ACTIONS_REPLICATOR_L2_ADDRESS).toLowerCase()
  const dstEid = Number(args[1] || 40231)

  const rpc = process.env.RPC_BASE_SEPOLIA || 'https://sepolia.base.org'
  const provider = new JsonRpcProvider(rpc)
  const endpoint = new Contract(BASE_SEPOLIA_ENDPOINT, ENDPOINT_ABI, provider)

  console.log(`\n== Checking LZ config ==`)
  console.log(`  OApp:    ${oapp}`)
  console.log(`  DstEid:  ${dstEid}${dstEid === 40231 ? ' (Arbitrum Sepolia)' : dstEid === 40161 ? ' (Sepolia)' : ''}`)
  console.log(`  Endpoint: ${BASE_SEPOLIA_ENDPOINT}`)

  // Hint: compare with the replicator and the CawNameL2 OApps side-by-side
  if (!args[0]) {
    const otherOapps: Array<[string, string]> = [
      [CAW_ACTIONS_REPLICATOR_L2_ADDRESS, 'replicator (→ archives)'],
      [CAW_NAMES_L2_ADDRESS, 'CawNameL2 (← L1 CawName)'],
    ]
    console.log(`  (Also useful: ${otherOapps.map(([a, l]) => `${a} [${l}]`).join(', ')})`)
  }

  // 1. Resolve send library
  let sendLib: string
  try {
    sendLib = await endpoint.getSendLibrary(oapp, dstEid)
  } catch (e: any) {
    console.error(`  getSendLibrary reverted: ${e?.shortMessage || e?.message}`)
    return
  }
  const defaultSendLib: string = await endpoint.defaultSendLibrary(dstEid)
  const usingDefault = sendLib.toLowerCase() === defaultSendLib.toLowerCase()
  console.log(`\nSend library: ${sendLib} ${usingDefault ? '(default)' : '(custom)'}`)

  const coder = new AbiCoder()

  // 2. Executor config
  try {
    const raw = await endpoint.getConfig(oapp, sendLib, dstEid, CONFIG_TYPE_EXECUTOR)
    const [maxSize, executor] = coder.decode([ExecutorConfigType], raw)[0]
    console.log(`\nExecutor config (type=1):`)
    console.log(`  maxMessageSize: ${maxSize}`)
    console.log(`  executor:       ${executor}`)
    if (executor === '0x0000000000000000000000000000000000000000') {
      console.log(`  ✗ Executor is zero-address — messages will NEVER be delivered.`)
    }
  } catch (e: any) {
    console.log(`\nExecutor config (type=1): FAILED — ${e?.shortMessage || e?.message}`)
  }

  // 3. DVN / UlnConfig (this is what drives the "WAITING on DVN" status)
  try {
    const raw = await endpoint.getConfig(oapp, sendLib, dstEid, CONFIG_TYPE_ULN)
    const cfg = coder.decode([UlnConfigType], raw)[0]
    console.log(`\nULN config (type=2, "DVN config"):`)
    console.log(`  confirmations:        ${cfg.confirmations}`)
    console.log(`  requiredDVNCount:     ${cfg.requiredDVNCount}`)
    console.log(`  optionalDVNCount:     ${cfg.optionalDVNCount}`)
    console.log(`  optionalDVNThreshold: ${cfg.optionalDVNThreshold}`)
    console.log(`  requiredDVNs:`)
    for (const dvn of cfg.requiredDVNs) {
      const name = KNOWN_DVNS_BASE_SEPOLIA[String(dvn).toLowerCase()] || 'unknown'
      console.log(`    - ${dvn}  [${name}]`)
    }
    if (cfg.optionalDVNs.length > 0) {
      console.log(`  optionalDVNs:`)
      for (const dvn of cfg.optionalDVNs) {
        const name = KNOWN_DVNS_BASE_SEPOLIA[String(dvn).toLowerCase()] || 'unknown'
        console.log(`    - ${dvn}  [${name}]`)
      }
    }
    if (cfg.requiredDVNCount === 0n || cfg.requiredDVNCount === 0) {
      console.log(`  ✗ No required DVNs! Messages can't get verified. Bad config.`)
    }
  } catch (e: any) {
    console.log(`\nULN config (type=2): FAILED — ${e?.shortMessage || e?.message}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
