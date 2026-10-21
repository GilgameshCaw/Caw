// src/utils/indexCawById.ts
//
// Adds one committed Caw row to the search index. Kept free of the prisma
// and Elasticsearch singletons (both connect on import) so it can be tested
// without either; actionHandlers.indexCawForSearch passes the real ones.

export interface IndexCawDeps {
  isAvailable: () => boolean
  findCaw: (cawId: number) => Promise<any | null>
  indexCaw: (caw: any) => Promise<void>
}

/**
 * Re-read the Caw row (with its user) and index it. Must run after the
 * transaction that wrote the row has committed: a read from outside that
 * transaction doesn't see the row before then. Never throws — a search index
 * miss must not fail action processing; syncAllData fills it on the next
 * start or reconnect.
 */
export async function indexCawById(cawId: number, deps: IndexCawDeps): Promise<void> {
  if (!deps.isAvailable()) return
  try {
    const caw = await deps.findCaw(cawId)
    if (caw) await deps.indexCaw(caw)
  } catch (err) {
    console.error(`Failed to index caw ${cawId} for search:`, err)
  }
}
