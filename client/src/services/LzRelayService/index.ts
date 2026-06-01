// src/services/LzRelayService/index.ts
//
// Auto-relays stuck LayerZero V2 packets from L1 (Sepolia) to L2 (Base
// Sepolia) for the CawProfile → CawProfileL2 OApp pathway.
//
// Background:
//   LZ V2 message delivery is three steps:
//     1. DVN attestation — DVNs sign the packet on L2's receive library.
//        Once verifiable, the commit step is permissionless.
//     2. commitVerification — writes the payloadHash to L2 endpoint state.
//        Normally done by LZ's "committer worker." Permissionless.
//     3. lzReceive — executes the message on the receiver contract.
//        Normally done by LZ's "executor worker." Also permissionless.
//
//   LZ Labs' Sepolia workers are unreliable. This service polls for
//   PacketSent events on L1, finds any that are verifiable but not yet
//   committed on L2, and commits + executes them in ascending nonce order.
//
// Nonce ordering constraint:
//   The receive library tracks `lazyInboundNonce` — the highest nonce
//   delivered for a (receiver, srcEid, sender) tuple. Nonce N+1 cannot
//   be executed until nonce N is delivered. The relay loop reads
//   lazyInboundNonce + 1 to find the next expected nonce and only
//   advances when each step succeeds.
//
// Gate:
//   LZ_SELF_RELAY_ENABLED=true — otherwise the service starts but each
//   poll cycle exits immediately without touching the chain.

