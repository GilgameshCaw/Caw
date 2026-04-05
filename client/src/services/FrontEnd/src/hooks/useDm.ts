import { useCallback, useEffect, useRef, useState } from 'react'
import { useWalletClient } from 'wagmi'
import { apiFetch, API_HOST, getAuthHeaders } from '~/api/client'
import { useAuthStore } from '~/store/authStore'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import {
  deriveKeyPair,
  computeSharedSecret,
  encrypt,
  decrypt,
  hasCachedKeyPair,
  getCachedPrivateKey,
  getCachedPublicKeyHex,
  clearKeyCache
} from '~/services/DmCryptoService'
import { useDmUnreadStore } from '~/store/dmUnreadStore'

type UiConversation = {
  id: string
  type: 'DM'
  participants: Array<{
    userId: number
    identity: {
      user: {
        username: string
        displayName?: string
        image?: string
        address?: string
        tokenId: number
      }
    }
  }>
  lastMessageAt?: string
  lastMessagePreview?: string // decrypted preview of last message
  lastMessageSenderId?: number
  unreadCount: number
}

type UiMessage = {
  id: string
  content: string
  contentType?: string        // "text" | "deleted"
  editHistory?: Array<{ content: string; editedAt: string }>
  senderId: number
  createdAt: string
  status: string
  conversationId: string
  isFromCurrentUser: boolean
  sender?: {
    user: {
      username: string
      displayName?: string
      avatarUrl?: string
      tokenId: number
    }
  }
}

// Module-level private key reference (never in state to avoid serialization)
let privateKeyRef: Uint8Array | null = null

