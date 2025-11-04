import { Signer } from 'ethers'

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

class MockXmtpService {
  private initialized = false
  private address: string | null = null
  private conversations: Map<string, XmtpConversation> = new Map()
  private messages: Map<string, XmtpMessage[]> = new Map()
  private messageIdCounter = 0
  private streamCallbacks: Map<string, (message: XmtpMessage) => void> = new Map()

  /**
   * Initialize mock XMTP client
   */
  async initializeClient(signer: Signer): Promise<void> {
    console.log('MockXmtpService.initializeClient started')

    // Simulate async initialization
    await new Promise(resolve => setTimeout(resolve, 500))

    this.address = await signer.getAddress()
    this.initialized = true

    console.log('✅ Mock XMTP client initialized with wallet:', this.address)

    // Load some mock conversations for testing
    this.loadMockConversations()
  }

  /**
   * Load mock conversations for testing
   */
  private loadMockConversations(): void {
    // Add a test conversation
    const mockConversation: XmtpConversation = {
      topic: 'mock-topic-1',
      peerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb7',
      createdAt: new Date(Date.now() - 86400000), // 1 day ago
      context: {}
    }

    this.conversations.set(mockConversation.topic, mockConversation)

    // Add some mock messages
    const mockMessages: XmtpMessage[] = [
      {
        id: 'msg-1',
        content: 'Welcome to mock XMTP! This is a test message.',
        senderAddress: mockConversation.peerAddress,
        sent: new Date(Date.now() - 3600000), // 1 hour ago
        topic: mockConversation.topic
      },
      {
        id: 'msg-2',
        content: 'You can test messaging features here.',
        senderAddress: this.address!,
        sent: new Date(Date.now() - 1800000), // 30 minutes ago
        topic: mockConversation.topic
      }
    ]

    this.messages.set(mockConversation.topic, mockMessages)
  }

  /**
   * Check if the client is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Get the current user's address
   */
  async getCurrentUserAddress(): Promise<string | null> {
    return this.address
  }

  /**
   * Load all conversations
   */
  async loadConversations(): Promise<XmtpConversation[]> {
    if (!this.initialized) {
      throw new Error('Mock XMTP client not initialized')
    }

    // Simulate async load
    await new Promise(resolve => setTimeout(resolve, 200))

    return Array.from(this.conversations.values())
  }

  /**
   * Check if an address can receive messages
   */
  async canMessage(peerAddress: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Mock XMTP client not initialized')
    }

    // Simulate async check
    await new Promise(resolve => setTimeout(resolve, 100))

    // Always return true for mock
    return true
  }

  /**
   * Start a new conversation
   */
  async startConversation(peerAddress: string): Promise<XmtpConversation> {
    if (!this.initialized) {
      throw new Error('Mock XMTP client not initialized')
    }

    // Check if conversation already exists
    const existing = await this.getConversationByPeer(peerAddress)
    if (existing) {
      return existing
    }

    // Create new conversation
    const conversation: XmtpConversation = {
      topic: `mock-topic-${Date.now()}`,
      peerAddress: peerAddress,
      createdAt: new Date(),
      context: {}
    }

    this.conversations.set(conversation.topic, conversation)
    this.messages.set(conversation.topic, [])

    return conversation
  }

  /**
   * Send a message
   */
  async sendMessage(conversationTopic: string, content: string): Promise<XmtpMessage> {
    if (!this.initialized) {
      throw new Error('Mock XMTP client not initialized')
    }

    const conversation = this.conversations.get(conversationTopic)
    if (!conversation) {
      throw new Error('Conversation not found')
    }

    // Simulate async send
    await new Promise(resolve => setTimeout(resolve, 300))

    const message: XmtpMessage = {
      id: `msg-${++this.messageIdCounter}`,
      content: content,
      senderAddress: this.address!,
      sent: new Date(),
      topic: conversationTopic
    }

    // Add to messages
    const topicMessages = this.messages.get(conversationTopic) || []
    topicMessages.push(message)
    this.messages.set(conversationTopic, topicMessages)

    // Trigger any stream callbacks
    const callback = this.streamCallbacks.get(conversationTopic)
    if (callback) {
      setTimeout(() => callback(message), 100)
    }

    return message
  }

  /**
   * Get messages from a conversation
   */
  async getMessages(conversationTopic: string, limit = 100): Promise<XmtpMessage[]> {
    if (!this.initialized) {
      throw new Error('Mock XMTP client not initialized')
    }

    // Simulate async load
    await new Promise(resolve => setTimeout(resolve, 200))

    const messages = this.messages.get(conversationTopic) || []
    return messages.slice(-limit)
  }

  /**
   * Stream messages from all conversations
   */
  async streamAllMessages(
    onMessage: (message: XmtpMessage) => void
  ): Promise<() => void> {
    if (!this.initialized) {
      throw new Error('Mock XMTP client not initialized')
    }

    // Simulate receiving a message every 10 seconds for testing
    const interval = setInterval(() => {
      const conversations = Array.from(this.conversations.values())
      if (conversations.length > 0) {
        const randomConv = conversations[Math.floor(Math.random() * conversations.length)]
        const mockMessage: XmtpMessage = {
          id: `msg-${++this.messageIdCounter}`,
          content: `Mock message ${this.messageIdCounter} from stream`,
          senderAddress: randomConv.peerAddress,
          sent: new Date(),
          topic: randomConv.topic
        }

        // Add to messages
        const topicMessages = this.messages.get(randomConv.topic) || []
        topicMessages.push(mockMessage)
        this.messages.set(randomConv.topic, topicMessages)

        onMessage(mockMessage)
      }
    }, 10000)

    // Return cleanup function
    return () => {
      clearInterval(interval)
    }
  }

  /**
   * Stream messages from a specific conversation
   */
  async streamMessages(
    conversationTopic: string,
    onMessage: (message: XmtpMessage) => void
  ): Promise<() => void> {
    if (!this.initialized) {
      throw new Error('Mock XMTP client not initialized')
    }

    // Store callback for this conversation
    this.streamCallbacks.set(conversationTopic, onMessage)

    // Return cleanup function
    return () => {
      this.streamCallbacks.delete(conversationTopic)
    }
  }

  /**
   * Stream conversations
   */
  async streamConversations(
    onConversation: (conversation: XmtpConversation) => void
  ): Promise<() => void> {
    if (!this.initialized) {
      throw new Error('Mock XMTP client not initialized')
    }

    // For mock, we don't simulate new conversations
    // Return a no-op cleanup function
    return () => {}
  }

  /**
   * Get conversation by peer address
   */
  async getConversationByPeer(peerAddress: string): Promise<XmtpConversation | null> {
    for (const conv of this.conversations.values()) {
      if (conv.peerAddress.toLowerCase() === peerAddress.toLowerCase()) {
        return conv
      }
    }
    return null
  }

  /**
   * Clean up and disconnect
   */
  async disconnect(): Promise<void> {
    this.initialized = false
    this.address = null
    this.conversations.clear()
    this.messages.clear()
    this.streamCallbacks.clear()
    this.messageIdCounter = 0
  }
}

export default new MockXmtpService()