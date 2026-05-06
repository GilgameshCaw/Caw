// src/services/ActionProcessor/types.ts
import { PrismaClient } from '@prisma/client'

export type PrismaTransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

export interface RawAction {
  actionType: number
  senderId: number
  receiverId?: number
  receiverCawonce?: number
  // Submitting client. Used by domainProcessor to gate new-content rows
  // (CAW/RECAW) to OUR_CLIENT_ID; everything else processes regardless.
  clientId?: number
  cawonce: number
  text: string
  recipients?: number[]
  amounts?: (string | bigint)[]
  originalCawId?: number
}

export interface ProcessedAction {
  id: number
  rawEventId: number
  chainId: number
  senderId: number
  cawonce: number
  actionType: string
  data: any
}