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
  let action: ProcessedAction

  try {
    console.log("Will create?")
    action = await prisma.action.create({
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
    console.log("error - ", err.code === 'P2002' ? "already exists" : "other issue:")

    if (err.code === 'P2002') {
      // Action already exists, check if domain objects were created
      action = await tx.action.findFirst({
        where: { rawEventId: rawId }
      })

      if (!action) {
        console.log("Action not found in transaction, skipping")
        throw new Error("Action not found after creation failed")
      }

      // Check if domain objects already exist for this action
      const actionType = getActionType(Number(rawAction.actionType))
      const domainObjectExists = await checkDomainObjectExists(
        tx,
        action,
        rawAction,
        actionType
      )

      if (domainObjectExists) {
        console.log("Domain object already exists, skipping")
        return { action, shouldProcessDomain: false }
      }

      console.log("Action exists but domain object missing, proceeding to create it")
      return { action, shouldProcessDomain: true }

    } else {
      console.log('action.create error', err)
      throw err
    }
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