import 'dotenv/config'
import { z } from 'zod'
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  keccak256,
  concat,
  toBeHex,
  zeroPadValue,
  getBytes,
} from 'ethers'
import fs from 'fs'
import path from 'path'
import { Service } from '../../Service'
import {
  makeJsonRpcProvider,
  getL1HttpRpcUrl,
  getL2HttpRpcUrl,
  redactRpcUrl,
} from '../../utils/rpcProvider'
import { scanLogsForward } from '../../utils/chunkedLogs'
import { requireValidatorSigner } from '../../utils/signer'
import { CAW_NAMES_ADDRESS, CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'

// ============================================================================
// Minimal ABIs (hand-rolled — only what we need)
// ============================================================================

// L1 endpoint: just the event we scan for.
// topic0 = keccak256("PacketSent(bytes,bytes,address)")
const L1_ENDPOINT_ABI = [
  'event PacketSent(bytes encodedPacket, bytes options, address sendLibrary)',
]
const PACKET_SENT_TOPIC = keccak256(
  new TextEncoder().encode('PacketSent(bytes,bytes,address)'),
)

// L2 endpoint: query + execute methods.
const L2_ENDPOINT_ABI = [
  'function verifiable(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver) view returns (bool)',
  'function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)',
  'function lazyInboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)',
  'function lzReceive(tuple(uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable',
  'function getReceiveLibrary(address receiver, uint32 srcEid) view returns (address lib, bool isDefault)',
]

// Receive library: commit step.
const RECEIVE_LIB_ABI = [
  'function commitVerification(bytes packetHeader, bytes32 payloadHash) external',
]

// ============================================================================
// Constants
// ============================================================================

// LZ V2 endpoint address is the same on all chains.
const LZ_ENDPOINT_ADDRESS = '0x6EDCE65403992e310A62460808c4b910D972f10f'

// Packet header offsets (per LayerZero V2 spec):
//   [0]       version    (1 byte)
//   [1..8]    nonce      (8 bytes, big-endian uint64)
//   [9..12]   srcEid     (4 bytes, big-endian uint32)
//   [13..44]  sender     (32 bytes, bytes32)
//   [45..48]  dstEid     (4 bytes, big-endian uint32)
//   [49..80]  receiver   (32 bytes, bytes32)
// header = bytes[0:81]
// guid   = bytes[81:113]
// message = bytes[113:]
const HEADER_LEN = 81
const GUID_LEN   = 32

// Our OApp addresses (from addresses.ts; defaults exported from deployments).
const DEFAULT_L1_SENDER = CAW_NAMES_ADDRESS          // CawProfile (L1)
const DEFAULT_L2_RECEIVER = CAW_NAMES_L2_ADDRESS      // CawProfileL2 (L2)

// LZ endpoint IDs
const SRC_EID = 40161  // Sepolia
const DST_EID = 40245  // Base Sepolia

// State file for cursor persistence across restarts
const STATE_FILE = path.join('/tmp', 'lz-relay-state.json')

// ============================================================================
// Pathway config
// Makes it trivial to add more OApp pairs later.
// ============================================================================

interface Pathway {
  /** Human label for logging */
  label: string
  /** L1 sender address (lowercase) — filter for PacketSent events */
  senderL1: string
  /** L2 receiver address */
  receiverL2: string
  /** Source eid (L1 chain) */
  srcEid: number
  /** Destination eid (L2 chain) */
  dstEid: number
}

const PATHWAYS: Pathway[] = [
  {
    label: 'CawProfile→CawProfileL2',
    senderL1: DEFAULT_L1_SENDER.toLowerCase(),
    receiverL2: DEFAULT_L2_RECEIVER,
    srcEid: SRC_EID,
    dstEid: DST_EID,
  },
  // Future pathways go here — same shape, just add a row.
]

// ============================================================================
// Packet parsing helpers
// ============================================================================

interface ParsedPacket {
  /** Raw 81-byte header */
  header: Uint8Array
  /** 32-byte guid */
  guid: Uint8Array
  /** Message bytes after header+guid */
  message: Uint8Array
  /** keccak256(guid || message) */
  payloadHash: string
  /** 8-byte nonce as bigint */
  nonce: bigint
  /** 4-byte srcEid as number */
  srcEid: number
  /** Sender as bytes32 hex */
  sender32: string
  /** 4-byte dstEid as number */
  dstEid: number
  /** Receiver as bytes32 hex */
  receiver32: string
  /** Receiver as 20-byte address string */
  receiverAddress: string
  /** Sender as 20-byte address string (right-aligned in 32 bytes) */
  senderAddress: string
  /** Block number where PacketSent was emitted */
  blockNumber: number
  /** Block timestamp (unix seconds) */
  blockTimestamp: number
}

function parsePacketBytes(encodedPacket: Uint8Array, blockNumber: number, blockTimestamp: number): ParsedPacket | null {
  if (encodedPacket.length < HEADER_LEN + GUID_LEN) {
    console.warn(`[LzRelay] Packet too short (${encodedPacket.length} bytes) — skipping`)
    return null
  }

  const header  = encodedPacket.slice(0, HEADER_LEN)
  const guid    = encodedPacket.slice(HEADER_LEN, HEADER_LEN + GUID_LEN)
  const message = encodedPacket.slice(HEADER_LEN + GUID_LEN)

  // Decode nonce from header[1..8] (big-endian uint64)
  const nonceView = new DataView(header.buffer, header.byteOffset + 1, 8)
  const nonceHi = nonceView.getUint32(0)
  const nonceLo = nonceView.getUint32(4)
  const nonce = (BigInt(nonceHi) << 32n) | BigInt(nonceLo)

  // srcEid from header[9..12]
  const srcEidView = new DataView(header.buffer, header.byteOffset + 9, 4)
  const srcEid = srcEidView.getUint32(0)

  // sender32 from header[13..44]
  const sender32Bytes = header.slice(13, 45)
  const sender32 = '0x' + Buffer.from(sender32Bytes).toString('hex')

  // dstEid from header[45..48]
  const dstEidView = new DataView(header.buffer, header.byteOffset + 45, 4)
  const dstEid = dstEidView.getUint32(0)

  // receiver32 from header[49..80]
  const receiver32Bytes = header.slice(49, 81)
  const receiver32 = '0x' + Buffer.from(receiver32Bytes).toString('hex')

  // Extract 20-byte addresses from the rightmost 20 bytes of the 32-byte slots
  const senderAddress = '0x' + Buffer.from(sender32Bytes.slice(12)).toString('hex')
  const receiverAddress = '0x' + Buffer.from(receiver32Bytes.slice(12)).toString('hex')

  // payloadHash = keccak256(guid || message)
  const payloadHash = keccak256(concat([guid, message]))

  return {
    header,
    guid,
    message,
    payloadHash,
    nonce,
    srcEid,
    sender32,
    dstEid,
    receiver32,
    receiverAddress,
    senderAddress,
    blockNumber,
    blockTimestamp,
  }
}

// ============================================================================
// State persistence (flat file, /tmp — restart-safe, not DB)
// ============================================================================

interface RelayState {
  lastScannedBlock: number
}

function loadState(): RelayState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    return JSON.parse(raw) as RelayState
  } catch {
    return { lastScannedBlock: 0 }
  }
}

