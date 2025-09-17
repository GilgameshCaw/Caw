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
}

/**
 * Process hashtags for a caw
 * Creates hashtag entries if they don't exist, creates caw-hashtag associations,
 * and updates usage counts
 */
export async function processHashtagsForCaw(cawId: number, content: string): Promise<void> {
  const hashtags = extractHashtags(content)

  if (hashtags.length === 0) {
    return
  }

  // Process each hashtag
  for (const hashtagName of hashtags) {
    try {
      // Upsert hashtag (create if doesn't exist, update usage count if it does)
      const hashtag = await prisma.hashtag.upsert({
        where: { name: hashtagName },
        create: {
          name: hashtagName,
          usageCount: 1,
        },
        update: {
          usageCount: {
            increment: 1
          },
          updatedAt: new Date()
        }
      })

      // Create caw-hashtag association if it doesn't exist
      await prisma.cawHashtag.upsert({
        where: {
          cawId_hashtagId: {
            cawId: cawId,
            hashtagId: hashtag.id
          }
        },
        create: {
          cawId: cawId,
          hashtagId: hashtag.id
        },
        update: {} // No update needed if association already exists
      })
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
 * Get trending hashtags
 * Returns hashtags ordered by usage count
 */
export async function getTrendingHashtags(limit: number = 20): Promise<Array<{name: string, usageCount: number}>> {
  try {
    const hashtags = await prisma.hashtag.findMany({
      orderBy: { usageCount: 'desc' },
      take: limit,
      select: {
        name: true,
        usageCount: true
      }
    })

    return hashtags
  } catch (error) {
    console.error('Error fetching trending hashtags:', error)
    return []
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