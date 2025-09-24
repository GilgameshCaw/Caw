import { Client } from '@elastic/elasticsearch'
import { prisma } from '../prismaClient'

interface CawDocument {
  id: number
  userId: number
  username: string
  displayName?: string
  content: string
  hashtags: string[]
  mentions: string[]
  imageData?: string
  videoData?: string
  hasImage: boolean
  hasVideo: boolean
  likeCount: number
  repostCount: number
  commentCount: number
  viewCount: number
  bookmarkCount: number
  action: string
  originalCawId?: number
  createdAt: Date
  updatedAt: Date
}

interface NotificationDocument {
  id: number
  userId: number
  actorId: number
  actorUsername: string
  actorDisplayName?: string
  type: string
  cawId?: number
  cawContent?: string
  groupKey?: string
  isRead: boolean
  createdAt: Date
}

interface UserDocument {
  tokenId: number
  username: string
  displayName?: string
  bio?: string
  avatarUrl?: string
  followerCount: number
  followingCount: number
  cawCount: number
  verified: boolean
  createdAt: Date
}

class ElasticsearchService {
  private client: Client
  private isConnected: boolean = false

  constructor() {
    // Initialize with environment variables or defaults
    const node = process.env.ELASTICSEARCH_NODE || 'http://localhost:9200'
    const auth = process.env.ELASTICSEARCH_API_KEY ? {
      apiKey: process.env.ELASTICSEARCH_API_KEY
    } : undefined

    this.client = new Client({
      node,
      auth,
      // Disable SSL verification for local development
      ssl: {
        rejectUnauthorized: false
      }
    })
  }

  /**
   * Initialize Elasticsearch connection and create indices
   */
  async initialize(): Promise<void> {
    try {
      // Test connection
      const info = await this.client.info()
      console.log('Connected to Elasticsearch:', info.version.number)
      this.isConnected = true

      // Create indices with mappings
      await this.createIndices()
    } catch (error) {
      console.error('Failed to connect to Elasticsearch:', error)
      this.isConnected = false
      // Don't throw - allow the app to run without ES
    }
  }

  /**
   * Create indices with appropriate mappings
   */
  private async createIndices(): Promise<void> {
    // Caws index
    const cawsIndexExists = await this.client.indices.exists({ index: 'caws' })
    if (!cawsIndexExists) {
      await this.client.indices.create({
        index: 'caws',
        body: {
          mappings: {
            properties: {
              id: { type: 'integer' },
              userId: { type: 'integer' },
              username: { type: 'keyword' },
              displayName: { type: 'text' },
              content: {
                type: 'text',
                analyzer: 'standard',
                fields: {
                  keyword: { type: 'keyword' }
                }
              },
              hashtags: { type: 'keyword' },
              mentions: { type: 'keyword' },
              imageData: { type: 'text', index: false },
              videoData: { type: 'text', index: false },
              hasImage: { type: 'boolean' },
              hasVideo: { type: 'boolean' },
              likeCount: { type: 'integer' },
              repostCount: { type: 'integer' },
              commentCount: { type: 'integer' },
              viewCount: { type: 'integer' },
              bookmarkCount: { type: 'integer' },
              action: { type: 'keyword' },
              originalCawId: { type: 'integer' },
              createdAt: { type: 'date' },
              updatedAt: { type: 'date' }
            }
          },
          settings: {
            analysis: {
              analyzer: {
                hashtag_analyzer: {
                  type: 'custom',
                  tokenizer: 'hashtag_tokenizer',
                  filter: ['lowercase']
                },
                mention_analyzer: {
                  type: 'custom',
                  tokenizer: 'mention_tokenizer',
                  filter: ['lowercase']
                }
              },
              tokenizer: {
                hashtag_tokenizer: {
                  type: 'pattern',
                  pattern: '#\\w+'
                },
                mention_tokenizer: {
                  type: 'pattern',
                  pattern: '@\\w+'
                }
              }
            }
          }
        }
      })
      console.log('Created caws index')
    }

    // Notifications index
    const notificationsIndexExists = await this.client.indices.exists({ index: 'notifications' })
    if (!notificationsIndexExists) {
      await this.client.indices.create({
        index: 'notifications',
        body: {
          mappings: {
            properties: {
              id: { type: 'integer' },
              userId: { type: 'integer' },
              actorId: { type: 'integer' },
              actorUsername: { type: 'keyword' },
              actorDisplayName: { type: 'text' },
              type: { type: 'keyword' },
              cawId: { type: 'integer' },
              cawContent: { type: 'text' },
              groupKey: { type: 'keyword' },
              isRead: { type: 'boolean' },
              createdAt: { type: 'date' }
            }
          }
        }
      })
      console.log('Created notifications index')
    }

    // Users index
    const usersIndexExists = await this.client.indices.exists({ index: 'users' })
    if (!usersIndexExists) {
      await this.client.indices.create({
        index: 'users',
        body: {
          mappings: {
            properties: {
              tokenId: { type: 'integer' },
              username: {
                type: 'text',
                fields: {
                  keyword: { type: 'keyword' }
                }
              },
              displayName: { type: 'text' },
              bio: { type: 'text' },
              avatarUrl: { type: 'text', index: false },
              followerCount: { type: 'integer' },
              followingCount: { type: 'integer' },
              cawCount: { type: 'integer' },
              verified: { type: 'boolean' },
              createdAt: { type: 'date' }
            }
          }
        }
      })
      console.log('Created users index')
    }
  }

