import { Client } from '@xmtp/browser-sdk'
import type { Conversation } from '@xmtp/browser-sdk'

export interface XmtpMessage {
  id: string
  content: string
  senderAddress: string
  sent: Date
  topic: string
}

export interface XmtpConversation {
  topic: string
  peerAddress: string
  createdAt?: Date
  context?: any
}

// Signer interface that works with wagmi's wallet client
export interface XmtpSigner {
  getAddress: () => Promise<string>
  signMessage: (message: string | Uint8Array) => Promise<string>
}

class XmtpClientService {
  private client: Client | null = null
  private conversations: Map<string, Conversation> = new Map()
  private signer: XmtpSigner | null = null

  /**
   * Initialize XMTP client with user's wallet
   */
  async initializeClient(signer: XmtpSigner): Promise<void> {
    console.log('XmtpClientService.initializeClient started with browser SDK')
    try {
      // Store signer for later use
      this.signer = signer

      const address = await signer.getAddress()
      console.log('Wallet address:', address)

      // Create XMTP client with the new browser SDK
      console.log('Creating XMTP Client with browser SDK...')

      // Get environment from env variable or default to production
      const env = (import.meta.env.VITE_XMTP_ENV as 'production' | 'dev' | 'local') ?? 'production'
      const appVersion = import.meta.env.VITE_APP_VERSION ?? 'caw/0.1.0'

      console.log('XMTP Config:', { env, appVersion })

      // Create XMTP client - simplified for browser SDK
      this.client = await Client.create(signer, {
        env,
        appVersion
      })

      console.log('✅ XMTP client initialized with wallet:', address)
      console.log('Client info:', this.client)

      // Load existing conversations
      await this.loadConversations()
    } catch (error) {
      console.error('Failed to initialize XMTP client:', error)
      console.error('Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      })

      // Check if it's a network error
      if (error instanceof Error) {
        if (error.message.includes('503') || error.message.includes('Service Unavailable')) {
          throw new Error('XMTP service is temporarily unavailable. Please try again later.')
        }
        if (error.message.includes('deprecated')) {
          throw new Error('XMTP V2 network is deprecated. Migration to V3 is in progress.')
        }
      }

      throw error
    }
  }

  /**
   * Check if the client is initialized
   */
  isInitialized(): boolean {
    return this.client !== null
  }

  /**
   * Get the current user's address
   */
  async getCurrentUserAddress(): Promise<string | null> {
    if (!this.client) return null
    return this.client.address
  }

  /**
   * Load all conversations for the current user
   */
  async loadConversations(): Promise<XmtpConversation[]> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    try {
      // List all conversations
      const conversations = await this.client.conversations.list()

      // Store conversations in map for quick access
      const convList: XmtpConversation[] = []

      for (const conv of conversations) {
        this.conversations.set(conv.topic, conv)
        convList.push({
          topic: conv.topic,
          peerAddress: conv.peerAddress,
          createdAt: conv.createdAt,
          context: conv.context
        })
      }

      console.log(`Loaded ${convList.length} conversations`)
      return convList
    } catch (error) {
      console.error('Failed to load conversations:', error)
      return []
    }
  }

  /**
   * Check if an address can receive XMTP messages
   */
  async canMessage(peerAddress: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    try {
      const canMessage = await this.client.canMessage(peerAddress)
      return canMessage
    } catch (error) {
      console.error('Error checking if address can receive messages:', error)
      return false
    }
  }

  /**
   * Start a new conversation with another user
   */
  async startConversation(peerAddress: string): Promise<XmtpConversation> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    // Check if peer can receive messages
    const canMessage = await this.canMessage(peerAddress)
    if (!canMessage) {
      throw new Error(`Address ${peerAddress} cannot receive XMTP messages. They need to initialize XMTP first.`)
    }

    // Check if conversation already exists
    const existing = await this.getConversationByPeer(peerAddress)
    if (existing) {
      return existing
    }

    // Create new conversation
    const conversation = await this.client.conversations.newConversation(peerAddress)

    // Store in map
    this.conversations.set(conversation.topic, conversation)

