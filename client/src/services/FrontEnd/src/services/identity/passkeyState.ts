/**
 * Read a SmartEOA account's passkeys and recovery key from contract storage.
 *
 * Events can't give this. The contract has no getters for it, `initialize`
 * emits nothing about the first passkey or the recovery key, and
 * `PasskeyActivated` is declared but never emitted: a passkey goes active when
 * its timelock ends, with no transaction.
 *
 * Layout from `forge inspect SmartEOA storageLayout`. `SmartEOAStorageSlots.t.sol`
 * fails if these slots move.
 *   slot 0: initialized (offset 0), ecdsaFallback (offset 1)
 *   slot 1: mapping(bytes32 => PasskeyEntry) passkeyPubkeys
 *   slot 2: bytes32[] passkeyHashes
 * PasskeyEntry: pubkeyX, pubkeyY, then enrolledAt (offset 0) and validFrom
 * (offset 8), both uint64, in its third slot.
 */

import { encodeAbiParameters, getAddress, keccak256, numberToHex, type Address, type Hex } from 'viem'

const SLOT_FALLBACK = 0n
const SLOT_PASSKEY_PUBKEYS = 1n
const SLOT_PASSKEY_HASHES = 2n
const UINT64_MASK = (1n << 64n) - 1n
const UINT160_MASK = (1n << 160n) - 1n

export interface EnrolledPasskey {
  pubkeyHash: Hex
  /** True if this hash matches the credential stored in localStorage. */
  isThisDevice: boolean
}

export interface PendingPasskey {
  pubkeyHash: Hex
  pubkeyX: Hex
  pubkeyY: Hex
  /** Unix seconds of the addPasskey call. */
  proposedAt: number
}

export interface PasskeyState {
  /** Active passkeys: these count towards the contract's activeCount. */
  enrolled: EnrolledPasskey[]
  /** Passkeys still in their 24h timelock. */
  pending: PendingPasskey[]
  ecdsaFallbackAddress: Address | undefined
}

export interface PasskeyStateClient {
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>
  getBlock(): Promise<{ timestamp: bigint }>
}

const toWord = (value: bigint): Hex => numberToHex(value, { size: 32 })

/**
 * Rejects if any read fails, so a failed read can't look like "no passkeys".
 * Use a client for the chain the management call goes to: each chain has its
 * own SmartEOA storage.
 */
export async function readPasskeyState(
  client: PasskeyStateClient,
  address: Address,
): Promise<PasskeyState> {
  const load = async (slot: bigint): Promise<bigint> =>
    BigInt((await client.getStorageAt({ address, slot: toWord(slot) })) ?? 0)

  const [slot0, count, block] = await Promise.all([
    load(SLOT_FALLBACK),
    load(SLOT_PASSKEY_HASHES),
    client.getBlock(),
  ])

  const hashesBase = BigInt(keccak256(toWord(SLOT_PASSKEY_HASHES)))
  const entries = await Promise.all(
    Array.from({ length: Number(count) }, async (_, i) => {
      const pubkeyHash = toWord(await load(hashesBase + BigInt(i)))
      const entryBase = BigInt(
        keccak256(
          encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'uint256' }],
            [pubkeyHash, SLOT_PASSKEY_PUBKEYS],
          ),
        ),
      )
      const [pubkeyX, pubkeyY, times] = await Promise.all([
        load(entryBase),
        load(entryBase + 1n),
        load(entryBase + 2n),
      ])
      return {
        pubkeyHash,
        pubkeyX: toWord(pubkeyX),
        pubkeyY: toWord(pubkeyY),
        enrolledAt: times & UINT64_MASK,
        validFrom: (times >> 64n) & UINT64_MASK,
      }
    }),
  )

  // The contract's test. A first key has validFrom 0, so it's always active.
  const isActive = (e: { validFrom: bigint }) => block.timestamp >= e.validFrom
  const fallback = (slot0 >> 8n) & UINT160_MASK

  return {
    enrolled: entries.filter(isActive).map(e => ({ pubkeyHash: e.pubkeyHash, isThisDevice: false })),
    pending: entries.filter(e => !isActive(e)).map(e => ({
      pubkeyHash: e.pubkeyHash,
      pubkeyX: e.pubkeyX,
      pubkeyY: e.pubkeyY,
      proposedAt: Number(e.enrolledAt),
    })),
    ecdsaFallbackAddress: fallback === 0n
      ? undefined
      : getAddress(numberToHex(fallback, { size: 20 })),
  }
}
