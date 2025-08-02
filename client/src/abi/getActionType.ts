import { ActionType as PrismaActionType } from '@prisma/client'

/**
 * mapActionType
 * @param v the numeric value from the tuple
 * @returns the matching Prisma ActionType literal
 */
export default function getActionType(v: number): PrismaActionType {
  const mapping: PrismaActionType[] = [
    'CAW', 'LIKE', 'UNLIKE', 'RECAW',
    'FOLLOW', 'UNFOLLOW', 'WITHDRAW', 'OTHER'
  ]
  if (v < 0 || v >= mapping.length) throw new Error(`Unknown actionType ${v}`)
  return mapping[v]
}