    return {
      topic: conversation.topic,
      peerAddress: conversation.peerAddress,
      createdAt: conversation.createdAt,
      context: conversation.context
    }
  }

  /**
   * Send a message in a conversation
   */
  async sendMessage(conversationTopic: string, content: string): Promise<XmtpMessage> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    const conversation = this.conversations.get(conversationTopic)
    if (!conversation) {
      throw new Error('Conversation not found')
    }

    // Send the message
    const message = await conversation.send(content)

    return {
      id: message.id,
      content: message.content as string,
      senderAddress: message.senderAddress,
      sent: message.sent,
      topic: conversationTopic
    }
  }

  /**
   * Get messages from a conversation
   */
  async getMessages(conversationTopic: string, limit = 100): Promise<XmtpMessage[]> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    const conversation = this.conversations.get(conversationTopic)
    if (!conversation) {
      // Try to find by peer address
      const conv = Array.from(this.conversations.values()).find(c => c.topic === conversationTopic)
      if (!conv) {
        throw new Error('Conversation not found')
      }
      this.conversations.set(conversationTopic, conv)
      return this.getMessages(conversationTopic, limit)
    }

    // Get messages from the conversation
    const messages = await conversation.messages({
      limit,
      direction: 'SORT_DIRECTION_DESCENDING' as any
    })

    return messages.map(msg => ({
      id: msg.id,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      senderAddress: msg.senderAddress,
      sent: msg.sent,
      topic: conversationTopic
    })).reverse() // Reverse to get chronological order
  }

  /**
   * Stream messages from all conversations
   */
  async streamAllMessages(
    onMessage: (message: XmtpMessage) => void
  ): Promise<() => void> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    // Clean up any existing stream
    if (this.streamCleanup) {
      this.streamCleanup()
      this.streamCleanup = null
    }

    // Start streaming all messages
    const stream = await this.client.conversations.streamAllMessages()

    // Process incoming messages
    const processStream = async () => {
      try {
        for await (const message of stream) {
          onMessage({
            id: message.id,
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
            senderAddress: message.senderAddress,
            sent: message.sent,
            topic: message.conversation.topic
          })
        }
      } catch (error) {
        console.error('Stream error:', error)
      }
    }

    // Start processing in background
    const streamPromise = processStream()

    // Store and return cleanup function
    this.streamCleanup = () => {
      stream.return()
    }

    return this.streamCleanup
  }

  /**
   * Stream messages from a specific conversation
   */
  async streamMessages(
    conversationTopic: string,
    onMessage: (message: XmtpMessage) => void
  ): Promise<() => void> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    const conversation = this.conversations.get(conversationTopic)
    if (!conversation) {
      throw new Error('Conversation not found')
    }

    // Start streaming messages
    const stream = await conversation.streamMessages()

    // Process incoming messages
    const processStream = async () => {
      try {
        for await (const message of stream) {
          onMessage({
            id: message.id,
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
            senderAddress: message.senderAddress,
            sent: message.sent,
            topic: conversationTopic
          })
        }
      } catch (error) {
        console.error('Stream error:', error)
      }
    }

    // Start processing in background
    processStream()

    // Return cleanup function
    return () => {
      stream.return()
    }
  }

  /**
   * Stream all conversations (for new conversations)
   */
  async streamConversations(
    onConversation: (conversation: XmtpConversation) => void
  ): Promise<() => void> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    // Start streaming conversations
    const stream = await this.client.conversations.stream()

    // Process incoming conversations
    const processStream = async () => {
      try {
        for await (const conversation of stream) {
          // Store in map
          this.conversations.set(conversation.topic, conversation)

          // Notify callback
          onConversation({
            topic: conversation.topic,
            peerAddress: conversation.peerAddress,
            createdAt: conversation.createdAt,
            context: conversation.context
          })
        }
      } catch (error) {
        console.error('Stream error:', error)
      }
    }

    // Start processing in background
    processStream()

    // Return cleanup function
    return () => {
      stream.return()
    }
  }

  /**
   * Get conversation by peer address
   */
  async getConversationByPeer(peerAddress: string): Promise<XmtpConversation | null> {
    const conversations = Array.from(this.conversations.values())

    for (const conv of conversations) {
      if (conv.peerAddress.toLowerCase() === peerAddress.toLowerCase()) {
        return {
          topic: conv.topic,
          peerAddress: conv.peerAddress,
          createdAt: conv.createdAt,
          context: conv.context
        }
      }
    }

    return null
  }

  /**
   * Clean up and disconnect
   */
  async disconnect(): Promise<void> {
    // Clean up stream if active
    if (this.streamCleanup) {
      this.streamCleanup()
      this.streamCleanup = null
    }

    // Clear state
    this.client = null
    this.conversations.clear()
    this.signer = null
  }
}

export default new XmtpClientService()