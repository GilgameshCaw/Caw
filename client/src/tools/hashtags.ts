import { prisma } from '../prismaClient'

/**
 * Extract hashtags from text content
 * Returns array of hashtag strings (without # or $ symbol)
 * Supports both hashtags (#) and cashtags ($)
 */
export function extractHashtags(content: string): string[] {
  // Match hashtags: # or $ followed by word characters, including Unicode letters and numbers
  // Supports international characters and emojis
  const hashtagRegex = /[#$]([a-zA-Z0-9_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9]+)/g
  const matches = content.match(hashtagRegex)

  if (!matches) return []

  // Remove # or $ symbol and convert to lowercase for consistency
  return matches
    .map(tag => tag.slice(1).toLowerCase())
    .filter((tag, index, array) => array.indexOf(tag) === index) // Remove duplicates
    .filter(tag => tag.length > 0 && tag.length <= 100) // Length validation
    .filter(tag => !/^\d+$/.test(tag)) // Skip purely numeric "hashtags" like #18
}

/**
 * Process hashtags for a caw
 * Creates hashtag entries if they don't exist, creates caw-hashtag associations,
 * and updates usage counts
 */
export async function processHashtagsForCaw(cawId: number, content: string): Promise<void> {
  console.log(`[processHashtagsForCaw] Called with cawId=${cawId}, content="${content}"`)
  const hashtags = extractHashtags(content)
  console.log(`[processHashtagsForCaw] Extracted hashtags:`, hashtags)

  if (hashtags.length === 0) {
    console.log(`[processHashtagsForCaw] No hashtags found, returning early`)
    return
  }

  // Process each hashtag
  for (const hashtagName of hashtags) {
    try {
      // First, check if this caw-hashtag association already exists
      // to avoid double-counting when called multiple times for the same caw
      const existingHashtag = await prisma.hashtag.findUnique({
        where: { name: hashtagName }
      })

      if (existingHashtag) {
        // Check if association already exists
        const existingAssociation = await prisma.cawHashtag.findUnique({
          where: {
            cawId_hashtagId: {
              cawId: cawId,
              hashtagId: existingHashtag.id
            }
          }
        })

        if (existingAssociation) {
          // Association already exists, skip to avoid double-counting
          continue
        }

        // Association doesn't exist, increment count and create it
        await prisma.hashtag.update({
          where: { id: existingHashtag.id },
          data: {
            usageCount: { increment: 1 },
            updatedAt: new Date()
          }
        })

        await prisma.cawHashtag.create({
          data: {
            cawId: cawId,
            hashtagId: existingHashtag.id
          }
        })
      } else {
        // Hashtag doesn't exist, create it with count 1
        const newHashtag = await prisma.hashtag.create({
          data: {
            name: hashtagName,
            usageCount: 1
          }
        })

        // Create caw-hashtag association
        await prisma.cawHashtag.create({
          data: {
            cawId: cawId,
            hashtagId: newHashtag.id
          }
        })
      }
    } catch (error) {
      console.error(`Error processing hashtag "${hashtagName}" for caw ${cawId}:`, error)
      // Continue processing other hashtags even if one fails
    }
  }
}

/**
 * Remove hashtag associations for a caw and update usage counts
 * Used when a caw is deleted or modified
 */
export async function removeHashtagsForCaw(cawId: number): Promise<void> {
  try {
    // Get all hashtag associations for this caw
    const cawHashtags = await prisma.cawHashtag.findMany({
      where: { cawId },
      include: { hashtag: true }
    })

    // Remove associations and decrement usage counts
    for (const cawHashtag of cawHashtags) {
      // Delete the association
      await prisma.cawHashtag.delete({
        where: { id: cawHashtag.id }
      })

      // Decrement usage count
      await prisma.hashtag.update({
        where: { id: cawHashtag.hashtagId },
        data: {
          usageCount: {
            decrement: 1
          },
          updatedAt: new Date()
        }
      })

      // Optionally, remove hashtags with 0 usage
      // (You might want to keep them for historical purposes)
      // await prisma.hashtag.deleteMany({
      //   where: { usageCount: { lte: 0 } }
      // })
    }
  } catch (error) {
    console.error(`Error removing hashtags for caw ${cawId}:`, error)
  }
}

/**
 * Update hashtags for a caw when content is modified
 * Removes old associations and creates new ones
 */
export async function updateHashtagsForCaw(cawId: number, newContent: string): Promise<void> {
  try {
    // Remove existing hashtag associations
    await removeHashtagsForCaw(cawId)

    // Process new hashtags
    await processHashtagsForCaw(cawId, newContent)
  } catch (error) {
    console.error(`Error updating hashtags for caw ${cawId}:`, error)
  }
}

/**
 * Get trending hashtags within a time window
 * @param since - Date to start counting from (null for all time)
 * @param limit - Max number of results
 */
async function getHashtagsInWindow(since: Date | null, limit: number): Promise<Array<{name: string, usageCount: number}>> {
  if (since) {
    const hashtags = await prisma.$queryRaw<Array<{name: string, usageCount: bigint}>>`
      SELECT h.name, COUNT(ch.id) as "usageCount"
      FROM "Hashtag" h
      INNER JOIN "CawHashtag" ch ON ch."hashtagId" = h.id
      INNER JOIN "Caw" c ON c.id = ch."cawId"
      WHERE c.status = 'SUCCESS'
        AND c."createdAt" >= ${since}
      GROUP BY h.id, h.name
      ORDER BY COUNT(ch.id) DESC
      LIMIT ${limit}
    `
    return hashtags.map(h => ({ name: h.name, usageCount: Number(h.usageCount) }))
  } else {
    // All time - use the simpler indexed query
    const hashtags = await prisma.hashtag.findMany({
      orderBy: { usageCount: 'desc' },
      take: limit,
      select: { name: true, usageCount: true }
    })
    return hashtags
  }
}

/**
 * Get trending hashtags
 * Returns hashtags based on recent usage (last 24 hours), with fallback to longer periods
 * if there aren't enough recent hashtags
 */
export async function getTrendingHashtags(limit: number = 20): Promise<Array<{name: string, usageCount: number}>> {
  try {
    // Time windows to try: 24 hours, 7 days, 30 days, all time
    const timeWindows = [
      { hours: 24, minResults: Math.ceil(limit / 2) },  // Need at least half for 24h
      { hours: 24 * 7, minResults: Math.ceil(limit / 2) },  // Need at least half for 7d
      { hours: 24 * 30, minResults: 1 },  // Need at least 1 for 30d
      { hours: null, minResults: 0 }  // All time fallback
    ]

    for (const window of timeWindows) {
      const since = window.hours
        ? new Date(Date.now() - window.hours * 60 * 60 * 1000)
        : null

      const results = await getHashtagsInWindow(since, limit)

      if (results.length >= window.minResults || window.hours === null) {
        return results
      }
    }

    return []
  } catch (error) {
    console.error('Error fetching trending hashtags:', error)
    // Fallback to simple query if raw query fails
    try {
      const hashtags = await prisma.hashtag.findMany({
        orderBy: { usageCount: 'desc' },
        take: limit,
        select: { name: true, usageCount: true }
      })
      return hashtags
    } catch {
      return []
    }
  }
}

/**
 * Search hashtags by name
 * Returns hashtags that match the search term
 */
export async function searchHashtags(searchTerm: string, limit: number = 10): Promise<Array<{name: string, usageCount: number}>> {
  try {
    const hashtags = await prisma.hashtag.findMany({
      where: {
        name: {
          contains: searchTerm.toLowerCase(),
          mode: 'insensitive'
        }
      },
      orderBy: { usageCount: 'desc' },
      take: limit,
      select: {
        name: true,
        usageCount: true
      }
    })

    return hashtags
  } catch (error) {
    console.error('Error searching hashtags:', error)
    return []
  }
}