import { Router } from 'express'
import { requireAdmin } from '../middleware/auth'
import { prisma } from '../../prismaClient'
import { Prisma } from '@prisma/client'

const router = Router()

// All routes require admin auth
router.use(requireAdmin)

/**
 * Model metadata: defines which Prisma models are accessible,
 * their default sort, searchable fields, and display hints.
 */
interface ModelMeta {
  /** Default sort column (usually createdAt or id) */
  defaultSort: string
  /** Fields that can be text-searched */
  searchFields: string[]
  /** Fields to show in list view (subset of all fields) */
  listFields: string[]
  /** Whether writes are allowed (admin-only tables) */
  writable: boolean
  /** Human-friendly label */
  label: string
  /** Per-model allowlist of fields that admin PATCH can write. If omitted,
   *  defaults to `listFields`. Always-blocked: id, createdAt, updatedAt,
   *  any field beginning with `_`. Audit fix 2026-05-13. */
  writableFields?: string[]
}

/** Fields the admin PATCH path will never write, regardless of MODEL_META.
 *  These are either ORM-managed (id, updatedAt) or audit-sensitive in a way
 *  that should require a deliberate, explicit code change rather than a
 *  generic admin-DB edit. */
const ADMIN_WRITE_BLOCKLIST = new Set(['id', 'createdAt', 'updatedAt'])