  /**
   * Index a caw document
   */
  async indexCaw(caw: any): Promise<void> {
    if (!this.isConnected) return

    try {
      // Extract hashtags and mentions
      const hashtags = this.extractHashtags(caw.content || '')
      const mentions = this.extractMentions(caw.content || '')

      const document: CawDocument = {
        id: caw.id,
        userId: caw.userId,
        username: caw.user?.username || '',
        displayName: caw.user?.displayName,
        content: caw.content || '',
        hashtags,
        mentions,
        imageData: caw.imageData,
        videoData: caw.videoData,
        hasImage: caw.hasImage || false,
        hasVideo: caw.hasVideo || false,
        likeCount: caw.likeCount || 0,
        repostCount: caw.repostCount || 0,
        commentCount: caw.commentCount || 0,
        viewCount: caw.viewCount || 0,
        bookmarkCount: caw.bookmarkCount || 0,
        action: caw.action,
        originalCawId: caw.originalCawId,
        createdAt: caw.createdAt,
        updatedAt: caw.updatedAt
      }

      await this.client.index({
        index: 'caws',
        id: caw.id.toString(),
        body: document
      })
    } catch (error) {
      console.error('Failed to index caw:', error)
    }
  }

  /**
   * Index a notification document
   */
  async indexNotification(notification: any): Promise<void> {
    if (!this.isConnected) return

    try {
      const document: NotificationDocument = {
        id: notification.id,
        userId: notification.userId,
        actorId: notification.actorId,
        actorUsername: notification.actor?.username || '',
        actorDisplayName: notification.actor?.displayName,
        type: notification.type,
        cawId: notification.cawId,
        cawContent: notification.caw?.content,
        groupKey: notification.groupKey,
        isRead: notification.isRead,
        createdAt: notification.createdAt
      }

      await this.client.index({
        index: 'notifications',
        id: notification.id.toString(),
        body: document
      })
    } catch (error) {
      console.error('Failed to index notification:', error)
    }
  }

  /**
   * Index a user document
   */
  async indexUser(user: any): Promise<void> {
    if (!this.isConnected) return

    try {
      // Get counts
      const followerCount = await prisma.follow.count({
        where: { followingId: user.tokenId }
      })
      const followingCount = await prisma.follow.count({
        where: { followerId: user.tokenId }
      })

      const document: UserDocument = {
        tokenId: user.tokenId,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        followerCount,
        followingCount,
        cawCount: user.cawCount || 0,
        verified: user.verified || false,
        createdAt: user.createdAt
      }

      await this.client.index({
        index: 'users',
        id: user.tokenId.toString(),
        body: document
      })
    } catch (error) {
      console.error('Failed to index user:', error)
    }
  }

  /**
   * Search across all indices
   */
  async search(query: string, type: 'all' | 'users' | 'caws' | 'hashtags', limit = 20, offset = 0): Promise<any> {
    if (!this.isConnected) {
      // Fallback to PostgreSQL if ES is not available
      return null
    }

    try {
      const indices = type === 'all' ? ['caws', 'users'] :
                     type === 'hashtags' ? ['caws'] :
                     [type]

      const searchBody: any = {
        from: offset,
        size: limit,
        query: {
          multi_match: {
            query,
            fields: type === 'hashtags'
              ? ['hashtags']
              : type === 'users'
              ? ['username^2', 'displayName', 'bio']
              : ['content^2', 'username', 'displayName', 'hashtags', 'mentions'],
            type: 'best_fields',
            fuzziness: 'AUTO'
          }
        },
        highlight: {
          fields: {
            content: {},
            username: {},
            displayName: {},
            bio: {}
          }
        }
      }

      if (type === 'hashtags') {
        // For hashtags, aggregate to get trending
        searchBody.aggs = {
          trending_hashtags: {
            terms: {
              field: 'hashtags',
              size: 10
            }
          }
        }
      }

      const response = await this.client.search({
        index: indices,
        body: searchBody
      })

      return response
    } catch (error) {
      console.error('Elasticsearch search failed:', error)
      return null
    }
  }

