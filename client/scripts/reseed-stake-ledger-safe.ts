import 'dotenv/config'
import { Contract } from 'ethers'
import { makeFallbackJsonRpcProvider, getL2HttpRpcUrls, getL1HttpRpcUrls } from '../src/utils/rpcProvider'
import { assertStrictRpcChains } from './stake-ledger-repair-rpc'
import { cawProfileLedgerAbi, cawProfileAbi } from '../src/abi/generated'
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from '../src/abi/addresses'
import { prisma } from '../src/prismaClient'
import { getNetworkId } from '../src/utils/networkId'
import { acquireRepairExclusiveLock } from '../src/services/StakeLedger/repairGuard'
import { assertStakeLedgerRepairAuthority } from './stake-ledger-repair-authority'

const CURSOR_SENTINEL = 2_147_483_647
const PRECISION = 10n ** 18n
const BATCH = 20

function requireClientId(): number {
  const raw = getNetworkId()
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('NETWORK_ID (or legacy CLIENT_ID) required')
  }
  return n
}

async function main() {
  const apply = process.argv.includes('--apply')
  const clientId = requireClientId()

  assertStakeLedgerRepairAuthority(apply)

  // APPLY is an explicit repair transition. The operator-facing CLI has
  // already quiesced the runtime before granting repair authority.
  // Persist repair-required before any RPC scan so every later failure
  // remains durably fail-closed.
  if (apply) {
    await prisma.$transaction(async tx => {
      await acquireRepairExclusiveLock(tx, clientId)
      await tx.stakeLedgerRepairGuard.upsert({
        where: { networkId: clientId },
        create: {
          networkId: clientId,
          repairRequired: true,
        },
        update: {
          repairRequired: true,
        },
      })
    })
  }

  const l2Urls = getL2HttpRpcUrls()
  if (l2Urls.length === 0) throw new Error('L2 RPC not configured')

  const l1Urls = getL1HttpRpcUrls()
  if (l1Urls.length === 0) throw new Error('L1 RPC not configured')

  const l2ChainId = Number(process.env.L2_CHAIN_ID ?? 84532)
  const l1ChainId = Number(process.env.L1_CHAIN_ID ?? 11155111)

  if (!Number.isSafeInteger(l2ChainId) || l2ChainId <= 0) {
    throw new Error(`invalid L2_CHAIN_ID=${process.env.L2_CHAIN_ID}`)
  }
  if (!Number.isSafeInteger(l1ChainId) || l1ChainId <= 0) {
    throw new Error(`invalid L1_CHAIN_ID=${process.env.L1_CHAIN_ID}`)
  }

  // Authoritative repair is fail-closed: every configured RPC must prove
  // its real chain ID before any authoritative state is read.
  await assertStrictRpcChains(l2Urls, l2ChainId, 'L2')
  await assertStrictRpcChains(l1Urls, l1ChainId, 'L1')

  const l2Provider = makeFallbackJsonRpcProvider(l2Urls, l2ChainId)
  const l1Provider = makeFallbackJsonRpcProvider(l1Urls, l1ChainId)

  const l2 = new Contract(
    CAW_NAMES_L2_ADDRESS,
    cawProfileLedgerAbi as any,
    l2Provider,
  )

  const l1 = new Contract(
    CAW_NAMES_ADDRESS,
    cawProfileAbi as any,
    l1Provider,
  )

  // Freeze one authoritative L2 point. Every L2 state read below uses H.
  const H = await l2Provider.getBlockNumber()
  const nextId = BigInt(await l1.nextId())
  const maxId = Number(nextId - 1n)

  if (!Number.isSafeInteger(maxId) || maxId < 0) {
    throw new Error(`invalid maxId derived from nextId=${nextId}`)
  }

  console.log(`[safe-reseed] mode=${apply ? 'APPLY' : 'READ ONLY'}`)
  console.log(`  clientId = ${clientId}`)
  console.log(`  H        = ${H}`)
  console.log(`  nextId   = ${nextId}`)
  console.log(`  tokens   = 1..${maxId}`)
  console.log(`  cursor   = (${H}, ${CURSOR_SENTINEL})`)

  const [multiplierRaw, totalCawRaw] = await Promise.all([
    l2.rewardMultiplier({ blockTag: H }),
    l2.totalCaw({ blockTag: H }),
  ])

  const multiplier = BigInt(multiplierRaw)
  const totalCaw = BigInt(totalCawRaw)

  const ownership = new Map<number, bigint>()

  for (let start = 1; start <= maxId; start += BATCH) {
    const end = Math.min(start + BATCH - 1, maxId)
    const ids = Array.from(
      { length: end - start + 1 },
      (_, i) => start + i,
    )

    // No per-token catch: any failed historical read aborts before DB write.
    const values = await Promise.all(
      ids.map(async tokenId => {
        const raw = await l2.cawOwnership(tokenId, { blockTag: H })
        return [tokenId, BigInt(raw)] as const
      }),
    )

    for (const [tokenId, value] of values) {
      // Preserve known zero as a real authoritative state.
      ownership.set(tokenId, value)
    }

    process.stdout.write(`\r  read ${end}/${maxId}`)
  }

  if (maxId > 0) process.stdout.write('\n')

  if (ownership.size !== maxId) {
    throw new Error(
      `ownership scan incomplete: expected=${maxId} actual=${ownership.size}`,
    )
  }

  let nonZero = 0
  let sumOwnership = 0n
  let sumBalances = 0n

  const rows = Array.from(ownership.entries()).map(([tokenId, value]) => {
    if (value !== 0n) nonZero++
    sumOwnership += value

    const balance = (value * multiplier) / PRECISION
    sumBalances += balance

    return {
      tokenId,
      ownership: value,
      balance,
    }
  })

  console.log(`  rewardMultiplier = ${multiplier}`)
  console.log(`  totalCaw         = ${totalCaw}`)
  console.log(`  ownership rows   = ${ownership.size}`)
  console.log(`  non-zero rows    = ${nonZero}`)
  console.log(`  sumOwnership     = ${sumOwnership}`)
  console.log(`  sumBalances      = ${sumBalances}`)
  console.log(`  totalCaw-delta   = ${totalCaw - sumBalances}`)

  if (!apply) {
    console.log('[safe-reseed] READ ONLY complete; DB unchanged')
    return
  }

  const now = new Date()

  // One atomic repair:
  // - StakeLedgerState mirrors chain@H
  // - Current contains every token, including authoritative zero rows
  // - User stake mirrors contract-equivalent balance@H
  //
  // CawOwnershipSnapshot is intentionally untouched.
  await prisma.$transaction(async tx => {
    await acquireRepairExclusiveLock(tx, clientId)

    await tx.stakeLedgerState.upsert({
      where: { networkId: clientId },
      create: {
        networkId: clientId,
        multiplier: multiplier.toString(),
        totalCaw: totalCaw.toString(),
        lastBlock: BigInt(H),
        lastLogIndex: CURSOR_SENTINEL,
      },
      update: {
        multiplier: multiplier.toString(),
        totalCaw: totalCaw.toString(),
        lastBlock: BigInt(H),
        lastLogIndex: CURSOR_SENTINEL,
        updatedAt: now,
      },
    })

    await tx.cawOwnershipCurrent.deleteMany({})

    if (rows.length > 0) {
      await tx.cawOwnershipCurrent.createMany({
        data: rows.map(r => ({
          tokenId: r.tokenId,
          ownership: r.ownership.toString(),
        })),
      })
    }

    for (const row of rows) {
      await tx.user.updateMany({
        where: { tokenId: row.tokenId },
        data: {
          onChainStakeWei: row.balance.toString(),
          onChainStakeUpdatedAt: now,
        },
      })
    }

    // Clear the durable guard only after every authoritative replacement
    // above has succeeded. A rollback therefore leaves repair required.
    await tx.stakeLedgerRepairGuard.upsert({
      where: { networkId: clientId },
      create: {
        networkId: clientId,
        repairRequired: false,
      },
      update: {
        repairRequired: false,
      },
    })
  }, { timeout: 30_000 })

  console.log(`[safe-reseed] APPLY PASS: DB atomically reseeded from L2 block ${H}`)
}

main()
  .catch(err => {
    console.error('[safe-reseed] ABORT:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