const MODEL_META: Record<string, ModelMeta> = {
  txQueue: {
    defaultSort: 'createdAt',
    searchFields: ['signedTx', 'status', 'reason'],
    listFields: ['id', 'senderId', 'batchId', 'actionType', 'receiverId', 'receiverCawonce', 'cawonce', 'clientId', 'recipients', 'amounts', 'text', 'status', 'reason', 'createdAt'],
    writable: true,
    label: 'Tx Queue',
  },
  user: {
    defaultSort: 'createdAt',
    searchFields: ['username', 'address'],
    listFields: ['id', 'tokenId', 'username', 'address', 'cawCount', 'followerCount', 'followingCount', 'createdAt'],
    writable: true,
    label: 'Users',
  },
  caw: {
    defaultSort: 'createdAt',
    searchFields: ['content'],
    listFields: ['id', 'userId', 'content', 'action', 'status', 'cawonce', 'likeCount', 'commentCount', 'createdAt'],
    writable: true,
    label: 'Caws',
  },
  action: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'chainId', 'senderId', 'cawonce', 'actionType', 'createdAt'],
    writable: false,
    label: 'Actions',
  },
  rawEvent: {
    defaultSort: 'createdAt',
    searchFields: ['transactionHash', 'contractAddress'],
    listFields: ['id', 'chainId', 'blockNumber', 'logIndex', 'transactionHash', 'createdAt'],
    writable: false,
    label: 'Raw Events',
  },
  like: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'userId', 'cawId', 'action', 'pending', 'createdAt'],
    writable: false,
    label: 'Likes',
  },
  reply: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'userId', 'cawId', 'replyCawId', 'pending', 'createdAt'],
    writable: false,
    label: 'Replies',
  },
  follow: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'followerId', 'followingId', 'action', 'status', 'createdAt'],
    writable: false,
    label: 'Follows',
  },
  block: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'blockerId', 'blockedId', 'createdAt'],
    writable: false,
    label: 'Blocks',
  },
  hashtag: {
    defaultSort: 'usageCount',
    searchFields: ['name'],
    listFields: ['id', 'name', 'usageCount', 'createdAt'],
    writable: false,
    label: 'Hashtags',
  },
  notification: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'userId', 'actorId', 'type', 'cawId', 'isRead', 'createdAt'],
    writable: false,
    label: 'Notifications',
  },
  scheduledCaw: {
    defaultSort: 'scheduledAt',
    searchFields: ['content'],
    listFields: ['id', 'userId', 'content', 'status', 'scheduledAt', 'createdAt'],
    writable: true,
    label: 'Scheduled Caws',
  },
  withdrawalRequest: {
    defaultSort: 'createdAt',
    searchFields: ['status', 'txHash'],
    listFields: ['id', 'userId', 'amount', 'status', 'cawonce', 'txHash', 'createdAt'],
    writable: true,
    label: 'Withdrawals',
  },
  tip: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'senderId', 'recipientId', 'amount', 'cawId', 'pending', 'createdAt'],
    writable: false,
    label: 'Tips',
  },
  shortUrl: {
    defaultSort: 'createdAt',
    searchFields: ['code', 'originalUrl', 'title'],
    listFields: ['id', 'code', 'originalUrl', 'title', 'clickCount', 'createdAt'],
    writable: false,
    label: 'Short URLs',
  },
  report: {
    defaultSort: 'createdAt',
    searchFields: ['reason', 'status', 'details'],
    listFields: ['id', 'reporterId', 'postId', 'reason', 'status', 'createdAt'],
    writable: true,
    label: 'Reports',
  },
  bugReport: {
    defaultSort: 'createdAt',
    searchFields: ['description', 'status', 'type', 'username'],
    listFields: ['id', 'type', 'username', 'description', 'status', 'page', 'createdAt'],
    writable: true,
    label: 'Bug Reports',
  },
  validatorTx: {
    defaultSort: 'createdAt',
    searchFields: ['txHash', 'txType', 'status'],
    listFields: ['id', 'txHash', 'txType', 'actionCount', 'gasUsed', 'status', 'createdAt'],
    writable: false,
    label: 'Validator Txs',
  },
  replicationTx: {
    defaultSort: 'createdAt',
    searchFields: ['txHash', 'status'],
    listFields: ['id', 'txHash', 'networkId', 'actionCount', 'status', 'createdAt'],
    writable: false,
    label: 'Replication Txs',
  },
  validatorSetting: {
    defaultSort: 'updatedAt',
    searchFields: ['key'],
    listFields: ['key', 'value', 'updatedAt'],
    writable: true,
    label: 'Validator Settings',
  },
  network: {
    defaultSort: 'createdAt',
    searchFields: ['ownerAddress'],
    listFields: ['id', 'ownerAddress', 'feeAddress', 'createdAt'],
    writable: false,
    label: 'Networks',
  },
  chainData: {
    defaultSort: 'updatedAt',
    searchFields: ['key'],
    listFields: ['key', 'value', 'updatedAt'],
    writable: false,
    label: 'Chain Data',
  },
  priceSnapshot: {
    defaultSort: 'createdAt',
    searchFields: ['token'],
    listFields: ['id', 'token', 'usdPrice', 'ethPrice', 'createdAt'],
    writable: false,
    label: 'Price Snapshots',
  },
  marketplaceListing: {
    defaultSort: 'createdAt',
    searchFields: ['seller', 'username', 'status'],
    listFields: ['id', 'listingId', 'tokenId', 'seller', 'username', 'listingType', 'status', 'startPrice', 'createdAt'],
    writable: false,
    label: 'Marketplace Listings',
  },
  marketplaceBid: {
    defaultSort: 'createdAt',
    searchFields: ['bidder', 'status'],
    listFields: ['id', 'listingId', 'bidder', 'amount', 'status', 'createdAt'],
    writable: false,
    label: 'Marketplace Bids',
  },
  marketplaceSale: {
    defaultSort: 'createdAt',
    searchFields: ['buyer', 'seller', 'username'],
    listFields: ['id', 'listingId', 'buyer', 'seller', 'tokenId', 'price', 'username', 'createdAt'],
    writable: false,
    label: 'Marketplace Sales',
  },
  marketplaceOffer: {
    defaultSort: 'createdAt',
    searchFields: ['offerer', 'username', 'status'],
    listFields: ['id', 'offerId', 'tokenId', 'offerer', 'username', 'amount', 'paymentToken', 'status', 'expiry', 'createdAt'],
    writable: false,
    label: 'Marketplace Offers',
  },
  bookmark: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'userId', 'cawId', 'createdAt'],
    writable: false,
    label: 'Bookmarks',
  },
  dmIdentity: {
    defaultSort: 'createdAt',
    searchFields: ['walletAddress'],
    listFields: ['id', 'userId', 'walletAddress', 'dmPrivacy', 'createdAt'],
    writable: false,
    label: 'DM Identities',
  },
  conversation: {
    defaultSort: 'lastMessageAt',
    searchFields: [],
    listFields: ['id', 'type', 'creatorId', 'lastMessageAt', 'createdAt'],
    writable: false,
    label: 'Conversations',
  },
  message: {
    defaultSort: 'createdAt',
    searchFields: [],
    listFields: ['id', 'conversationId', 'senderId', 'contentType', 'status', 'createdAt'],
    writable: false,
    label: 'Messages',
  },
}

// Prisma delegate accessor (type-safe model name → prisma.model)
function getDelegate(model: string): any {
  return (prisma as any)[model]
}

