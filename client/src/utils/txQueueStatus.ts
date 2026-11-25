/**
 * TxQueue status groups that more than one route needs to agree on.
 *
 * TxQueue.status is a plain string column, and each new in-flight status
 * (awaiting_indexer, waiting_for_deposit, waiting_for_session) was added to the
 * lists that existed at the time, so copies of the list drifted apart. Keep the
 * lists here, in one place.
 */

/** A row that has been accepted and has not reached a final state yet. */
export const IN_FLIGHT_TXQUEUE_STATUSES = [
  'pending',
  'processing',
  'awaiting_indexer',
  'waiting_for_deposit',
  'waiting_for_session',
] as const

/**
 * A row whose cawonce may still be used on chain: the in-flight statuses, and
 * `underpriced`, whose signed payload can still be relayed to another validator.
 * Final rows are not listed: a confirmed one is already in the Action table, and
 * a failed or cancelled one never used its cawonce.
 */
export const CAWONCE_HELD_TXQUEUE_STATUSES = [
  ...IN_FLIGHT_TXQUEUE_STATUSES,
  'underpriced',
] as const
