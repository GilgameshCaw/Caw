import { ReportReason, ReportStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

// What POST /api/reports does with a report from a signed-in user. Kept apart
// from the route so the decisions can be tested without a database.
//
// Two things the route used to take on trust or get wrong:
//  - The author of the reported post came from the request body. It is now read
//    from the post itself, and a post that does not exist is a 404, so a report
//    cannot name an author or a post that is not there.
//  - A second report from the same reporter on the same post overwrote the
//    existing row whatever its status, which wiped what a moderator had decided
//    (status, reviewedBy, reviewedAt, resolution). A report that has been
//    decided is now left alone.

export type ReportDb = Pick<PrismaClient, 'caw' | 'report'>

export interface ReportResult {
  status: number
  body: Record<string, unknown>
}

/** A whole number above zero, from a number or a string of digits; anything else is null. */
export function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) {
    const n = Number(value.trim())
    return n > 0 ? n : null
  }
  return null
}

// Largest value of the Int columns the ids are stored in.
const INT4_MAX = 2147483647

export async function submitPostReport(
  db: ReportDb,
  input: { reporterId: number; postId: unknown; reason: ReportReason; details?: unknown },
): Promise<ReportResult> {
  const postId = parsePositiveInt(input.postId)
  if (postId === null || postId > INT4_MAX) {
    return { status: 400, body: { error: 'postId must be a positive whole number' } }
  }
  const details = typeof input.details === 'string' && input.details ? input.details : null

  const post = await db.caw.findUnique({ where: { id: postId }, select: { userId: true } })
  if (!post) return { status: 404, body: { error: 'Post not found' } }

  // Nothing makes (reporterId, postId) unique, so if there are two rows the oldest one counts.
  const existing = await db.report.findFirst({ where: { reporterId: input.reporterId, postId }, orderBy: { id: 'asc' } })
  if (existing) {
    if (existing.status !== ReportStatus.PENDING) {
      // Already decided by a moderator: keep the decision. The answer is exactly
      // the one an update gets, so a reporter cannot tell from it what happened
      // to the report.
      return { status: 200, body: { success: true, reportId: existing.id, message: 'Report updated' } }
    }
    const updated = await db.report.update({
      where: { id: existing.id },
      data: { reason: input.reason, details },
    })
    return { status: 200, body: { success: true, reportId: updated.id, message: 'Report updated' } }
  }

  const report = await db.report.create({
    data: {
      reporterId: input.reporterId,
      postId,
      postAuthorId: post.userId,
      reason: input.reason,
      details,
      status: ReportStatus.PENDING,
    },
  })
  return { status: 201, body: { success: true, reportId: report.id, message: 'Report submitted successfully' } }
}
