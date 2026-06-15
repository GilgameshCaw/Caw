// One-shot: query CawProfileMinter.idByUsername on L1 to check whether a
// username is registered. Pass one or more names as CLI args.
//
// Usage:
//   cd client
//   npx tsx scripts/check-username.ts gilgamesh gilga2
//   CAW_ENV=mainnet npx tsx scripts/check-username.ts gilgamesh

import 'dotenv/config'
import { Contract } from 'ethers'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../src/utils/rpcProvider'
import { getChainContracts, type Env } from '../src/abi/deployments'

// Resolve the CawProfileMinter address from the canonical deployments table
// instead of hardcoding it — so a redeploy that changes the address is picked
// up automatically. Env defaults to testnet; override with CAW_ENV=mainnet.
const ENV = (process.env.CAW_ENV as Env) || 'testnet'
const MINTER = getChainContracts(ENV, 'L1').CawProfileMinter
const ABI = [
  'function idByUsername(string) view returns (uint32)',
  'function usernames(uint256) view returns (string)',
]

async function main() {
  const names = process.argv.slice(2)
  if (names.length === 0) {
    console.error('Usage: npx tsx scripts/check-username.ts <name> [<name> ...]')
    process.exit(1)
  }
  if (!MINTER) {
    console.error(`No CawProfileMinter address for env "${ENV}" in deployments.ts`)
    process.exit(1)
  }

  console.error(`[env=${ENV}] CawProfileMinter=${MINTER}`)
  const provider = makeJsonRpcProvider(getL1HttpRpcUrl())
  const c = new Contract(MINTER, ABI, provider)

  for (const n of names) {
    const id = await c.idByUsername(n)
    const num = Number(id)
    let detail = ''
    if (num > 0) {
      try {
        const uname = await c.usernames(num - 1)
        detail = ` (usernames[${num - 1}] = "${uname}")`
      } catch (e: any) {
        detail = ` (usernames read err: ${e.message?.slice(0, 80)})`
      }
    }
    console.log(`idByUsername("${n}") = ${num}${detail}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