export function useDmClient(tokenId?: number, username?: string) {
  const { data: walletClient } = useWalletClient()
  const { verify } = useVerifyWallet()

  const [isInitialized, setIsInitialized] = useState(false)
  const [needsKeyDerivation, setNeedsKeyDerivation] = useState(false) // identity exists but keys not in memory
  const [isLoading, setIsLoading] = useState(true) // Start true to avoid flash before identity check
  const [conversationsLoading, setConversationsLoading] = useState(false)
  const [conversationsLoaded, setConversationsLoaded] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [conversations, setConversations] = useState<UiConversation[]>([])
  const checkedTokenIdRef = useRef<number | undefined>(undefined) // tracks which tokenId the current state belongs to

  // Check if already initialized on mount or when tokenId changes
  useEffect(() => {
    // Reset state for new account
    checkedTokenIdRef.current = tokenId
    setIsInitialized(false)
    setNeedsKeyDerivation(false)
    setIsLoading(true)
    setConversations([])

    if (!tokenId) {
      setIsLoading(false)
      return
    }

    // Always verify server has the identity — cached keys alone aren't enough
    // (user may have derived keys but registration may have failed)
    let cancelled = false
    fetch(`${API_HOST}/api/dm/identity/${tokenId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (data.hasIdentity) {
          const isAuthed = useAuthStore.getState().isTokenAuthorized(tokenId)
          if (hasCachedKeyPair(tokenId)) {
            // Keys in cache + server identity = fully ready
            privateKeyRef = getCachedPrivateKey()
            setIsInitialized(true)
            if (isAuthed) loadConversations()
          } else {
            // Server has identity but keys not in memory — need re-derivation
            setIsInitialized(true)
            setNeedsKeyDerivation(true)
            if (isAuthed) loadConversations()
          }
        }
        // If !hasIdentity, leave isInitialized=false so setup view shows
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoading(false) })

    return () => { cancelled = true }
  }, [tokenId])

  const [hasMoreConversations, setHasMoreConversations] = useState(false)

  const loadConversations = useCallback(async (loadMore = false) => {
    if (!tokenId) return

    setConversationsLoading(true)
    try {
      const offset = loadMore ? conversations.length : 0
      const data = await apiFetch<{ conversations: any[]; hasMore?: boolean }>(`/api/dm/conversations?userId=${tokenId}&limit=50&offset=${offset}`)

      const uiConversations: UiConversation[] = await Promise.all(
        (data.conversations || []).map(async (conv: any) => {
          const otherParticipants = conv.participants.filter(
            (p: any) => p.userId !== tokenId
          )

          // Try to decrypt last message preview
          let lastMessagePreview: string | undefined
          let lastMessageSenderId: number | undefined
          if (conv.lastMessage?.contentType === 'deleted') {
            lastMessageSenderId = conv.lastMessage.senderId
            lastMessagePreview = '[Message deleted]'
          } else if (conv.lastMessage?.encryptedPayload && privateKeyRef) {
            lastMessageSenderId = conv.lastMessage.senderId
            try {
              const sharedSecret = await getOrComputeSharedSecret(conv.id, tokenId)
              if (sharedSecret) {
                const decrypted = await decrypt(conv.lastMessage.encryptedPayload, sharedSecret)

                // Detect special content types for preview
                const giphyPattern = /^https?:\/\/(media\d?\.giphy\.com|i\.giphy\.com)\//i
                const imageUrlPattern = /^https?:\/\/\S+\.(gif|jpg|jpeg|png|webp)(\?\S*)?$/i
                try {
                  const parsed = JSON.parse(decrypted)
                  if (parsed.msgType === 'encrypted-attachment') {
                    lastMessagePreview = parsed.type === 'image' ? 'Sent an image' : `Sent a file: ${parsed.name}`
                  } else {
                    lastMessagePreview = decrypted.length > 80 ? decrypted.slice(0, 80) + '…' : decrypted
                  }
                } catch {
                  if (giphyPattern.test(decrypted.trim()) || (imageUrlPattern.test(decrypted.trim()) && decrypted.trim().includes('.gif'))) {
                    lastMessagePreview = 'Sent a GIF'
                  } else if (imageUrlPattern.test(decrypted.trim())) {
                    lastMessagePreview = 'Sent an image'
                  } else {
                    lastMessagePreview = decrypted.length > 80 ? decrypted.slice(0, 80) + '…' : decrypted
                  }
                }
              }
            } catch {
              // Can't decrypt — leave as undefined
            }
          }

          return {
            id: conv.id,
            type: 'DM' as const,
            participants: otherParticipants.map((p: any) => ({
              userId: p.userId,
              identity: {
                user: {
                  username: p.identity?.user?.username || 'Unknown',
                  displayName: p.identity?.user?.displayName,
                  image: p.identity?.user?.avatarUrl,
                  address: p.identity?.user?.address,
                  tokenId: p.userId
                }
              }
            })),
            lastMessageAt: conv.lastMessageAt,
            lastMessagePreview,
            lastMessageSenderId,
            unreadCount: conv.unreadCount || 0
          }
        })
      )

      if (loadMore) {
        setConversations(prev => {
          const merged = [...prev, ...uiConversations]
          useDmUnreadStore.getState().setTotalUnread(
            merged.reduce((sum, c) => sum + c.unreadCount, 0)
          )
          return merged
        })
      } else {
        setConversations(uiConversations)
        useDmUnreadStore.getState().setTotalUnread(
          uiConversations.reduce((sum, c) => sum + c.unreadCount, 0)
        )
      }
      setHasMoreConversations(!!data.hasMore)
      setConversationsLoaded(true)
    } catch (err) {
      console.error('[DM] Failed to load conversations:', err)
      setConversationsLoaded(true)
    } finally {
      setConversationsLoading(false)
    }
  }, [tokenId, conversations.length])

  const initializeClient = useCallback(async () => {
    console.log('[DM] initializeClient called, walletClient:', !!walletClient, 'tokenId:', tokenId)
    if (!walletClient || !tokenId) {
      const err = new Error('Wallet not connected')
      console.log('[DM] No wallet client or tokenId, throwing')
      setError(err)
      throw err
    }

    if (hasCachedKeyPair(tokenId)) {
      console.log('[DM] Keys already cached for this tokenId, checking auth...')
      // Keys are cached but we still need a valid auth session to load conversations
      if (!useAuthStore.getState().isTokenAuthorized(tokenId)) {
        console.log('[DM] Token not authorized, verifying wallet...')
        const ok = await verify()
        if (!ok) throw new Error('Wallet verification was cancelled or failed')
        if (!useAuthStore.getState().isTokenAuthorized(tokenId)) {
          console.warn('[DM] Verified OK but token still not authorized — server may not recognize this wallet as owning any CAW names')
          throw new Error('Your wallet was verified but is not linked to any CAW name. Make sure you are connected with the correct wallet.')
        }
      }
      privateKeyRef = getCachedPrivateKey()

      // Check if the server actually has the identity registered — cached keys
      // don't guarantee registration succeeded (e.g. previous attempt may have failed)
      const identityCheck = await fetch(`${API_HOST}/api/dm/identity/${tokenId}`).then(r => r.json())
      if (!identityCheck.hasIdentity) {
        console.log('[DM] Keys cached but server has no identity — re-registering...')
        const publicKeyHex = getCachedPublicKeyHex()
        if (!publicKeyHex) throw new Error('Cached keys are missing public key — please re-enable DMs')
        await apiFetch('/api/dm/identity', {
          method: 'POST',
          body: JSON.stringify({
            userId: tokenId,
            walletAddress: walletClient!.account.address,
            publicKey: publicKeyHex
          })
        })
        console.log('[DM] Identity re-registered successfully')
      }

      setIsInitialized(true)
      await loadConversations()
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      console.log('[DM] Deriving key pair...')
      const signMessage = async (message: string) => {
        console.log('[DM] Requesting wallet signature for key derivation...')
        const sig = await walletClient.signMessage({
          account: walletClient.account,
          message
        })
        return sig
      }

      const { privateKey, publicKeyHex, rawSignature, sigMessage } = await deriveKeyPair(
        signMessage, tokenId, username
      )
      privateKeyRef = privateKey
      console.log('[DM] Key pair derived, needsKeyDerivation:', needsKeyDerivation)

      // If identity already exists on server, just re-derive keys — no need to
      // re-register or re-verify auth (avoids logging out the other account)
      if (!needsKeyDerivation) {
        // Fresh setup — use the DM signature for both auth + identity registration
        console.log('[DM] Fresh setup — calling verify-dm (combined auth + DM registration)...')
        const sessionToken = useAuthStore.getState().sessionToken
        const res = await fetch(`${API_HOST}/api/auth/verify-dm`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
          },
          body: JSON.stringify({
            signature: rawSignature,
            message: sigMessage,
            userId: tokenId,
            publicKey: publicKeyHex
          })
        })

        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || 'Failed to verify wallet and register DM identity')
        }

        const data = await res.json()

        // Update auth store with session from the combined endpoint
        if (sessionToken && data.sessionToken === sessionToken) {
          useAuthStore.getState().addAuthorization(data.authorizedTokenIds, data.authorizedAddresses)
        } else {
          useAuthStore.getState().setSession(
            data.sessionToken,
            data.authorizedTokenIds,
            data.authorizedAddresses,
            data.expiresAt
          )
        }
        console.log('[DM] Combined auth + DM registration complete')
      }

      setIsInitialized(true)
      setNeedsKeyDerivation(false)
      await loadConversations()
      console.log('[DM] Initialization complete')
    } catch (err) {
      console.error('[DM] initializeClient error:', err)
      setError(err as Error)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [walletClient, tokenId, loadConversations])

  const startConversation = useCallback(async (peerUserId: number) => {
    if (!tokenId) throw new Error('Not initialized')

    // Check peer has DM identity
    const peerData = await apiFetch<{ publicKey: string | null; hasIdentity: boolean }>(
      `/api/dm/identity/${peerUserId}`
    )
    if (!peerData.hasIdentity) {
      throw new Error('This user has not enabled DMs yet')
    }

    // Create/get conversation — use direct fetch to parse structured error bodies
    const convRes = await fetch('/api/dm/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...(tokenId ? { 'x-user-id': String(tokenId) } : {})
      },
      body: JSON.stringify({ userId: tokenId, peerUserId })
    })

    const conversation = await convRes.json()

    if (!convRes.ok) {
      if (conversation.error === 'DM_PRIVACY') {
        const privacyErr = new Error(conversation.message) as any
        privacyErr.code = 'DM_PRIVACY'
        privacyErr.reason = conversation.reason
        privacyErr.peer = conversation.peer
        throw privacyErr
      }
      throw new Error(conversation.error || `API ${convRes.status} ${convRes.statusText}`)
    }

    // Compute shared secret for this conversation if we have the private key
    if (privateKeyRef && peerData.publicKey) {
      await computeSharedSecret(privateKeyRef, peerData.publicKey, conversation.id)
    }

    // Reload conversations to get updated list
    await loadConversations()

    return conversation
  }, [tokenId, loadConversations])

  const clearUnreadCount = useCallback((conversationId: string) => {
    setConversations(prev => {
      const updated = prev.map(c =>
        c.id === conversationId ? { ...c, unreadCount: 0 } : c
      )
      useDmUnreadStore.getState().setTotalUnread(
        updated.reduce((sum, c) => sum + c.unreadCount, 0)
      )
      return updated
    })
  }, [])

  return {
    isInitialized,
    needsKeyDerivation: needsKeyDerivation && checkedTokenIdRef.current === tokenId,
    isLoading,
    conversationsLoading,
    conversationsLoaded,
    error,
    initializeClient,
    conversations,
    hasMoreConversations,
    loadMoreConversations: () => loadConversations(true),
    startConversation,
    clearUnreadCount,
    refreshConversations: loadConversations
  }
}

export function useDmMessages(conversationId: string, tokenId?: number) {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [hasMoreMessages, setHasMoreMessages] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [peerLastReadAt, setPeerLastReadAt] = useState<string | null>(null)

  // Clear messages immediately when conversation changes
  useEffect(() => {
    setMessages([])
    setPeerLastReadAt(null)
    setHasMoreMessages(true)
  }, [conversationId])

  // Load and decrypt messages
  useEffect(() => {
    if (!conversationId || !tokenId) return

    let cancelled = false

    const load = async () => {
      setIsLoading(true)
      try {
        const data = await apiFetch<{ messages: any[], peerLastReadAt: string | null }>(
          `/api/dm/conversations/${conversationId}/messages?userId=${tokenId}`
        )

        if (cancelled) return

        setPeerLastReadAt(data.peerLastReadAt || null)

        // Get peer's public key for this conversation
        const sharedSecret = await getOrComputeSharedSecret(conversationId, tokenId)

        if (!sharedSecret) {
          // Can't decrypt yet — show encrypted messages as-is
          setMessages(data.messages.map((msg: any) => ({
            id: msg.id,
            content: '[Encrypted]',
            senderId: msg.senderId,
            createdAt: msg.createdAt,
            status: msg.status,
            conversationId: msg.conversationId,
            isFromCurrentUser: msg.senderId === tokenId,
            sender: msg.sender ? {
              user: {
                username: msg.sender.user?.username || 'Unknown',
                displayName: msg.sender.user?.displayName,
                avatarUrl: msg.sender.user?.avatarUrl,
                tokenId: msg.senderId
              }
            } : undefined
          })))
          return
        }

        // Decrypt each message
        const decryptedMessages: UiMessage[] = []
        for (const msg of data.messages) {
          // Handle tombstoned (deleted) messages
          if (msg.contentType === 'deleted') {
            decryptedMessages.push({
              id: msg.id,
              content: '',
              contentType: 'deleted',
              senderId: msg.senderId,
              createdAt: msg.createdAt,
              status: msg.status,
              conversationId: msg.conversationId,
              isFromCurrentUser: msg.senderId === tokenId,
              sender: msg.sender ? {
                user: {
                  username: msg.sender.user?.username || 'Unknown',
                  displayName: msg.sender.user?.displayName,
                  avatarUrl: msg.sender.user?.avatarUrl,
                  tokenId: msg.senderId
                }
              } : undefined
            })
            continue
          }

          let content: string
          try {
            content = await decrypt(msg.encryptedPayload, sharedSecret)
          } catch {
            content = '[Unable to decrypt]'
          }

          // Decrypt edit history if present
          let editHistory: Array<{ content: string; editedAt: string }> | undefined
          if (msg.editHistory) {
            try {
              const historyEntries = JSON.parse(msg.editHistory)
              editHistory = []
              for (const entry of historyEntries) {
                const parsed = JSON.parse(entry)
                try {
                  const decryptedContent = await decrypt(parsed.encryptedPayload, sharedSecret)
                  editHistory.push({ content: decryptedContent, editedAt: parsed.editedAt })
                } catch {
                  editHistory.push({ content: '[Unable to decrypt]', editedAt: parsed.editedAt })
                }
              }
            } catch {}
          }

          decryptedMessages.push({
            id: msg.id,
            content,
            contentType: msg.contentType,
            editHistory,
            senderId: msg.senderId,
            createdAt: msg.createdAt,
            status: msg.status,
            conversationId: msg.conversationId,
            isFromCurrentUser: msg.senderId === tokenId,
            sender: msg.sender ? {
              user: {
                username: msg.sender.user?.username || 'Unknown',
                displayName: msg.sender.user?.displayName,
                avatarUrl: msg.sender.user?.avatarUrl,
                tokenId: msg.senderId
              }
            } : undefined
          })
        }

        if (!cancelled) {
          setMessages(decryptedMessages)
          setHasMoreMessages(data.messages.length >= 50) // If we got a full page, there might be more
        }
      } catch (err) {
        console.error('[DM] Failed to load messages:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [conversationId, tokenId])

  const sendMessage = useCallback(async (content: string) => {
    if (!conversationId || !tokenId) return

    setIsSending(true)
    try {
      const sharedSecret = await getOrComputeSharedSecret(conversationId, tokenId)
      if (!sharedSecret) throw new Error('Cannot encrypt: encryption key not available. Try re-enabling DMs.')

      const encryptedPayload = await encrypt(content, sharedSecret)

      // Use direct fetch instead of apiFetch so we can parse structured error bodies
      const res = await fetch('/api/dm/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
          ...(tokenId ? { 'x-user-id': String(tokenId) } : {})
        },
        body: JSON.stringify({
          conversationId,
          senderId: tokenId,
          encryptedPayload,
          contentType: 'text'
        })
      })

      const msg = await res.json()

      if (!res.ok) {
        if (msg.error === 'DM_PRIVACY') {
          const privacyErr = new Error(msg.message) as any
          privacyErr.code = 'DM_PRIVACY'
          privacyErr.reason = msg.reason
          privacyErr.peer = msg.peer
          throw privacyErr
        }
        throw new Error(msg.error || `API ${res.status} ${res.statusText}`)
      }

      // Add decrypted message to local state optimistically
      setMessages(prev => [...prev, {
        id: msg.id,
        content,
        senderId: tokenId,
        createdAt: msg.createdAt,
        status: 'SENT',
        conversationId,
        isFromCurrentUser: true,
        sender: msg.sender ? {
          user: {
            username: msg.sender.user?.username || 'Unknown',
            displayName: msg.sender.user?.displayName,
            avatarUrl: msg.sender.user?.avatarUrl,
            tokenId
          }
        } : undefined
      }])
    } finally {
      setIsSending(false)
    }
  }, [conversationId, tokenId])

  const markAsRead = useCallback(async () => {
    if (!tokenId || messages.length === 0) return

    const unreadIds = messages
      .filter(m => !m.isFromCurrentUser)
      .map(m => m.id)

    if (unreadIds.length === 0) return

    try {
      await apiFetch('/api/dm/messages/read', {
        method: 'POST',
        body: JSON.stringify({ messageIds: unreadIds, userId: tokenId })
      })
    } catch (err) {
      console.error('[DM] Failed to mark messages as read:', err)
    }
  }, [tokenId, messages])

  // Handle incoming WebSocket messages
  const addIncomingMessage = useCallback(async (encryptedMsg: any) => {
    if (encryptedMsg.conversationId !== conversationId) return
    if (encryptedMsg.senderId === tokenId) return // Skip own messages

    try {
      const sharedSecret = await getOrComputeSharedSecret(conversationId, tokenId!)
      let content = '[Encrypted]'
      if (sharedSecret) {
        try {
          content = await decrypt(encryptedMsg.encryptedPayload, sharedSecret)
        } catch {
          content = '[Unable to decrypt]'
        }
      }

      setMessages(prev => {
        if (prev.some(m => m.id === encryptedMsg.id)) return prev
        return [...prev, {
          id: encryptedMsg.id,
          content,
          senderId: encryptedMsg.senderId,
          createdAt: encryptedMsg.createdAt,
          status: encryptedMsg.status || 'SENT',
          conversationId: encryptedMsg.conversationId,
          isFromCurrentUser: false,
          sender: encryptedMsg.sender ? {
            user: {
              username: encryptedMsg.sender.user?.username || 'Unknown',
              displayName: encryptedMsg.sender.user?.displayName,
              avatarUrl: encryptedMsg.sender.user?.avatarUrl,
              tokenId: encryptedMsg.senderId
            }
          } : undefined
        }]
      })
    } catch (err) {
      console.error('[DM] Failed to process incoming message:', err)
    }
  }, [conversationId, tokenId])

  const loadOlderMessages = useCallback(async () => {
    if (!conversationId || !tokenId || isLoadingOlder || !hasMoreMessages || messages.length === 0) return

    const oldestMessage = messages[0]
    setIsLoadingOlder(true)

    try {
      const data = await apiFetch<{ messages: any[] }>(
        `/api/dm/conversations/${conversationId}/messages?userId=${tokenId}&before=${oldestMessage.id}`
      )

      if (data.messages.length === 0) {
        setHasMoreMessages(false)
        return
      }

      if (data.messages.length < 50) {
        setHasMoreMessages(false)
      }

      const sharedSecret = await getOrComputeSharedSecret(conversationId, tokenId)
      if (!sharedSecret) return

      const decrypted: UiMessage[] = []
      for (const msg of data.messages) {
        if (msg.contentType === 'deleted') {
          decrypted.push({
            id: msg.id, content: '', contentType: 'deleted',
            senderId: msg.senderId, createdAt: msg.createdAt, status: msg.status,
            conversationId: msg.conversationId, isFromCurrentUser: msg.senderId === tokenId,
            sender: msg.sender ? { user: { username: msg.sender.user?.username || 'Unknown', displayName: msg.sender.user?.displayName, avatarUrl: msg.sender.user?.avatarUrl, tokenId: msg.senderId } } : undefined
          })
          continue
        }

        let content: string
        try { content = await decrypt(msg.encryptedPayload, sharedSecret) } catch { content = '[Unable to decrypt]' }

        let editHistory: Array<{ content: string; editedAt: string }> | undefined
        if (msg.editHistory) {
          try {
            const entries = JSON.parse(msg.editHistory)
            editHistory = []
            for (const entry of entries) {
              const parsed = JSON.parse(entry)
              try { editHistory.push({ content: await decrypt(parsed.encryptedPayload, sharedSecret), editedAt: parsed.editedAt }) }
              catch { editHistory.push({ content: '[Unable to decrypt]', editedAt: parsed.editedAt }) }
            }
          } catch {}
        }

        decrypted.push({
          id: msg.id, content, contentType: msg.contentType, editHistory,
          senderId: msg.senderId, createdAt: msg.createdAt, status: msg.status,
          conversationId: msg.conversationId, isFromCurrentUser: msg.senderId === tokenId,
          sender: msg.sender ? { user: { username: msg.sender.user?.username || 'Unknown', displayName: msg.sender.user?.displayName, avatarUrl: msg.sender.user?.avatarUrl, tokenId: msg.senderId } } : undefined
        })
      }

      // Prepend older messages
      setMessages(prev => [...decrypted, ...prev])
    } catch (err) {
      console.error('[DM] Failed to load older messages:', err)
    } finally {
      setIsLoadingOlder(false)
    }
  }, [conversationId, tokenId, isLoadingOlder, hasMoreMessages, messages])

  const getSharedSecret = useCallback(async (): Promise<CryptoKey | null> => {
    if (!conversationId || !tokenId) return null
    return getOrComputeSharedSecret(conversationId, tokenId)
  }, [conversationId, tokenId])

  const editMessage = useCallback(async (messageId: string, newContent: string) => {
    if (!conversationId || !tokenId) return

    const sharedSecret = await getOrComputeSharedSecret(conversationId, tokenId)
    if (!sharedSecret) throw new Error('Cannot encrypt')

    // Find original message to pass its encrypted payload as history
    const original = messages.find(m => m.id === messageId)
    const previousEncryptedPayload = original ? await encrypt(original.content, sharedSecret) : undefined

    const encryptedPayload = await encrypt(newContent, sharedSecret)

    await apiFetch(`/api/dm/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ encryptedPayload, previousEncryptedPayload })
    })

    // Update local state
    setMessages(prev => prev.map(m =>
      m.id === messageId
        ? { ...m, content: newContent, editHistory: [...(m.editHistory || []), { content: m.content, editedAt: new Date().toISOString() }] }
        : m
    ))
  }, [conversationId, tokenId, messages])

  const deleteForMe = useCallback(async (messageId: string) => {
    if (!tokenId) return

    await apiFetch(`/api/dm/messages/${messageId}/hide`, {
      method: 'POST',
      body: JSON.stringify({ userId: tokenId })
    })

    // Remove from local state
    setMessages(prev => prev.filter(m => m.id !== messageId))
  }, [tokenId])

  const deleteForEveryone = useCallback(async (messageId: string) => {
    await apiFetch(`/api/dm/messages/${messageId}`, {
      method: 'DELETE'
    })

    // Replace with tombstone in local state
    setMessages(prev => prev.map(m =>
      m.id === messageId
        ? { ...m, content: '', contentType: 'deleted', editHistory: undefined }
        : m
    ))
  }, [])

  return { messages, isLoading, isLoadingOlder, hasMoreMessages, loadOlderMessages, isSending, sendMessage, editMessage, deleteForMe, deleteForEveryone, markAsRead, addIncomingMessage, peerLastReadAt, getSharedSecret }
}

/**
 * Get or compute the shared secret for a conversation.
 * Fetches the peer's public key if needed.
 */
async function getOrComputeSharedSecret(
  conversationId: string,
  currentUserId: number
): Promise<CryptoKey | null> {
  if (!privateKeyRef) return null

  try {
    // Fetch conversation participants to find the peer
    const data = await apiFetch<{ conversations: any[] }>(`/api/dm/conversations?userId=${currentUserId}`)
    const conv = data.conversations?.find((c: any) => c.id === conversationId)
    if (!conv) return null

    const peer = conv.participants.find((p: any) => p.userId !== currentUserId)
    if (!peer) return null

    // Get peer's public key
    const peerData = await fetch(`${API_HOST}/api/dm/identity/${peer.userId}`).then(r => r.json())
    if (!peerData.publicKey) return null

    return computeSharedSecret(privateKeyRef, peerData.publicKey, conversationId)
  } catch (err) {
    console.error('[DM] Failed to compute shared secret:', err)
    return null
  }
}