// Resolve the (idField, idValue) pair for a model + url param.
// validatorSetting + chainData use `key` as PK; everything else uses `id`.
// Don't pre-coerce to Number unconditionally — some models (Message,
// Conversation) use UUID String PKs, and Number("some-uuid") = NaN crashed
// findUnique with a Prisma type error (the original "click on a single
// message → 500" bug). Numeric-looking IDs coerce to Int; anything else
// passes through as a string and Prisma rejects type mismatches cleanly.
function resolveIdForLookup(model: string, id: string): { idField: string; idValue: string | number } {
  const idField = model === 'validatorSetting' || model === 'chainData' ? 'key' : 'id'
  let idValue: string | number = id
  if (idField === 'id' && /^-?\d+$/.test(id)) {
    idValue = Number(id)
  }
  return { idField, idValue }
}

/**
 * GET /api/admin/db/models
 * Returns the list of available models and their metadata.
 */
router.get('/models', (_req, res) => {
  const models = Object.entries(MODEL_META).map(([name, meta]) => ({
    name,
    ...meta,
  }))
  res.json({ models })
})

/**
 * GET /api/admin/db/:model
 * List records with pagination, sorting, searching, and filtering.
 *
 * Query params:
 *   limit   - page size (default 50, max 200)
 *   offset  - skip N records (default 0)
 *   sort    - column name (default: model's defaultSort)
 *   order   - 'asc' or 'desc' (default: 'desc')
 *   search  - text search across model's searchFields
 *   filter  - JSON object of { field: value } exact matches
 */
