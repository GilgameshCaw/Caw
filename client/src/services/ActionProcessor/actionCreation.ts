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
  // First, try to find existing action
  const existingAction = await tx.action.findFirst({
    where: { rawEventId: rawId }
  })

  if (existingAction) {
    console.log("Action already exists, checking domain objects")

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
    // This shouldn't happen since we checked for existence first
    // but handle it just in case of race conditions
    if (err.code === 'P2002') {
      console.log("Race condition: action was created by another process")
      // Try to find it again
      const action = await tx.action.findFirst({
        where: { rawEventId: rawId }
      })

      if (!action) {
        throw new Error("Action not found after race condition")
      }

      return { action, shouldProcessDomain: true }
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