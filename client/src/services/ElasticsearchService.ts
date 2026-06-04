import { Client } from '@elastic/elasticsearch'
import { prisma } from '../prismaClient'
import { extractHashtagBodies, MENTION_REGEX, isValidTagBody } from '../tools/hashtagRegex'

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
  private reconnectInterval: NodeJS.Timeout | null = null
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 5
  private reconnectDelay: number = 30000 // 30 seconds

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
      tls: {
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
      console.log('[Elasticsearch] ✓ Connected successfully - Version:', info.version.number)
      this.isConnected = true
      this.reconnectAttempts = 0 // Reset reconnect attempts on successful connection

      // Stop any reconnection attempts
      if (this.reconnectInterval) {
        clearInterval(this.reconnectInterval)
        this.reconnectInterval = null
      }

      // Create indices with mappings, then populate from PostgreSQL
      await this.createIndices()
      this.syncAllData().catch(err =>
        console.error('[Elasticsearch] Initial data sync failed:', err)
      )
    } catch (error: any) {
      this.isConnected = false

      // Better error logging
      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('ConnectionError')) {
        console.log('[Elasticsearch] ✗ Not available - Running without search functionality')
        console.log('[Elasticsearch] Search features will be disabled. To enable, start Elasticsearch at http://localhost:9200')
      } else {
        console.error('[Elasticsearch] Connection error:', error.message)
      }

      // Start reconnection attempts if not already running
      this.scheduleReconnect()
    }
  }

  /**
   * Schedule automatic reconnection attempts
   */
  private scheduleReconnect(): void {
    // Don't schedule if already scheduled or max attempts reached
    if (this.reconnectInterval || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return
    }

    console.log(`[Elasticsearch] Will retry connection in ${this.reconnectDelay / 1000} seconds...`)

    this.reconnectInterval = setInterval(async () => {
      this.reconnectAttempts++
      console.log(`[Elasticsearch] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`)

      try {
        const info = await this.client.info()
        console.log('[Elasticsearch] ✓ Reconnected successfully - Version:', info.version.number)
        this.isConnected = true
        this.reconnectAttempts = 0

        // Stop reconnection attempts
        if (this.reconnectInterval) {
          clearInterval(this.reconnectInterval)
          this.reconnectInterval = null
        }

        // Create indices if needed, then populate
        await this.createIndices()
        this.syncAllData().catch(err =>
          console.error('[Elasticsearch] Post-reconnect data sync failed:', err)
        )
      } catch (error: any) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.log(`[Elasticsearch] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`)
          console.log('[Elasticsearch] Search features will remain disabled. Restart the server to retry.')

          if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval)
            this.reconnectInterval = null
          }
        }
      }
    }, this.reconnectDelay)
  }

  /**
   * Create indices with appropriate mappings
   */
  private async createIndices(): Promise<void> {
    if (!this.isConnected) {
      console.log('[Elasticsearch] Skipping index creation - not connected')
      return
    }

    try {
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
      console.log('[Elasticsearch] Created caws index')
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
      console.log('[Elasticsearch] Created notifications index')
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
      console.log('[Elasticsearch] Created users index')
    }
    } catch (error: any) {
      console.error('[Elasticsearch] Failed to create indices:', error.message)
      this.isConnected = false
      throw error
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

      // For user search, combine fuzzy full-token matching with prefix matching
      // so short queries like "gilg" can find "gilgatwo" (fuzziness alone caps
      // at edit-distance 2 for longer terms, which isn't enough for prefix hits).
      const queryDsl: any = type === 'users'
        ? {
            bool: {
              should: [
                { multi_match: { query, fields: ['username^2', 'displayName', 'bio'], type: 'best_fields', fuzziness: 'AUTO' } },
                { match_phrase_prefix: { username: { query, boost: 3 } } },
                { match_phrase_prefix: { displayName: { query } } },
              ],
              minimum_should_match: 1
            }
          }
        : {
            multi_match: {
              query,
              fields: type === 'hashtags'
                ? ['hashtags']
                : ['content^2', 'username', 'displayName', 'hashtags', 'mentions'],
              type: 'best_fields',
              fuzziness: 'AUTO'
            }
          }

      const searchBody: any = {
        from: offset,
        size: limit,
        query: queryDsl,
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

      // Body cast to any — @elastic/elasticsearch's `bool` typing is overly
      // strict about `should` accepting an array, but the runtime accepts
      // both shapes. Mirrors how the rest of this file's search calls work.
      const response = await this.client.search({
        index: 'notifications',
        body: ({
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
        } as any)
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

      const buckets = (response.aggregations?.trending as any)?.buckets as any[] || []
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
   * Extract hashtags from text. Shares recognition rules with the server-side
   * hashtag indexer and the frontend renderer (tools/hashtagRegex.ts).
   */
  private extractHashtags(text: string): string[] {
    return extractHashtagBodies(text)
  }

  /**
   * Extract mentions from text. Same Unicode-aware char class as hashtags;
   * pure-numeric mentions (which can't exist anyway since usernames must
   * contain a letter) are also rejected for consistency.
   */
  private extractMentions(text: string): string[] {
    const out: string[] = []
    for (const m of text.matchAll(MENTION_REGEX)) {
      const body = m[1].toLowerCase()
      if (isValidTagBody(body)) out.push(body)
    }
    return out
  }

  /**
   * Check if Elasticsearch is available
   */
  isAvailable(): boolean {
    return this.isConnected
  }

  /**
   * Cleanup - stop reconnection attempts
   */
  cleanup(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval)
      this.reconnectInterval = null
      console.log('[Elasticsearch] Cleanup: stopped reconnection attempts')
    }
  }
}

// Export singleton instance
export const elasticsearchService = new ElasticsearchService()

// Initialize on module load
elasticsearchService.initialize().catch(console.error)