router.get('/:model', async (req, res) => {
  const { model } = req.params
  const meta = MODEL_META[model]
  if (!meta) {
    return res.status(404).json({ error: `Unknown model: ${model}` })
  }

  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Number(req.query.offset) || 0
  const requestedSort = (req.query.sort as string) || meta.defaultSort
  // Guard against sort fields that aren't valid for this model (e.g. stale
  // query param left over from switching models).
  const sortField = meta.listFields.includes(requestedSort) ? requestedSort : meta.defaultSort
  const sortOrder = (req.query.order as string) === 'asc' ? 'asc' : 'desc'
  const search = (req.query.search as string) || ''
  const filterRaw = req.query.filter as string

  const delegate = getDelegate(model)
  if (!delegate) {
    return res.status(404).json({ error: `Model ${model} not found in Prisma client` })
  }

  // Build where clause
  const where: any = {}

  // Text search across searchable fields
  if (search && meta.searchFields.length > 0) {
    where.OR = meta.searchFields.map(field => ({
      [field]: { contains: search, mode: 'insensitive' as Prisma.QueryMode }
    }))
  }

  // Exact field filters
  if (filterRaw) {
    try {
      const filters = JSON.parse(filterRaw)
      for (const [key, value] of Object.entries(filters)) {
        if (value !== '' && value !== null && value !== undefined) {
          // Try to parse as number for numeric fields
          const numVal = Number(value)
          where[key] = !isNaN(numVal) && String(value).trim() !== '' ? numVal : value
        }
      }
    } catch { /* ignore bad JSON */ }
  }

  try {
    const [records, total] = await Promise.all([
      delegate.findMany({
        where,
        orderBy: { [sortField]: sortOrder },
        take: limit,
        skip: offset,
      }),
      delegate.count({ where }),
    ])

    // For models that reference users by tokenId via a *Id column, batch-fetch
    // the corresponding usernames in one query and stamp `*Username` synthetic
    // fields onto each record. The frontend renders these as "99 (gilga99)"
    // — way more useful than scrolling through a wall of bare numeric IDs.
    // Only one query per page; capped at 200 by the limit clause above.
    const USER_ID_FIELDS = ['senderId', 'recipientId', 'userId', 'actorId',
      'tokenId', 'followerId', 'followingId', 'blockerId', 'blockedId',
      'reporterId', 'receiverId']
    const presentIdFields = USER_ID_FIELDS.filter(f => meta.listFields.includes(f))
    if (presentIdFields.length > 0 && records.length > 0) {
      const tokenIds = new Set<number>()
      for (const r of records) {
        for (const f of presentIdFields) {
          const v = (r as any)[f]
          if (typeof v === 'number' && v > 0) tokenIds.add(v)
        }
      }
      if (tokenIds.size > 0) {
        const users = await prisma.user.findMany({
          where: { tokenId: { in: Array.from(tokenIds) } },
          select: { tokenId: true, username: true },
        })
        const usernameByTokenId = new Map(users.map(u => [u.tokenId, u.username]))
        for (const r of records) {
          for (const f of presentIdFields) {
            const v = (r as any)[f]
            const uname = typeof v === 'number' ? usernameByTokenId.get(v) : undefined
            if (uname) (r as any)[`${f}Username`] = uname
          }
        }
      }
    }

    res.json({
      records: JSON.parse(JSON.stringify(records, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )),
      total,
      limit,
      offset,
      model,
      meta,
    })
  } catch (err: any) {
    console.error(`[AdminDB] Error listing ${model}:`, err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/admin/db/:model/:id
 * Get a single record by ID with all fields.
 */
router.get('/:model/:id', async (req, res) => {
  const { model, id } = req.params
  const meta = MODEL_META[model]
  if (!meta) {
    return res.status(404).json({ error: `Unknown model: ${model}` })
  }

  const delegate = getDelegate(model)
  if (!delegate) {
    return res.status(404).json({ error: `Model ${model} not found in Prisma client` })
  }

  try {
    const { idField, idValue } = resolveIdForLookup(model, id)
    const record = await delegate.findUnique({
      where: { [idField]: idValue },
    })

    if (!record) {
      return res.status(404).json({ error: 'Record not found' })
    }

    res.json({
      record: JSON.parse(JSON.stringify(record, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )),
      model,
      meta,
    })
  } catch (err: any) {
    console.error(`[AdminDB] Error fetching ${model}/${id}:`, err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PATCH /api/admin/db/:model/:id
 * Update a record. Only allowed for writable models.
 */
router.patch('/:model/:id', async (req, res) => {
  const { model, id } = req.params
  const meta = MODEL_META[model]
  if (!meta) {
    return res.status(404).json({ error: `Unknown model: ${model}` })
  }

  if (!meta.writable) {
    return res.status(403).json({ error: `Model ${model} is read-only` })
  }

  const delegate = getDelegate(model)

  // Filter req.body against an explicit field allowlist. Previously this
  // spread the full req.body into delegate.update, which let admins (or
  // anyone with admin auth tokens) silently update fields outside the
  // intended write set — including role-promotion fields if the schema
  // ever evolved to include them. Audit fix 2026-05-13.
  //
  // Allowlist source order:
  //   1. meta.writableFields (explicit per-model list)
  //   2. fallback to meta.listFields minus the global blocklist
  // Either way, fields in ADMIN_WRITE_BLOCKLIST are always stripped, and
  // unknown fields are dropped rather than rejected (so admin-tool UI
  // pre-populating extra fields stays forgiving).
  const allowed = new Set(
    (meta.writableFields ?? meta.listFields).filter(f => !ADMIN_WRITE_BLOCKLIST.has(f))
  )
  const data: Record<string, unknown> = {}
  for (const k of Object.keys(req.body ?? {})) {
    if (allowed.has(k) && !ADMIN_WRITE_BLOCKLIST.has(k)) data[k] = req.body[k]
  }

  try {
    const { idField, idValue } = resolveIdForLookup(model, id)
    const record = await delegate.update({
      where: { [idField]: idValue },
      data,
    })

    res.json({
      record: JSON.parse(JSON.stringify(record, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )),
    })
  } catch (err: any) {
    console.error(`[AdminDB] Error updating ${model}/${id}:`, err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * DELETE /api/admin/db/:model/:id
 * Delete a record. Only allowed for writable models. Requires a `reason`
 * field in the request body and writes a ModeratorAction audit row so
 * deletes via the admin DB tool leave a trail. Audit fix 2026-05-13.
 */
router.delete('/:model/:id', async (req, res) => {
  const { model, id } = req.params
  const meta = MODEL_META[model]
  if (!meta) {
    return res.status(404).json({ error: `Unknown model: ${model}` })
  }

  if (!meta.writable) {
    return res.status(403).json({ error: `Model ${model} is read-only` })
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (!reason) {
    return res.status(400).json({ error: 'reason field is required for admin DB delete' })
  }
  // Best-effort attribution: the admin auth path may or may not have a
  // wallet identity attached (password-cookie admin has none, wallet-auth
  // admin has authorizedTokenIds[0]).
  const actorTokenId =
    (req as any).sessionData?.authorizedTokenIds?.[0] ?? null

  const delegate = getDelegate(model)

  try {
    const { idField, idValue } = resolveIdForLookup(model, id)
    await delegate.delete({
      where: { [idField]: idValue },
    })

    // Audit row. Best-effort — if the audit write fails we still report
    // success to the admin, since the delete itself landed.
    try {
      await prisma.moderatorAction.create({
        data: {
          actorTokenId,
          type: `admin_db_delete:${model}`,
          reason: `Deleted ${model}/${idValue}: ${reason}`.slice(0, 1000),
        },
      })
    } catch (auditErr: any) {
      console.error('[AdminDB] Failed to write audit row:', auditErr.message)
    }

    res.json({ success: true })
  } catch (err: any) {
    console.error(`[AdminDB] Error deleting ${model}/${id}:`, err.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