  /**
   * Get grouped notifications using aggregations
   */
  async getGroupedNotifications(userId: number, type?: string, limit = 50, offset = 0): Promise<any> {
    if (!this.isConnected) return null

    try {
      const must: any[] = [{ term: { userId } }]
      if (type && type !== 'all') {
        must.push({ term: { type: type === 'mentions' ? 'MENTION' : type } })
      }

      const response = await this.client.search({
        index: 'notifications',
        body: {
          from: offset,
          size: 0, // We don't want individual hits, just aggregations
          query: {
            bool: { must }
          },
          aggs: {
            grouped: {
              terms: {
                field: 'groupKey',
                size: limit,
                order: { latest: 'desc' }
              },
              aggs: {
                latest: { max: { field: 'createdAt' } },
                actors: {
                  top_hits: {
                    size: 5,
                    _source: ['actorId', 'actorUsername', 'actorDisplayName'],
                    sort: [{ createdAt: { order: 'desc' } }]
                  }
                },
                notification_sample: {
                  top_hits: {
                    size: 1,
                    _source: true,
                    sort: [{ createdAt: { order: 'desc' } }]
                  }
                },
                unread_count: {
                  filter: { term: { isRead: false } },
                  aggs: {
                    count: { value_count: { field: 'id' } }
                  }
                }
              }
            },
            ungrouped: {
              filter: {
                bool: {
                  must_not: { exists: { field: 'groupKey' } }
                }
              },
              aggs: {
                notifications: {
                  top_hits: {
                    size: limit,
                    sort: [{ createdAt: { order: 'desc' } }]
                  }
                }
              }
            }
          }
        }
      })

      return response
    } catch (error) {
      console.error('Failed to get grouped notifications:', error)
      return null
    }
  }

  /**
   * Get trending hashtags
   */
  async getTrendingHashtags(timeRange = '24h', limit = 10): Promise<string[]> {
    if (!this.isConnected) return []

    try {
      const response = await this.client.search({
        index: 'caws',
        body: {
          size: 0,
          query: {
            range: {
              createdAt: {
                gte: `now-${timeRange}`
              }
            }
          },
          aggs: {
            trending: {
              terms: {
                field: 'hashtags',
                size: limit,
                order: { _count: 'desc' }
              }
            }
          }
        }
      })

      const buckets = response.aggregations?.trending?.buckets || []
      return buckets.map((b: any) => b.key)
    } catch (error) {
      console.error('Failed to get trending hashtags:', error)
      return []
    }
  }

  /**
   * Sync all existing data from PostgreSQL to Elasticsearch
   */
  async syncAllData(): Promise<void> {
    if (!this.isConnected) return

    console.log('Starting full data sync to Elasticsearch...')

    try {
      // Sync users
      const users = await prisma.user.findMany()
      for (const user of users) {
        await this.indexUser(user)
      }
      console.log(`Synced ${users.length} users`)

      // Sync caws
      const caws = await prisma.caw.findMany({
        include: { user: true }
      })
      for (const caw of caws) {
        await this.indexCaw(caw)
      }
      console.log(`Synced ${caws.length} caws`)

      // Sync notifications
      const notifications = await prisma.notification.findMany({
        include: {
          actor: true,
          caw: true
        }
      })
      for (const notification of notifications) {
        await this.indexNotification(notification)
      }
      console.log(`Synced ${notifications.length} notifications`)

      console.log('Data sync completed')
    } catch (error) {
      console.error('Data sync failed:', error)
    }
  }

  /**
   * Delete a document from an index
   */
  async deleteDocument(index: string, id: string): Promise<void> {
    if (!this.isConnected) return

    try {
      await this.client.delete({
        index,
        id
      })
    } catch (error) {
      console.error(`Failed to delete document ${id} from ${index}:`, error)
    }
  }

  /**
   * Update a document in an index
   */
  async updateDocument(index: string, id: string, doc: any): Promise<void> {
    if (!this.isConnected) return

    try {
      await this.client.update({
        index,
        id,
        body: { doc }
      })
    } catch (error) {
      console.error(`Failed to update document ${id} in ${index}:`, error)
    }
  }

  /**
   * Extract hashtags from text
   */
  private extractHashtags(text: string): string[] {
    const hashtagRegex = /#\w+/g
    const matches = text.match(hashtagRegex) || []
    return matches.map(tag => tag.toLowerCase())
  }

  /**
   * Extract mentions from text
   */
  private extractMentions(text: string): string[] {
    const mentionRegex = /@\w+/g
    const matches = text.match(mentionRegex) || []
    return matches.map(mention => mention.substring(1).toLowerCase())
  }

  /**
   * Check if Elasticsearch is available
   */
  isAvailable(): boolean {
    return this.isConnected
  }
}

// Export singleton instance
export const elasticsearchService = new ElasticsearchService()

// Initialize on module load
elasticsearchService.initialize().catch(console.error)