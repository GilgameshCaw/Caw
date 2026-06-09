/**
 * approve-minter.ts
 *
 * One-time ops step for a sponsor-enabled node: approve CawProfileMinter to
 * spend the sponsor hot wallet's CAW.
 *
 * WHY THIS EXISTS:
 *   Every sponsored mint has the Minter pull CAW from the sponsor hot wallet
 *   via transferFrom (the gift deposit + the username burn). If the sponsor
 *   wallet has NOT approved the Minter, that transferFrom reverts — and because
 *   the call runs through the EIP-7702 SmartEOA delegate, the user sees the
 *   opaque `MinterCallFailed()` (selector 0xa29e2cb1). The bootstrap tx is
 *   mined but reverts (status 0), so nothing is minted.
 *
 *   This is easy to miss because the wallet HAS plenty of CAW — it just never
 *   granted the allowance. Run this once after funding the sponsor wallet.
 *
 * Usage:
 *   # uses MaxUint256 (unlimited) by default — fine for a hot wallet you own:
 *   npx tsx scripts/approve-minter.ts
 *   # or a bounded amount in whole CAW:
 *   npx tsx scripts/approve-minter.ts --amount 1000000000
 *
 * Requires (from client/.env): SPONSOR_HOT_WALLET_PRIVATE_KEY, an L1 RPC, and
 * CAW_NAMES_MINTER_ADDRESS / CAW_ADDRESS resolvable from src/abi/addresses.ts.
 */

import { ethers } from 'ethers'
import { CAW_ADDRESS, CAW_NAMES_MINTER_ADDRESS } from '../src/abi/addresses'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../src/utils/rpcProvider'

const L1_CHAIN_ID = process.env.L1_CHAIN_ID ? Number(process.env.L1_CHAIN_ID) : 11155111

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  return idx === -1 ? undefined : process.argv[idx + 1]
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]

async function main(): Promise<void> {
  const pk = process.env.SPONSOR_HOT_WALLET_PRIVATE_KEY
  if (!pk) {
    console.error('SPONSOR_HOT_WALLET_PRIVATE_KEY is not set. Load client/.env or export it first.')
    process.exit(1)
  }
  if (!CAW_ADDRESS || !CAW_NAMES_MINTER_ADDRESS) {
    console.error('CAW_ADDRESS / CAW_NAMES_MINTER_ADDRESS missing from src/abi/addresses.ts — rerun the CLI install.')
    process.exit(1)
  }

  const amountArg = getArg('amount')
  const amount = amountArg ? BigInt(amountArg) * 10n ** 18n : ethers.MaxUint256

  const provider = makeJsonRpcProvider(getL1HttpRpcUrl(), L1_CHAIN_ID)
  const wallet = new ethers.Wallet(pk, provider)
  const caw = new ethers.Contract(CAW_ADDRESS, ERC20_ABI, wallet)

  const owner = await wallet.getAddress()
  const [bal, current] = await Promise.all([
    caw.balanceOf(owner),
    caw.allowance(owner, CAW_NAMES_MINTER_ADDRESS),
  ])

  console.log(`Sponsor wallet:    ${owner}`)
  console.log(`CAW token:         ${CAW_ADDRESS}`)
  console.log(`Minter (spender):  ${CAW_NAMES_MINTER_ADDRESS}`)
  console.log(`Sponsor CAW bal:   ${ethers.formatUnits(bal, 18)}`)
  console.log(`Current allowance: ${current === ethers.MaxUint256 ? 'UNLIMITED' : ethers.formatUnits(current, 18)}`)

  if (current >= amount) {
    console.log('\nAllowance already covers the requested amount — nothing to do.')
    return
  }

  console.log(`\nApproving ${amount === ethers.MaxUint256 ? 'UNLIMITED' : ethers.formatUnits(amount, 18) + ' CAW'}...`)
  const tx = await caw.approve(CAW_NAMES_MINTER_ADDRESS, amount)
  console.log(`  tx: ${tx.hash} (waiting for confirmation...)`)
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) {
    console.error(`  approve tx reverted (status ${receipt?.status ?? 'null'}).`)
    process.exit(1)
  }
  const newAllowance = await caw.allowance(owner, CAW_NAMES_MINTER_ADDRESS)
  console.log(`  done. New allowance: ${newAllowance === ethers.MaxUint256 ? 'UNLIMITED' : ethers.formatUnits(newAllowance, 18)}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