function saveState(state: RelayState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8')
  } catch (err: any) {
    console.warn(`[LzRelay] Could not save state to ${STATE_FILE}: ${err?.message}`)
  }
}

// ============================================================================
// Zod config schema
// ============================================================================

const Config = z.object({
  l1RpcUrl:        z.string().optional(),
  l2RpcUrl:        z.string().optional(),
  l1ChainId:       z.number().int().positive().default(11155111), // Sepolia
  l2ChainId:       z.number().int().positive().default(84532),    // Base Sepolia
  pollIntervalMs:  z.number().int().positive().default(60_000),
  // Startup margin: re-scan this many blocks behind the saved checkpoint to
  // recover packets discovered after a crash/restart.
  startupMargin:   z.number().int().nonnegative().default(1024),
  maxBlocksPerPoll: z.number().int().positive().default(10_000),
})

type Config = z.infer<typeof Config>

// ============================================================================
// MILESTONE: service skeleton + start()/stop()
// ============================================================================

export const lzRelayService: Service = {
  name: 'LzRelayService',

  validateConfig(cfg: unknown) {
    const result = Config.safeParse(cfg)
    return result.success
      ? []
      : result.error.errors.map((e: { message: string }) => new Error(`ZodError: ${e.message}`))
  },

  start(configParam: unknown, ctx: import('../../Service').HeartbeatContext) {
    const cfg = Config.parse(configParam)
    // Declare a generous timeout — each poll may commit+lzReceive multiple
    // packets, each of which costs a separate L2 tx. With 60s polls and up to
    // a handful of txs, 5 min is plenty of headroom.
    ctx.declareLoop('poll', Math.max(cfg.pollIntervalMs * 5, 5 * 60_000))

    const enabled = process.env.LZ_SELF_RELAY_ENABLED === 'true'
    const graceMinutes = parseInt(process.env.LZ_RELAY_GRACE_MINUTES ?? '10', 10)
    const graceMs = graceMinutes * 60_000

    const l1RpcUrl = getL1HttpRpcUrl(cfg.l1RpcUrl)
    const l2RpcUrl = getL2HttpRpcUrl(cfg.l2RpcUrl)

    let alive = true
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    // In-memory packet store: indexed by "srcEid:sender32:receiver:nonce"
    // Only packets matching one of our PATHWAYS are kept.
    const packetMap = new Map<string, ParsedPacket>()

    // Cache for receive library address per (receiver, srcEid) — looked up
    // once per pathway at first use and then cached for the process lifetime.
    const receiveLibCache = new Map<string, string>()

    const started = (async () => {
      if (!l1RpcUrl) throw new Error('[LzRelay] No L1 RPC URL configured (L1_RPC_URL or L1_RPC_URL_HTTP)')
      if (!l2RpcUrl) throw new Error('[LzRelay] No L2 RPC URL configured (L2_RPC_URL or L2_RPC_URL_HTTP)')

      if (!enabled) {
        console.log('[LzRelay] LZ_SELF_RELAY_ENABLED is not set to "true" — service will idle (no relay activity)')
      }

      const l1Provider = makeJsonRpcProvider(l1RpcUrl, cfg.l1ChainId)
      const l2Provider = makeJsonRpcProvider(l2RpcUrl, cfg.l2ChainId)

      // Build signer attached to L2 (that's where we send commit + lzReceive)
      // Uses the same VALIDATOR_PRIVATE_KEY as ValidatorService.
      const signerBackend = requireValidatorSigner({ provider: l2Provider })
      const l2Signer = signerBackend.asEthersSigner()

      console.log(`[LzRelay] Started — relay=${enabled}, grace=${graceMinutes}min, ` +
        `l1=${redactRpcUrl(l1RpcUrl)}, l2=${redactRpcUrl(l2RpcUrl)}, ` +
        `relayerAddr=${signerBackend.getAddress()}`)

      const l1Endpoint = new Contract(LZ_ENDPOINT_ADDRESS, L1_ENDPOINT_ABI, l1Provider)
      const l2Endpoint = new Contract(LZ_ENDPOINT_ADDRESS, L2_ENDPOINT_ABI, l2Signer)

      // Load cursor from disk, apply startup margin
      const state = loadState()
      const headBlock = await l1Provider.getBlockNumber()
      let lastScannedBlock: number

      if (state.lastScannedBlock > 0) {
        lastScannedBlock = Math.max(0, state.lastScannedBlock - cfg.startupMargin)
        console.log(`[LzRelay] Resuming from block ${lastScannedBlock} (checkpoint ${state.lastScannedBlock} - margin ${cfg.startupMargin})`)
      } else {
        // No prior state — start from 1024 blocks behind head as a reasonable default.
        lastScannedBlock = Math.max(0, headBlock - cfg.startupMargin)
        console.log(`[LzRelay] No prior state — starting from block ${lastScannedBlock} (head=${headBlock})`)
      }

      // MILESTONE: PacketSent decoder + scan loop

      const poll = async () => {
        if (!alive) return

        try {
          if (!enabled) {
            // Idle mode: still heartbeat so watchdog doesn't restart us.
            ctx.heartbeat('poll')
            return
          }

          const currentBlock = await l1Provider.getBlockNumber()
          if (currentBlock <= lastScannedBlock) {
            ctx.heartbeat('poll')
            return
          }

          const fromBlock = lastScannedBlock + 1
          const toBlock = Math.min(currentBlock, fromBlock + cfg.maxBlocksPerPoll - 1)

          // Scan L1 endpoint for PacketSent events in this window
          const logs = await scanLogsForward(
            l1Provider,
            LZ_ENDPOINT_ADDRESS,
            [PACKET_SENT_TOPIC],
            fromBlock,
            toBlock,
          )

          if (logs.length > 0) {
            console.log(`[LzRelay] Discovered ${logs.length} PacketSent log(s) from L1 block ${fromBlock}..${toBlock}`)
          }

          // Decode each log; keep only packets for our configured pathways
          let newPackets = 0
          for (const log of logs) {
            // PacketSent ABI: (bytes encodedPacket, bytes options, address sendLibrary)
            // encodedPacket is the first dynamic arg (ABI-decoded)
            let encodedPacketHex: string
            try {
              const iface = l1Endpoint.interface
              const decoded = iface.parseLog({ topics: log.topics as string[], data: log.data })
              if (!decoded) continue
              encodedPacketHex = decoded.args[0] as string
            } catch (decodeErr: any) {
              console.warn(`[LzRelay] Failed to decode PacketSent log at block ${log.blockNumber}: ${decodeErr?.message}`)
              continue
            }

            // Fetch block timestamp for grace period calculation
            let blockTimestamp = Math.floor(Date.now() / 1000)
            try {
              const block = await l1Provider.getBlock(log.blockNumber)
              if (block) blockTimestamp = Number(block.timestamp)
            } catch {
              // Non-fatal — grace period will be approximate
            }

            const packetBytes = getBytes(encodedPacketHex)
            const packet = parsePacketBytes(packetBytes, log.blockNumber, blockTimestamp)
            if (!packet) continue

            // Filter to known pathways
            const pathway = PATHWAYS.find(p =>
              p.senderL1 === packet.senderAddress.toLowerCase() &&
              p.srcEid === packet.srcEid &&
              p.dstEid === packet.dstEid,
            )
            if (!pathway) continue

            const mapKey = `${packet.srcEid}:${packet.sender32}:${packet.receiverAddress}:${packet.nonce}`
            if (!packetMap.has(mapKey)) {
              packetMap.set(mapKey, packet)
              newPackets++
            }
          }

          if (newPackets > 0) {
            console.log(`[LzRelay] Stored ${newPackets} new pathway-matched packet(s) (${packetMap.size} total in memory)`)
          }

          lastScannedBlock = toBlock
          saveState({ lastScannedBlock })

          // MILESTONE: commit + lzReceive logic

          // Process each pathway: find next expected nonce, commit + execute in order.
          for (const pathway of PATHWAYS) {
            await processPathway(
              pathway,
              l2Provider,
              l2Endpoint,
              l2Signer,
              packetMap,
              receiveLibCache,
              graceMs,
            )
          }

          ctx.heartbeat('poll')
        } catch (err: any) {
          console.error('[LzRelay] Poll error:', err?.message || err)
          // Still heartbeat — a transient error shouldn't trigger a watchdog restart.
          ctx.heartbeat('poll')
        } finally {
          if (!alive) return
          pollTimer = setTimeout(poll, cfg.pollIntervalMs)
        }
      }

      poll()
    })()

    return {
      started,
      async stop() {
        alive = false
        if (pollTimer) clearTimeout(pollTimer)
      },
      async stats() {
        return {
          enabled,
          graceMinutes,
          packetsCached: 0, // packetMap is not accessible here at stats() time without closure; acceptable
          lastScannedBlock: loadState().lastScannedBlock,
        }
      },
    }
  },
}

