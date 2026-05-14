// One-shot: query CawProfileMinter.idByUsername on L1 to check whether a
// username is registered. Pass one or more names as CLI args.
//
// Usage:
//   cd client
//   npx tsx scripts/check-username.ts gilgamesh gilga2

import 'dotenv/config'
import { Contract } from 'ethers'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../src/utils/rpcProvider'

const MINTER = '0x8D65D141a60b1E1136Be62604783AADe8E7290D9' // testnet L1
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
