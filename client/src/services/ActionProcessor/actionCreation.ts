// src/services/ActionProcessor/actionCreation.ts
import { prisma } from '../../prismaClient'
import getActionType from '../../abi/getActionType'
import { checkDomainObjectExists } from './domainObjectChecks'
import type { PrismaTransactionClient, RawAction, ProcessedAction } from './types'

export interface CreateActionResult {
  action: ProcessedAction
  shouldProcessDomain: boolean
}

/**
 * Create or find an existing action, and determine if domain processing is needed
 */
export async function createOrFindAction(
  tx: PrismaTransactionClient,
  rawId: number,
  chainId: number,
  rawAction: RawAction
): Promise<CreateActionResult> {
  // First, try to find existing action (match by chainId + senderId + cawonce,
  // which is the unique constraint on the Action table)
  const existingAction = await tx.action.findFirst({
    where: {
      chainId,
      senderId: rawAction.senderId,
      cawonce: rawAction.cawonce,
    }
  })

  if (existingAction) {
    console.log(`Action already exists (id=${existingAction.id}, type=${existingAction.actionType}, sender=${existingAction.senderId}, cawonce=${existingAction.cawonce}), checking domain objects`)

    // Check if domain objects already exist for this action
    const actionType = getActionType(Number(rawAction.actionType))
    const domainObjectExists = await checkDomainObjectExists(
      tx,
      existingAction,
      rawAction,
      actionType
    )

    if (domainObjectExists) {
      console.log("Domain object already exists, skipping")
      return { action: existingAction, shouldProcessDomain: false }
    }

    console.log("Action exists but domain object missing, proceeding to create it")
    return { action: existingAction, shouldProcessDomain: true }
  }

  // Action doesn't exist, create it
  try {
    console.log("Creating new action")
    const action = await tx.action.create({
      data: {
        rawEventId: rawId,
        chainId: chainId,
        senderId: rawAction.senderId,
        cawonce: rawAction.cawonce,
        actionType: getActionType(Number(rawAction.actionType)),
        data: rawAction as any
      }
    })

    // New action created, definitely need to process domain
    return { action, shouldProcessDomain: true }

  } catch (err: any) {
    // If we get a P2002 (duplicate), the transaction is aborted
    // Don't try to query within an aborted transaction
    // Just throw and let the outer handler retry or skip
    if (err.code === 'P2002') {
      console.log("Race condition: action was created by another process (P2002)")
      // Rethrow - the transaction will be aborted and the outer catch will handle it
      throw new Error("Action already exists (race condition)")
    }

    console.log('action.create error', err)
    throw err
  }
}

/**
 * Validate and ensure action exists before domain processing
 */
export async function ensureActionExists(
  tx: PrismaTransactionClient,
  rawId: number,
  action?: ProcessedAction
): Promise<ProcessedAction> {
  if (!action) {
    const foundAction = await tx.action.findFirst({
      where: { rawEventId: rawId }
    })

    if (!foundAction) {
      console.log("Action not found, creating new one failed")
      throw new Error("Action not found and creation failed")
    }

    return foundAction
  }

  return action
}