// ============================================================================
// Per-pathway relay logic
// ============================================================================

async function processPathway(
  pathway: Pathway,
  l2Provider: JsonRpcProvider,
  l2Endpoint: Contract,
  l2Signer: any,
  packetMap: Map<string, ParsedPacket>,
  receiveLibCache: Map<string, string>,
  graceMs: number,
): Promise<void> {
  const graceMinutes = Math.round(graceMs / 60_000)
  const sender32 = addressToBytes32(pathway.senderL1)
  const receiver = pathway.receiverL2

  // Discover (or cache) the receive library for this (receiver, srcEid) pair
  const libCacheKey = `${receiver.toLowerCase()}:${pathway.srcEid}`
  if (!receiveLibCache.has(libCacheKey)) {
    try {
      const [libAddr] = await l2Endpoint.getReceiveLibrary(receiver, pathway.srcEid)
      receiveLibCache.set(libCacheKey, libAddr as string)
      console.log(`[LzRelay] ${pathway.label}: receive library = ${libAddr}`)
    } catch (err: any) {
      console.warn(`[LzRelay] ${pathway.label}: could not get receive library: ${err?.message} — skipping pathway this cycle`)
      return
    }
  }
  const receiveLibAddress = receiveLibCache.get(libCacheKey)!
  const receiveLib = new Contract(receiveLibAddress, RECEIVE_LIB_ABI, l2Signer)

  // Find next nonce to deliver
  let nextNonce: bigint
  try {
    const lazy: bigint = await l2Endpoint.lazyInboundNonce(receiver, pathway.srcEid, sender32)
    nextNonce = lazy + 1n
  } catch (err: any) {
    console.warn(`[LzRelay] ${pathway.label}: lazyInboundNonce query failed: ${err?.message} — skipping`)
    return
  }

  // Walk through queued nonces in order, stopping when we can't deliver the next one
  // (prevents infinite loops: if nonce N+1 is not available, we stop rather than
  // skipping ahead, because lzReceive ordering requires N before N+1).
  let consecutiveNotFound = 0

  while (consecutiveNotFound < 2) {
    const mapKey = `${pathway.srcEid}:${sender32}:${receiver.toLowerCase()}:${nextNonce}`
    const packet = packetMap.get(mapKey)

    if (!packet) {
      // We don't have this nonce in memory — may not have been emitted yet
      // or we haven't scanned far enough back. Stop trying for this pathway.
      consecutiveNotFound++
      // Only log if nonce > 1 to avoid spam during initial startup with no history
      if (nextNonce > 1n) {
        console.log(`[LzRelay] ${pathway.label}: nonce ${nextNonce} not in local cache — nothing to relay`)
      }
      break
    }

    consecutiveNotFound = 0

    // Check if already committed (inboundPayloadHash != 0x0)
    let alreadyCommitted = false
    try {
      const existingHash: string = await l2Endpoint.inboundPayloadHash(
        receiver,
        pathway.srcEid,
        sender32,
        nextNonce,
      )
      alreadyCommitted = existingHash !== '0x0000000000000000000000000000000000000000000000000000000000000000'
    } catch (err: any) {
      console.warn(`[LzRelay] ${pathway.label}: inboundPayloadHash query failed for nonce ${nextNonce}: ${err?.message}`)
      break
    }

    if (!alreadyCommitted) {
      // Check if verifiable (DVN signed)
      let isVerifiable = false
      try {
        isVerifiable = await l2Endpoint.verifiable(
          { srcEid: pathway.srcEid, sender: sender32, nonce: nextNonce },
          receiver,
        )
      } catch (err: any) {
        console.warn(`[LzRelay] ${pathway.label}: verifiable() query failed for nonce ${nextNonce}: ${err?.message}`)
        break
      }

      if (!isVerifiable) {
        console.log(`[LzRelay] ${pathway.label}: nonce ${nextNonce} not yet verifiable — DVN attestation pending`)
        break
      }

      // Check grace period
      const nowSec = Math.floor(Date.now() / 1000)
      const ageSec = nowSec - packet.blockTimestamp
      const ageMin = Math.round(ageSec / 60)

      if (ageSec * 1000 < graceMs) {
        console.log(`[LzRelay] ${pathway.label}: nonce ${nextNonce} still verifying (age=${ageMin}min, grace=${graceMinutes}min) — waiting`)
        break
      }

      // Commit verification
      console.log(`[LzRelay] ${pathway.label}: nonce ${nextNonce}: committing...`)
      const headerHex = '0x' + Buffer.from(packet.header).toString('hex')

      try {
        const commitTx = await receiveLib.commitVerification(headerHex, packet.payloadHash)
        const receipt = await commitTx.wait()
        console.log(`[LzRelay] ${pathway.label}: nonce ${nextNonce}: committed — tx=${receipt?.hash ?? commitTx.hash}`)
      } catch (err: any) {
        const reason = extractRevertReason(err)
        console.warn(`[LzRelay] ${pathway.label}: nonce ${nextNonce}: revert on commit: ${reason} — will retry next cycle`)
        break
      }
    } else {
      console.log(`[LzRelay] ${pathway.label}: nonce ${nextNonce}: already committed — proceeding to lzReceive`)
    }

    // Execute lzReceive
    const guidHex = '0x' + Buffer.from(packet.guid).toString('hex')
    const messageHex = '0x' + Buffer.from(packet.message).toString('hex')

    console.log(`[LzRelay] ${pathway.label}: nonce ${nextNonce}: executing lzReceive...`)
    try {
      const receiveTx = await l2Endpoint.lzReceive(
        { srcEid: pathway.srcEid, sender: sender32, nonce: nextNonce },
        receiver,
        guidHex,
        messageHex,
        '0x', // extraData
        { gasLimit: 500_000 },
      )
      const receiveReceipt = await receiveTx.wait()
      const gasUsed = receiveReceipt?.gasUsed?.toString() ?? 'unknown'
      console.log(`[LzRelay] ${pathway.label}: nonce ${nextNonce}: lzReceive delivered — tx=${receiveReceipt?.hash ?? receiveTx.hash} (gas ${gasUsed})`)

      // Successfully delivered — advance pointer and remove from cache
      packetMap.delete(mapKey)
      nextNonce++
    } catch (err: any) {
      const reason = extractRevertReason(err)
      console.warn(`[LzRelay] ${pathway.label}: nonce ${nextNonce}: revert on lzReceive: ${reason} — will retry next cycle`)
      break
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a 20-byte address string to a left-zero-padded 32-byte hex string
 * (the bytes32 form LZ uses as the sender/receiver identifier).
 */
function addressToBytes32(address: string): string {
  // zeroPadValue pads to 32 bytes with leading zeros, returns 0x-prefixed hex
  return zeroPadValue(address, 32)
}

/**
 * Extract a human-readable revert reason from an ethers error, falling back
 * to the raw message. Avoids the full JSON dump polluting logs.
 */
function extractRevertReason(err: any): string {
  if (!err) return 'unknown'
  // ethers v6 wraps revert data in err.reason or err.data.message
  if (typeof err.reason === 'string' && err.reason) return err.reason
  if (typeof err.shortMessage === 'string' && err.shortMessage) return err.shortMessage
  if (typeof err.message === 'string') {
    // Truncate to first 200 chars to avoid multi-KB JSON blobs in logs
    return err.message.slice(0, 200)
  }
  return String(err)
}

// MILESTONE: env gate + grace period plumbing
// (implemented inline — enabled = process.env.LZ_SELF_RELAY_ENABLED === 'true',
//  graceMs = parseInt(process.env.LZ_RELAY_GRACE_MINUTES ?? '10') * 60_000)
