// src/services/RawEventsGatherer/listenForRawEvents.ts
import { ContractEventPayload, WebSocketProvider, Contract, keccak256, toUtf8Bytes, getBytes, concat } from 'ethers'
import type { Log } from '@ethersproject/abstract-provider'
import { CAW_ACTIONS_ADDRESS } from '../../abi/addresses'
import delay from '../../tools/delay'

export type RawEventInput = {
  chainId: number
  blockNumber: number
  logIndex: number
  transactionHash: string
  parentHash: string
  data: any
  topics: string[]
  contractAddress: string
}

/**
 * listenForRawEvents
 * @description stream historical + live ActionsProcessed logs, compute parentHash chain
 */
export default async function listenForRawEvents(
  config: {
    rpcUrl: string
    contractAddress: string
    chainId: number
    rawEventsProvider: {
      getLastProcessedEvent(): Promise<{
        blockNumber: number
        logIndex: number
        parentHash: string
      } | null>
      storeEvent(e: RawEventInput): Promise<void>
    }
  }
): Promise<{ stop(): void }> {
  const provider = new WebSocketProvider(config.rpcUrl)
  const contract = new Contract(
    CAW_ACTIONS_ADDRESS,
    [
      'event ActionsProcessed(' +
      'tuple(' +
        'uint8 actionType,' +
        'uint32 senderId,' +
        'uint32 receiverId,' +
        'uint32 receiverCawonce,' +
        'uint32 clientId,' +
        'uint32 cawonce,' +
        'uint32[] recipients,' +
        'uint128[] amounts,' +
        'string text' +
      ')[] actions' +
      ')'
    ],
    provider
  )

  const last = await config.rawEventsProvider.getLastProcessedEvent()
  const startBlock = last ? last.blockNumber : 0
  let lastHash = last?.parentHash ?? 'genesis'

  function hashNext(prev: string, action: any): string {
    // JSON stringify with bigint→string replacer
    const json = JSON.stringify(action, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v
    )
    // turn previous hash hex → bytes, and action JSON → bytes
    // if prev is hex, decode it; otherwise treat as text
    const prevBytes = prev.match(/^0x[0-9a-fA-F]+$/)
      ? getBytes(prev)
      : toUtf8Bytes(prev)
    const input = concat([ prevBytes, toUtf8Bytes(json) ])
    // pure‑JS keccak256 → hex string
    return keccak256(input)
  }


  let past: Log[]
  while (true) {
    try {
      const raw = await contract.queryFilter(
        contract.filters.ActionsProcessed(),
        startBlock
      )
      past = raw as unknown as Log[]
      break
    } catch (err) {
      console.error('Error fetching past events, retrying in 5s', err)
      await delay(5000)
    }
  }

  for (const ev of past) {
    const rawData = ev.data ?? '0x'
    const decoded = contract.interface.decodeEventLog(
      'ActionsProcessed',
      rawData,
      ev.topics
    )
    console.log("Will store: ", ev)
    for (const tuple of decoded.actions as any[]) {
      const action = {
        actionType:      Number(tuple[0]),
        senderId:        Number(tuple[1]),
        receiverId:      Number(tuple[2]),
        receiverCawonce: Number(tuple[3]),
        clientId:        Number(tuple[4]),
        cawonce:         Number(tuple[5]),
        recipients:      tuple[6],
        amounts:         tuple[7],
        text:            tuple[8]
      }
      const logIndex = ev.logIndex ?? 0
      lastHash = hashNext(lastHash, action)
      await config.rawEventsProvider.storeEvent({
        chainId:         config.chainId,
        blockNumber:     ev.blockNumber,
        logIndex,
        transactionHash: ev.transactionHash,
        parentHash:      lastHash,
        data:            action,
        topics:          ev.topics,
        contractAddress: ev.address
      })
    }
  }

  contract.on('ActionsProcessed', async (rawActions: any[], ev: ContractEventPayload) => {
    console.log("Raw event received", rawActions, ev)
    try {
      for (const tuple of rawActions as any[]) {
        const action = {
          actionType:      Number(tuple[0]),
          senderId:        Number(tuple[1]),
          receiverId:      Number(tuple[2]),
          receiverCawonce: Number(tuple[3]),
          clientId:        Number(tuple[4]),
          cawonce:         Number(tuple[5]),
          recipients:      tuple[6],
          amounts:         tuple[7],
          text:            tuple[8]
        }
        const logIndex = ev.log.index ?? 0
        lastHash = hashNext(lastHash, action)
        await config.rawEventsProvider.storeEvent({
          chainId:         config.chainId,
          blockNumber:     ev.log.blockNumber,
          logIndex,
          transactionHash: ev.log.transactionHash,
          parentHash:      lastHash,
          data:            action,
          topics:          [ ...ev.log.topics ] ,
          contractAddress: ev.log.address
        })
      }
    } catch (err) {
      console.error("FAILED to process raw event", err)
    }
  })

  return {
    stop() { ;(provider as any).destroy?.() }
  }
}

