import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { formatWalletError } from '~/utils/errorMessage'
import { useSearchParams, useParams, useNavigate } from 'react-router-dom'
import ConnectButton from '~/components/buttons/ConnectButton'
import Tooltip from '~/components/Tooltip'
import ModalWrapper from '~/components/modals/ModalWrapper'
import { apiFetch, API_HOST } from '~/api/client'
import { getUserAvatar } from '~/utils/defaultAvatar'
import Avatar from '~/components/Avatar'
import {
  HiOutlineCog,
  HiOutlineMail,
  HiOutlineX,
  HiOutlineSearch,
  HiOutlineDotsHorizontal,
  HiOutlineUserRemove,
  HiOutlineVolumeOff,
  HiOutlineExclamation,
  HiOutlineShieldCheck,
  HiOutlineLockClosed,
  HiOutlineCheckCircle,
  HiOutlinePaperClip,
  HiOutlinePlus,
  HiOutlineReply
} from 'react-icons/hi'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import {
  useDmClient,
  useDmMessages,
  type UiMessage
} from '~/hooks/useDm'
import { useDmWebSocket } from '~/hooks/useDmWebSocket'
import { useMessageNotifications, useTypingStatus } from '~/hooks/useMessageNotifications'
import { formatDistanceToNow } from 'date-fns'
import MessageSearch from '~/components/MessageSearch'
import GifPicker from '~/components/GifPicker'
import EncryptedImage from '~/components/EncryptedImage'
import { useDmFileUpload } from '~/hooks/useDmFileUpload'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'
import { useDmMuteStore } from '~/store/dmMuteStore'
import MuteConfirmModal from '~/components/modals/MuteConfirmModal'
import ReportUserModal from '~/components/modals/ReportUserModal'
import { FollowButton } from '~/components/FollowButton'
import {
  MessageReactionStrip,
  MessageReactionsBar,
  EmojiPickerModal,
  CustomizeReactionsModal,
  DEFAULT_DM_REACTIONS,
} from '~/components/dm/MessageReactions'

const MessagesPage: React.FC = () => {
  const { isDark } = useTheme()
  const ensureWallet = useEnsureWallet()
  const activeToken = useActiveToken()
  const currentUser = activeToken ? { id: activeToken.tokenId, username: activeToken.username } : null
  const { username: urlUsername } = useParams<{ username?: string }>()
  const navigate = useNavigate()
  const [isNewMessageModalOpen, setIsNewMessageModalOpen] = useState(false)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dmPrivacy, setDmPrivacy] = useState<'EVERYONE' | 'FOLLOWERS' | 'FOLLOWING'>('EVERYONE')
  const [dmPrivacyLoaded, setDmPrivacyLoaded] = useState(false)
  const [dmPrivacyError, setDmPrivacyError] = useState<{ message: string; reason: string; peer: any } | null>(null)
  // User's customized 5-emoji default reaction strip. Empty = use the
  // server defaults (DEFAULT_DM_REACTIONS).
  const [defaultReactions, setDefaultReactions] = useState<string[]>([])
  // Modals invoked from the reaction strip.
  const [emojiPickerForMessage, setEmojiPickerForMessage] = useState<string | null>(null)
  // Which message currently has its quick-reaction strip open.
  // On desktop this is toggled by the smiley trigger; on mobile we open
  // it via long-press on the bubble.
  const [reactionStripForMessage, setReactionStripForMessage] = useState<string | null>(null)

  // Long-press state for opening reactions on touch devices.
  const longPressRef = useRef<{ timer: number | null; messageId: string | null; pointerId: number | null; startX: number; startY: number; fired: boolean }>({
    timer: null,
    messageId: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    fired: false,
  })
  // Toggles the full emoji picker for the *composer* (vs. reactions).
  // Picking from it inserts the emoji into the textarea, mirroring the
  // small inline strip's behavior.
  const [composerEmojiPickerOpen, setComposerEmojiPickerOpen] = useState(false)
  const [showCustomizeReactions, setShowCustomizeReactions] = useState(false)
  const [selectedUser, setSelectedUser] = useState<{name: string, handle: string, avatar: string} | null>(null)
  const [modalStep, setModalStep] = useState<'select' | 'compose'>('select')
  const [newMessageSearch, setNewMessageSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ tokenId: number, username: string, displayName?: string, avatarUrl?: string, hasDmIdentity?: boolean }>>([])
  const [recentFollows, setRecentFollows] = useState<Array<{ tokenId: number, username: string, displayName?: string, avatarUrl?: string, hasDmIdentity?: boolean }>>([])
  const [isSearching, setIsSearching] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [currentView, setCurrentView] = useState<'inbox' | 'chat' | 'setup' | 'signin'>('inbox')
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [newMessageContent, setNewMessageContent] = useState('')
  const pendingMessageRef = useRef<string | null>(null)
  const [showChatOptionsMenu, setShowChatOptionsMenu] = useState(false)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [showFileUpload, setShowFileUpload] = useState(false)
  const [showGifPicker, setShowGifPicker] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [gifPreview, setGifPreview] = useState<{ url: string; preview: string } | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [filePreview, setFilePreview] = useState<{ file: File; previewUrl: string; isImage: boolean } | null>(null)
  const [chatSharedSecret, setChatSharedSecret] = useState<CryptoKey | null>(null)
  const [chatReady, setChatReady] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number; isOwn: boolean; createdAt: string } | null>(null)
  // ID of the message we're replying to. Cleared on send, on Escape, or
  // when the user X's the chip. Sent as plaintext to the server alongside
  // the encrypted body — the server already knows the conversation graph,
  // so the link adds no meaningful disclosure.
  const [replyingToId, setReplyingToId] = useState<string | null>(null)
  // Message ID we want to flash-highlight after scrolling — set when the
  // user taps a quoted preview. Cleared after the animation settles.
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null)
  const [errorModal, setErrorModal] = useState<{ title: string; message: string } | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [editHistoryMessageId, setEditHistoryMessageId] = useState<string | null>(null)
  const [showBlockConfirm, setShowBlockConfirm] = useState(false)
  const [showReportUser, setShowReportUser] = useState(false)
  const { blockUser, getBlockedUserIds } = useBlockedUsersStore()
  const { muteConversation, unmuteConversation, isMuted: isConversationMuted } = useDmMuteStore()

  const [isTyping, setIsTyping] = useState(false)
  const typingTimeoutRef = useRef<NodeJS.Timeout>()
  const chatMenuRef = useRef<HTMLDivElement>(null)
  const [targetUser, setTargetUser] = useState<{ tokenId: number, username: string } | null>(null)
  const [attemptedConversations, setAttemptedConversations] = useState<Set<string>>(new Set())
  const messagesContainerRef = useRef<HTMLDivElement>(null)

  // Auth state
  const { verify, isVerifying, error: verifyError } = useVerifyWallet()
  const authorizedAddresses = useAuthStore(s => s.authorizedAddresses)
  const isWalletAuthorized = !!activeToken?.address && authorizedAddresses.includes(activeToken.address.toLowerCase())

  // Get wallet address from wagmi
  const { address } = useAccount()

  // Detect wallet mismatch: connected wallet differs from token owner
  const tokenOwner = activeToken?.owner?.toLowerCase()
  const connectedAddress = address?.toLowerCase()
  const isWrongWallet = !!connectedAddress && !!tokenOwner && connectedAddress !== tokenOwner
  const { openConnectModal } = useConnectModal()

  // Get URL parameters
  const [searchParams, setSearchParams] = useSearchParams()

  // Load DM privacy setting
  useEffect(() => {
    if (!currentUser?.id || dmPrivacyLoaded) return
    apiFetch<{ dmPrivacy: 'EVERYONE' | 'FOLLOWERS' | 'FOLLOWING'; defaultDmReactions?: string[] }>(
      `/api/dm/settings?userId=${currentUser.id}`
    ).then(data => {
      setDmPrivacy(data.dmPrivacy)
      setDefaultReactions(data.defaultDmReactions || [])
      setDmPrivacyLoaded(true)
    }).catch(() => setDmPrivacyLoaded(true))
  }, [currentUser?.id, dmPrivacyLoaded])

  // DM hooks
  const {
    isInitialized: identity,
    needsKeyDerivation,
    isLoading: identityLoading,
    conversationsLoading,
    conversationsLoaded,
    initializeClient,
    conversations,
    hasMoreConversations,
    loadMoreConversations,
    error: dmError,
    startConversation: dmStartConversation,
    refreshConversations,
    clearUnreadCount
  } = useDmClient(currentUser?.id, currentUser?.username)
  // Keep a ref to the latest initializeClient so the action passed into
  // ensureWallet (which runs asynchronously after connect) always calls
  // the freshest closure — the one that sees walletClient populated. The
  // closure captured at click time sees walletClient=undefined and throws
  // "Wallet not connected".
  const initializeClientRef = useRef(initializeClient)
  useEffect(() => { initializeClientRef.current = initializeClient }, [initializeClient])
  // Peer userId for the currently-selected conversation, computed from the
  // conversations list. Threaded into useDmMessages so the encrypt path
  // can reach the peer's publicKey directly — without it, the legacy
  // fallback queries /api/dm/conversations and finds nothing for brand-
  // new conversations (the inbox query filters out empty ones), which
  // surfaces as "Cannot encrypt: encryption key not available" on the
  // user's first message.
  const selectedPeerUserId = (() => {
    const c = conversations.find(cv => cv.id === selectedConversationId)
    if (!c || c.type !== 'DM') return undefined
    return c.participants.find(p => p.userId !== currentUser?.id)?.userId
  })()
  const { messages, isLoadingOlder, hasMoreMessages, loadOlderMessages, sendMessage: dmSendMessage, editMessage: dmEditMessage, deleteForMe: dmDeleteForMe, deleteForEveryone: dmDeleteForEveryone, isSending, markAsRead, addIncomingMessage, peerLastReadAt, getSharedSecret, toggleReaction: dmToggleReaction, applyReactionEvent } = useDmMessages(selectedConversationId || '', currentUser?.id, selectedPeerUserId)
  const { uploadEncryptedFile, isUploading, uploadProgress } = useDmFileUpload()

  // Scroll to bottom of messages
  const scrollToBottom = useCallback((instant = false) => {
    const doScroll = () => {
      const el = messagesContainerRef.current
      if (el) {
        if (instant) {
          el.scrollTop = el.scrollHeight
        } else {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        }
      }
    }
    setTimeout(doScroll, 50)
  }, [])

  // Reset chatReady when conversation changes, then scroll + fade in on load
  useEffect(() => {
    setChatReady(false)
  }, [selectedConversationId])

  // Auto-scroll when messages change
  useEffect(() => {
    if (!chatReady && messages.length > 0) {
      // Initial load — scroll instantly, then fade in
      scrollToBottom(true)
      setTimeout(() => setChatReady(true), 100)
    } else if (chatReady) {
      // New message arrived — smooth scroll
      scrollToBottom(false)
    }
  }, [messages.length, scrollToBottom, chatReady])

  // Resolve shared secret for current conversation (used by EncryptedImage)
  useEffect(() => {
    setChatSharedSecret(null)
    if (!selectedConversationId) return
    let cancelled = false
    getSharedSecret().then(secret => {
      if (!cancelled) setChatSharedSecret(secret)
    })
    return () => { cancelled = true }
  }, [selectedConversationId, getSharedSecret])

  // Send pending message after conversation selection takes effect
  useEffect(() => {
    if (pendingMessageRef.current && selectedConversationId) {
      const msg = pendingMessageRef.current
      pendingMessageRef.current = null
      // Small delay to ensure the hook is fully bound to the new conversation
      setTimeout(() => dmSendMessage(msg), 100)
    }
  }, [selectedConversationId, dmSendMessage])

  // Debug: Log conversations when they change
  useEffect(() => {
    console.log('Messages.tsx: conversations updated:', conversations);
    console.log('Messages.tsx: conversations.length:', conversations.length);
  }, [conversations])

  // WebSocket integration
  const {
    isConnected,
    joinConversation,
    leaveConversation,
    sendTyping,
    markMessagesRead
  } = useDmWebSocket({
    userId: currentUser?.id,
    username: currentUser?.username,
    enabled: !!currentUser && !!identity,
    onNewMessage: addIncomingMessage,
    onReaction: applyReactionEvent,
  })

  // Notifications
  const { areNotificationsEnabled, requestPermission } = useMessageNotifications({
    userId: currentUser?.id,
    username: currentUser?.username,
    enabled: !!currentUser && !!identity,
    onNewMessage: (message) => {
      console.log('New message notification:', message)
    }
  })

  // Typing status for current conversation
  const { isTyping: otherUserTyping } = useTypingStatus(selectedConversationId || '')

  // Function to handle user selection
  const handleUserSelect = (user: {name: string, handle: string, avatar: string}) => {
    setSelectedUser(user)
  }

  // Function to reset modal state
  const resetModal = () => {
    setSelectedUser(null)
    setModalStep('select')
    setMessageText('')
    setSearchQuery('')
    setNewMessageSearch('')
    setSearchResults([])
    setRecentFollows([])
  }

  // Function to close modal and reset state
  const closeModal = () => {
    setIsNewMessageModalOpen(false)
    resetModal()
  }


  // Handle selecting a user to message
  const handleSelectUserToMessage = async (user: { tokenId: number, username: string, displayName?: string, avatarUrl?: string }) => {
    console.log('[Messages] User selected to message:', user)
    console.log('[Messages] User tokenId:', user.tokenId, 'username:', user.username)

    // Store selected user and move to compose step
    setSelectedUser({
      name: user.displayName || user.username,
      handle: user.username,
      avatar: getUserAvatar(user)
    })
    setTargetUser({ tokenId: user.tokenId, username: user.username })

    console.log('[Messages] targetUser set to:', { tokenId: user.tokenId, username: user.username })
    setModalStep('compose')
  }

  // Handle sending the message
  const handleSendNewMessage = async () => {
    if (!targetUser || !messageText.trim()) return

    console.log('[Messages] handleSendNewMessage called with targetUser:', targetUser)

    closeModal()

    // Check if conversation already exists
    const existingConv = conversations.find(c =>
      c.participants.some(p => p.identity.user.tokenId === targetUser.tokenId)
    )

    console.log('[Messages] Existing conversation found:', !!existingConv)

    if (existingConv) {
      // Open existing conversation and queue the message
      pendingMessageRef.current = messageText.trim()
      handleConversationSelect(existingConv.id)
    } else {
      // Start new conversation
      try {
        const newConv = await dmStartConversation(targetUser.tokenId)
        console.log('New conversation created:', newConv)
        // Select the new conversation and queue the message
        pendingMessageRef.current = messageText.trim()
        handleConversationSelect(newConv.id)
      } catch (err: any) {
        console.error('Failed to start conversation:', err)
        if (err.code === 'DM_PRIVACY') {
          setDmPrivacyError({ message: err.message, reason: err.reason, peer: err.peer })
        } else if (err.message?.includes('not enabled DMs')) {
          setErrorModal({ title: 'DMs Not Enabled', message: `@${targetUser.username} hasn't enabled DMs yet. They need to enable DMs before you can message them.` })
        } else {
          setErrorModal({ title: 'Conversation Failed', message: err.message || 'Failed to start conversation.' })
        }
      }
    }
  }

  // Selected conversation details
  const selectedConversation = useMemo(() => {
    return conversations.find(c => c.id === selectedConversationId)
  }, [conversations, selectedConversationId])

  // Other participant in DM
  const otherParticipant = useMemo(() => {
    if (!selectedConversation || selectedConversation.type !== 'DM') return null
    return selectedConversation.participants.find(p => p.userId !== currentUser?.id)
  }, [selectedConversation, currentUser])

  // Function to handle conversation selection
  const handleConversationSelect = (conversationId: string) => {
    // Leave previous conversation room
    if (selectedConversationId) {
      leaveConversation(selectedConversationId)
    }

    setSelectedConversationId(conversationId)
    setCurrentView('chat')

    // Zero out unread badge immediately in the UI
    clearUnreadCount(conversationId)

    // Join new conversation room
    joinConversation(conversationId)

    // Navigate to /messages/:username for the other participant
    const conversation = conversations.find(c => c.id === conversationId)
    if (conversation?.type === 'DM') {
      const other = conversation.participants.find(p => p.userId !== currentUser?.id)
      const otherUsername = other?.identity?.user?.username
      if (otherUsername) {
        navigate(`/messages/${otherUsername}`, { replace: true })
      }
    }
  }

  // Mark messages as read when they load for the selected conversation
  useEffect(() => {
    if (selectedConversationId && messages.length > 0) {
      markAsRead()
    }
  }, [selectedConversationId, messages.length])

  // Function to go back to inbox
  const goBackToInbox = () => {
    // Leave conversation room
    if (selectedConversationId) {
      leaveConversation(selectedConversationId)
    }

    setCurrentView('inbox')
    setSelectedConversationId(null)
    setShowChatOptionsMenu(false)
    navigate('/messages', { replace: true })

    // Refresh conversations to show latest messages
    refreshConversations()
  }

  // Render a short text preview for a message — used by the reply chip
  // and the in-bubble quoted preview. Mirrors the message-bubble render
  // logic just enough to give a useful one-liner: text uses raw chars,
  // attachments collapse to a generic label, encrypted-attachment JSON
  // collapses by mimeType.
  const previewForMessage = (m: UiMessage | undefined): string => {
    if (!m) return 'Original message unavailable'
    if (m.contentType === 'deleted') return 'Deleted message'
    const c = m.content || ''
    try {
      const parsed = JSON.parse(c)
      if (parsed?.msgType === 'encrypted-attachment') {
        const mt = String(parsed.mimeType || '')
        if (mt.startsWith('image/')) return '📷 Image'
        if (mt.startsWith('video/')) return '🎥 Video'
        return `📎 ${parsed.name || 'Attachment'}`
      }
      if (parsed?.text) return String(parsed.text).slice(0, 80)
    } catch {}
    return c.slice(0, 80)
  }

  // Scroll to a message by id and briefly highlight it. Used when the
  // user taps the quoted preview above a reply.
  const scrollToMessage = (messageId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightMessageId(messageId)
    setTimeout(() => {
      setHighlightMessageId(prev => (prev === messageId ? null : prev))
    }, 1400)
  }

  // Handle send message
  const handleSendMessage = async () => {
    if (!newMessageContent.trim() || !selectedConversationId) return

    const content = newMessageContent.trim()
    setNewMessageContent('')
    setShowEmojiPicker(false)
    const replyTo = replyingToId
    setReplyingToId(null)

    // Stop typing indicator
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }
    sendTyping(selectedConversationId, false)

    try {
      console.log('[Messages] Sending message to conversation:', selectedConversationId)
      await dmSendMessage(content, replyTo || undefined)
      console.log('[Messages] Message sent successfully')
      // Force a scroll-to-bottom on send. The existing messages.length
      // effect *should* fire when dmSendMessage flushes the new bubble
      // into state, but the timing is racy: if the bubble's first paint
      // (or any image inside it) lands after the 50ms scrollToBottom
      // setTimeout, the scroll happens against the pre-bubble height
      // and the user's own message ends up just below the visible
      // viewport. rAF + a longer fallback ensures we land on the
      // post-layout height.
      requestAnimationFrame(() => scrollToBottom(false))
      setTimeout(() => scrollToBottom(false), 200)
    } catch (err: any) {
      console.log('[Messages] Send message error:', err.code, err.message, err.reason, err.peer)
      if (err.code === 'DM_PRIVACY') {
        setDmPrivacyError({ message: err.message, reason: err.reason, peer: err.peer })
      } else {
        setErrorModal({ title: 'Message Failed', message: err.message || 'Failed to send message.' })
      }
    }
  }

  // Stage a file for preview before sending
  const handleFileSelected = (files: FileList | File[]) => {
    const file = Array.from(files)[0]
    if (!file) return
    setUploadError(null)
    const isImage = file.type.startsWith('image/')
    const previewUrl = isImage ? URL.createObjectURL(file) : ''
    setFilePreview({ file, previewUrl, isImage })
  }

  // Actually encrypt and send the staged file
  const handleSendFile = async () => {
    if (!filePreview || !selectedConversationId || !currentUser?.id) return
    setUploadError(null)

    try {
      const secret = await getSharedSecret()
      if (!secret) {
        setUploadError('Cannot encrypt: encryption key not available')
        return
      }

      const attachment = await uploadEncryptedFile(filePreview.file, secret, currentUser.id)
      if (!attachment) return

      const msg = JSON.stringify({ msgType: 'encrypted-attachment', ...attachment })
      await dmSendMessage(msg)
      // Clean up preview
      if (filePreview.previewUrl) URL.revokeObjectURL(filePreview.previewUrl)
      setFilePreview(null)
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed')
    }
  }

  const handleCancelFilePreview = () => {
    if (filePreview?.previewUrl) URL.revokeObjectURL(filePreview.previewUrl)
    setFilePreview(null)
    setUploadError(null)
  }

  // Handle drag and drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (currentView === 'chat') setIsDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (currentView === 'chat' && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files)
    }
  }

  // Handle typing indicator
  const handleInputChange = (value: string) => {
    setNewMessageContent(value)

    if (!selectedConversationId) return

    // Send typing indicator
    if (!isTyping) {
      setIsTyping(true)
      sendTyping(selectedConversationId, true)
    }

    // Clear previous timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }

    // Set new timeout to stop typing indicator
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false)
      sendTyping(selectedConversationId, false)
    }, 2000)
  }

  const emojiOnlyTextClass = (text: string): string => {
    const t = (text ?? '').trim()
    if (!t) return 'text-sm'

    // Emoji-only messages should render larger (WhatsApp/Twitter style)
    const emojiOnly = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200D|\uFE0F|\s)+$/u.test(t)
    if (!emojiOnly) return 'text-sm'

    const emojiCount = (t.match(/\p{Extended_Pictographic}/gu) ?? []).length
    if (emojiCount <= 0) return 'text-sm'
    if (emojiCount === 1) return 'text-5xl leading-none'
    if (emojiCount === 2) return 'text-4xl leading-none'
    if (emojiCount <= 4) return 'text-3xl leading-none'
    return 'text-xl leading-tight'
  }

  // Redirect legacy ?user= param to /messages/:username
  useEffect(() => {
    const userParam = searchParams.get('user')
    if (userParam) {
      navigate(`/messages/${userParam}`, { replace: true })
    }
  }, [searchParams, navigate])


  // Handle /messages/:username URL param — open conversation with that user.
  // We must wait for conversationsLoaded before deciding existing-vs-new,
  // otherwise a refresh lands before conversations arrive, we go down the
  // "create" path for one that already exists, and on success we'd no-op.
  // Only mark as attempted AFTER we actually make the create call, so the
  // guard doesn't poison subsequent re-runs triggered by conversations loading.
  useEffect(() => {
    if (!urlUsername || !currentUser || !identity || identityLoading) return
    if (!conversationsLoaded) return

    // Check if we already have this conversation (now that we know for sure)
    const existingConv = conversations.find(c =>
      c.type === 'DM' &&
      c.participants.some(p => p.identity?.user?.username?.toLowerCase() === urlUsername.toLowerCase())
    )

    if (existingConv) {
      if (selectedConversationId !== existingConv.id) {
        if (selectedConversationId) leaveConversation(selectedConversationId)
        setSelectedConversationId(existingConv.id)
        setCurrentView('chat')
        joinConversation(existingConv.id)
      }
      return
    }

    // No existing conversation — create one. Guard so we don't spam the API
    // if the effect re-runs (e.g. conversations list updates again).
    if (attemptedConversations.has(urlUsername)) return
    setAttemptedConversations(prev => new Set(prev).add(urlUsername))

    apiFetch<{ tokenId: number; username: string; displayName?: string; avatarUrl?: string; error?: string }>(
      `/api/users/${urlUsername}`
    )
      .then(userData => {
        if (!userData || userData.error) {
          setErrorModal({ title: 'User Not Found', message: `We couldn't find @${urlUsername}.` })
          return
        }
        setTargetUser({ tokenId: userData.tokenId, username: userData.username })
        return dmStartConversation(userData.tokenId)
          .then((newConv: any) => {
            setSelectedConversationId(newConv.id)
            setCurrentView('chat')
            joinConversation(newConv.id)
          })
          .catch((err: any) => {
            console.error('Failed to create conversation:', err)
            if (err.code === 'DM_PRIVACY') {
              setDmPrivacyError({ message: err.message, reason: err.reason, peer: err.peer })
            } else if (/DM/i.test(err?.message || '') && /enabled/i.test(err?.message || '')) {
              setErrorModal({ title: 'DMs Not Enabled', message: `@${userData.username} hasn't enabled DMs yet. They need to enable DMs before you can message them.` })
            } else {
              setErrorModal({ title: 'Conversation Failed', message: err?.message || 'Failed to start conversation.' })
            }
          })
      })
      .catch(err => {
        console.error('Failed to fetch user for DM:', err)
        setErrorModal({ title: 'Could Not Open DM', message: err?.message || 'Something went wrong loading that user.' })
      })
  }, [urlUsername, currentUser, identity, identityLoading, conversationsLoaded, conversations, attemptedConversations, dmStartConversation, selectedConversationId])

  // When URL changes to /messages (no username), reset to inbox
  useEffect(() => {
    if (!urlUsername && currentView === 'chat') {
      if (selectedConversationId) {
        leaveConversation(selectedConversationId)
      }
      setCurrentView('inbox')
      setSelectedConversationId(null)
      setShowChatOptionsMenu(false)
    }
  }, [urlUsername])

  // Reset to inbox when user switches accounts mid-session. Skips the
  // initial mount (when currentUser goes null→real) so refreshing on
  // /messages/:username doesn't get yanked back to /messages.
  const previousUserIdRef = useRef<number | null | undefined>(undefined)
  useEffect(() => {
    const prev = previousUserIdRef.current
    previousUserIdRef.current = currentUser?.id
    if (prev === undefined) return // first mount
    if (prev === currentUser?.id) return
    setCurrentView('inbox')
    setSelectedConversationId(null)
    setAttemptedConversations(new Set())
    navigate('/messages', { replace: true })
  }, [currentUser?.id])

  // Route user through sign-in → DM setup → inbox
  // If DM identity is not set up, go straight to setup (the DM signature handles auth too)
  // Only show signin if user has DM identity but no auth session (re-login case)
  useEffect(() => {
    if (!currentUser) return
    if (!identityLoading && !identity) {
      setCurrentView('setup')
    } else if (identity && !isWalletAuthorized) {
      setCurrentView('signin')
    } else if (identity && (currentView === 'signin' || currentView === 'setup')) {
      setCurrentView('inbox')
    }
  }, [currentUser, isWalletAuthorized, identity, identityLoading])

  // Load recent follows when new message modal opens.
  // One /api/dm/identity/batch call instead of one request per follow —
  // the previous fan-out turned a 10-follow list into 11 parallel HTTP
  // requests on every modal open.
  useEffect(() => {
    if (isNewMessageModalOpen && currentUser?.username) {
      apiFetch<{ items: Array<{ tokenId: number, username: string, displayName?: string, avatarUrl?: string }> }>(
        `/api/users/${currentUser.username}/following?limit=10`
      )
        .then(async (response) => {
          const items = (response.items || []).filter(u => u.tokenId !== currentUser?.id)
          if (items.length === 0) {
            setRecentFollows([])
            return
          }
          try {
            const ids = items.map(u => u.tokenId).join(',')
            const batch = await apiFetch<{ identities: Record<number, { hasIdentity: boolean }> }>(
              `/api/dm/identity/batch?userIds=${ids}`
            )
            setRecentFollows(items.map(u => ({
              ...u,
              hasDmIdentity: !!batch.identities[u.tokenId]?.hasIdentity,
            })))
          } catch {
            // Server probably old — fall back to "unknown" rather than crashing.
            setRecentFollows(items.map(u => ({ ...u, hasDmIdentity: undefined })))
          }
        })
        .catch(err => {
          console.error('Failed to fetch recent follows:', err)
          setRecentFollows([])
        })
    }
  }, [isNewMessageModalOpen, currentUser?.username])

  // Search users when typing in new message modal
  useEffect(() => {
    if (!isNewMessageModalOpen) return

    if (newMessageSearch.trim() === '') {
      setSearchResults([])
      return
    }

    setIsSearching(true)
    const timer = setTimeout(() => {
      apiFetch<{ users: Array<{ tokenId: number, username: string, displayName?: string, avatarUrl?: string }> }>(
        `/api/search?type=users&q=${encodeURIComponent(newMessageSearch)}&limit=20`
      )
        .then(async response => {
          const users = (response.users || []).filter(u => u.tokenId !== currentUser?.id)
          if (users.length === 0) {
            setSearchResults([])
            return
          }
          // Same batching as the recent-follows path — one round-trip
          // instead of one per result.
          try {
            const ids = users.map(u => u.tokenId).join(',')
            const batch = await apiFetch<{ identities: Record<number, { hasIdentity: boolean }> }>(
              `/api/dm/identity/batch?userIds=${ids}`
            )
            setSearchResults(users.map(u => ({
              ...u,
              hasDmIdentity: !!batch.identities[u.tokenId]?.hasIdentity,
            })))
          } catch {
            setSearchResults(users.map(u => ({ ...u, hasDmIdentity: undefined })))
          }
        })
        .catch(err => {
          console.error('Failed to search users:', err)
          setSearchResults([])
        })
        .finally(() => {
          setIsSearching(false)
        })
    }, 300) // Debounce

    return () => clearTimeout(timer)
  }, [newMessageSearch, isNewMessageModalOpen])

  // Handle DM registration
  const handleRegisterDm = async () => {
    if (!currentUser) return

    await ensureWallet(null, async () => {
      try {
        await initializeClientRef.current()
        setCurrentView('inbox')

        // If we have a target user from URL params, create conversation
        const userParam = searchParams.get('user')
        if (userParam && targetUser) {
          setTimeout(() => {
            dmStartConversation(targetUser.tokenId)
              .then((newConversation: any) => {
                handleConversationSelect(newConversation.id)
              })
              .catch((error: any) => {
                console.error('Failed to create conversation after init:', error)
              })
          }, 500)
        }
      } catch (error) {
        // Error is surfaced inline on the setup screen via `dmError` from
        // useDmClient — no modal needed.
        console.error('Failed to enable DMs:', error)
      }
    })
  }

  // Function to handle chat options menu actions
  const handleChatMenuAction = (action: string) => {
    setShowChatOptionsMenu(false)
    switch (action) {
      case 'block-user':
        setShowBlockConfirm(true)
        break
      case 'mute-notifications':
        if (selectedConversationId) {
          if (isConversationMuted(selectedConversationId)) {
            unmuteConversation(selectedConversationId)
          } else {
            muteConversation(selectedConversationId)
          }
        }
        break
      case 'report':
        setShowReportUser(true)
        break
      default:
        break
    }
  }

  // Format message time
  const formatMessageTime = (dateStr: string | number | Date | undefined) => {
    if (!dateStr) return 'Just now'
    try {
      const date = typeof dateStr === 'number'
        ? new Date(dateStr)
        : new Date(dateStr)

      if (isNaN(date.getTime())) {
        console.warn('Invalid date:', dateStr)
        return 'Just now'
      }

      return formatDistanceToNow(date, { addSuffix: true })
    } catch (err) {
      console.error('Error formatting date:', dateStr, err)
      return 'Just now'
    }
  }

  // Compact clock time for bubble footer (X-style).
  const formatBubbleTime = (dateStr: string | number | Date | undefined) => {
    if (!dateStr) return ''
    try {
      const date = new Date(dateStr)
      if (isNaN(date.getTime())) return ''
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    } catch {
      return ''
    }
  }

  // Close chat options menu when clicking outside
  useEffect(() => {
    if (!showChatOptionsMenu) return

    function handleClickOutside(event: MouseEvent) {
      if (chatMenuRef.current && !chatMenuRef.current.contains(event.target as Node)) {
        setShowChatOptionsMenu(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showChatOptionsMenu])

  return (
    <MainLayout>
      <div
        className={`max-w-2xl mx-auto pt-4 pb-0 flex flex-col relative flex-1 min-h-0 ${
          currentView === 'chat' ? 'h-[calc(100dvh-var(--app-mobile-header-h))] md:h-screen' : ''
        } ${isDark ? 'bg-black' : 'bg-white'}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay — covers the center column only */}
        {isDragOver && (
          <div className="sticky top-0 left-0 right-0 z-50 h-0">
            <div className="absolute inset-x-0 top-0 h-screen bg-black/80 flex items-center justify-center border-2 border-dashed border-yellow-500 pointer-events-none">
              <p className="text-yellow-500 text-lg font-semibold">Drop to encrypt & send</p>
            </div>
          </div>
        )}
        {/* Messages Header */}
        <div
          className={`${currentView === 'chat'
            ? `flex-shrink-0 w-full px-4 py-3 ${isDark ? 'bg-black' : 'bg-white'}`
            : `mb-6 flex-shrink-0 mx-3 sm:mx-6`}`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              {currentView === 'chat' && (
                <button
                  onClick={goBackToInbox}
                  className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}
              {currentView === 'chat' && otherParticipant && (
                <a
                  href={`/users/${otherParticipant.identity.user.username}`}
                  // Render a real anchor so cmd/ctrl/middle-click open in a
                  // new tab the way the browser already does for links —
                  // intercept plain clicks for SPA navigation only.
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                    e.preventDefault()
                    navigate(`/users/${otherParticipant.identity.user.username}`)
                  }}
                  className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 cursor-pointer"
                >
                  <Avatar
                    src={getUserAvatar(otherParticipant.identity.user)}
                    alt={otherParticipant.identity.user.username}
                    className="w-full h-full"
                    size="small"
                  />
                </a>
              )}
              <div className="flex flex-col">
                {currentView === 'chat' && otherParticipant ? (
                  <a
                    href={`/users/${otherParticipant.identity.user.username}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                      e.preventDefault()
                      navigate(`/users/${otherParticipant.identity.user.username}`)
                    }}
                    className={`text-2xl font-bold no-underline transition-colors duration-300 cursor-pointer hover:underline ${
                      isDark ? 'text-white' : 'text-black'
                    }`}
                  >
                    {otherParticipant.identity.user.displayName || otherParticipant.identity.user.username || 'Chat'}
                  </a>
                ) : (
                  <h1
                    className={`text-2xl font-bold transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}
                  >
                    {currentView === 'inbox' ? 'Messages' : currentView === 'setup' ? 'Enable DMs' : 'Chat'}
                  </h1>
                )}
                {currentView === 'inbox' && (
                  <div className={`flex items-center gap-2 mt-2 text-sm ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    <HiOutlineLockClosed className="w-4 h-4 flex-shrink-0" />
                    <span>End-to-end encrypted · AES-256-GCM</span>
                  </div>
                )}
              </div>
            </div>
            {currentView === 'chat' && (
              <div className="relative" ref={chatMenuRef}>
                <button
                  onClick={() => setShowChatOptionsMenu(!showChatOptionsMenu)}
                  className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}
                >
                  <HiOutlineDotsHorizontal className="w-5 h-5" />
                </button>

                {/* Chat Options Menu */}
                {showChatOptionsMenu && (
                  <>
                    <div
                      className="fixed inset-0 bg-black/70 z-40"
                      onClick={() => setShowChatOptionsMenu(false)}
                    />

                    <div
                      className={`absolute right-0 top-12 w-56 rounded-xl shadow-lg border transition-all duration-300 z-50 ${
                        isDark
                          ? 'bg-black border-white/20'
                          : 'bg-white border-gray-200'
                      }`}
                    >
                      <div className="py-2">
                        <button
                          onClick={() => handleChatMenuAction('block-user')}
                          className={`w-full flex items-center px-4 py-3 text-left transition-all duration-200 hover:bg-gray-500/10 ${
                            isDark ? 'text-white' : 'text-black'
                          }`}
                        >
                          <HiOutlineUserRemove className="w-5 h-5 mr-3" />
                          <span className="text-sm font-medium">Block user</span>
                        </button>

                        <button
                          onClick={() => handleChatMenuAction('mute-notifications')}
                          className={`w-full flex items-center px-4 py-3 text-left transition-all duration-200 hover:bg-gray-500/10 ${
                            isDark ? 'text-white' : 'text-black'
                          }`}
                        >
                          <HiOutlineVolumeOff className="w-5 h-5 mr-3" />
                          <span className="text-sm font-medium">
                            {selectedConversationId && isConversationMuted(selectedConversationId) ? 'Unmute notifications' : 'Mute notifications'}
                          </span>
                        </button>

                        <button
                          onClick={() => handleChatMenuAction('report')}
                          className={`w-full flex items-center px-4 py-3 text-left transition-all duration-200 hover:bg-gray-500/10 ${
                            isDark ? 'text-white' : 'text-black'
                          }`}
                        >
                          <HiOutlineExclamation className="w-5 h-5 mr-3" />
                          <span className="text-sm font-medium">Report</span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            {currentView === 'inbox' && (
              <div className="flex items-center space-x-3">
                {/* Settings Button */}
                <button
                  onClick={() => setIsSettingsModalOpen(true)}
                  className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 cursor-pointer relative ${
                    isDark ? '' : ''
                  }`}
                >
                  <HiOutlineCog className={`w-5 h-5 transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`} />
                  {!areNotificationsEnabled() && (
                    <span className="absolute top-0 right-0 w-2 h-2 bg-yellow-500 rounded-full"></span>
                  )}
                </button>

                {/* New Message Button */}
                <button
                  onClick={() => setIsNewMessageModalOpen(true)}
                  className={`relative p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 cursor-pointer ${
                    isDark ? '' : ''
                  }`}
                >
                  <HiOutlineMail className={`w-5 h-5 transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`} />
                  <HiOutlinePlus className={`absolute -top-0.5 -right-0.5 w-3 h-3 transition-colors duration-300 ${
                    isDark ? 'text-yellow-500' : 'text-yellow-600'
                  }`} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Search Bar - Only show in inbox view */}
        {currentView === 'inbox' && (
          <div className="mb-6 flex-shrink-0 mx-3 sm:mx-6">
            <div className="relative">
              <button
                onClick={() => setShowSearchModal(true)}
                className={`w-full px-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 text-left ${
                  isDark
                    ? 'bg-black border-gray-600 text-gray-400 hover:text-white focus:bg-transparent'
                    : 'bg-white border-gray-300 text-gray-500 hover:text-black focus:bg-transparent'
                }`}
              >
                <span className="flex items-center">
                  <HiOutlineSearch className="w-5 h-5 mr-2" />
                  Search messages
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Sign In View - Show when user is not authenticated */}
        {currentView === 'signin' && (
          <div className="flex-1 flex flex-col items-center pt-20 px-4">
            <div className="text-center max-w-md">
              <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto mb-4">
                <div className="w-11 h-11" style={{ backgroundColor: '#eab308', maskImage: 'url(/icons/crow-2.svg)', maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskImage: 'url(/icons/crow-2.svg)', WebkitMaskSize: 'contain', WebkitMaskRepeat: 'no-repeat', WebkitMaskPosition: 'center' }} />
              </div>
              <h2 className={`text-xl font-bold mb-3 ${isDark ? 'text-white' : 'text-black'}`}>
                {isWrongWallet ? 'Wrong Wallet Connected' : 'Log In to Access Messages'}
              </h2>
              <p className={`mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {!address
                  ? 'Connect your wallet to get started.'
                  : isWrongWallet
                  ? `Please switch wallets to the owner of @${activeToken?.username || 'this profile'}.`
                  : 'Sign a free message to verify you own this wallet.'}
              </p>
              {verifyError && (
                <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500">
                  <p className="text-red-500 text-sm">{verifyError}</p>
                </div>
              )}
              {!address ? (
                <ConnectButton />
              ) : (
                <button
                  onClick={() => verify()}
                  disabled={isVerifying || isWrongWallet}
                  className={`px-6 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 cursor-pointer ${isVerifying || isWrongWallet ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isVerifying ? 'Signing...' : 'Sign to Log In'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Setup View - Show when DMs are not enabled */}
        {currentView === 'setup' && (
          <div className="flex-1 flex flex-col items-center px-4 pt-[15vh]">
            {identityLoading ? (
              <div className="text-center max-w-md">
                <div className="mb-6 flex justify-center">
                  <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-yellow-500"></div>
                </div>
                <h2 className={`text-xl font-bold mb-3 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Enabling Secure Messaging...
                </h2>
                <p className={`${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Setting up your encryption keys
                </p>
              </div>
            ) : (
              <div className="text-center max-w-md">
                <HiOutlineShieldCheck className="w-16 h-16 mx-auto mb-4 text-yellow-500" />
                <h2 className={`text-xl font-bold mb-3 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Enable End-to-End Encrypted Messaging
                </h2>
                <p className={`mb-6 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  Sign a message to derive your encryption keys. This is a free, one-time setup per profile and per device/browser.
                </p>
                {dmError && (
                  <div className="mb-4 flex justify-center">
                    <div className={`inline-block px-4 py-2 rounded-lg text-sm ${
                      isDark ? 'bg-red-500/10 border border-red-500/40 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'
                    }`}>
                      {formatWalletError(dmError)}
                    </div>
                  </div>
                )}
                {(() => {
                  const wrongWallet = address && activeToken?.address && address.toLowerCase() !== activeToken.address.toLowerCase()
                  return wrongWallet ? (
                    <div className="flex flex-col items-center gap-2">
                      <button
                        disabled
                        className="px-6 py-3 rounded-full font-semibold bg-white/10 text-gray-400 cursor-not-allowed"
                      >
                        Wrong Wallet
                      </button>
                      <p className="text-sm text-red-400">Please switch to the correct wallet</p>
                    </div>
                  ) : (
                    <button
                      onClick={handleRegisterDm}
                      disabled={identityLoading}
                      className="px-6 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {identityLoading ? 'Enabling...' : 'Enable DMs'}
                    </button>
                  )
                })()}
              </div>
            )}
          </div>
        )}

        {/* Key derivation banner — DMs enabled but keys not in memory */}
        {currentView === 'inbox' && needsKeyDerivation && !identityLoading && (
          <div className={`mt-auto px-4 sm:px-6 py-3 flex items-center justify-between ${
            isDark ? 'bg-yellow-500/10 border-b border-yellow-500/30' : 'bg-yellow-50 border-b border-yellow-200'
          }`}>
            <p className={`text-sm ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
              {!address ? 'Connect your wallet to read messages' : 'Sign to unlock your encrypted messages'}
            </p>
            {!address ? (
              <ConnectButton />
            ) : (
              <button
                onClick={handleRegisterDm}
                disabled={identityLoading}
                className="px-4 py-1.5 rounded-full text-sm font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all cursor-pointer disabled:opacity-50"
              >
                {identityLoading ? 'Signing...' : 'Unlock'}
              </button>
            )}
          </div>
        )}

        {/* Messages List - Only show in inbox view */}
        {currentView === 'inbox' && (
          <div className="space-y-1 flex-1 overflow-y-auto min-h-0 mt-2">
            {(identityLoading || (conversationsLoading && !conversationsLoaded)) ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-500"></div>
              </div>
            ) : conversationsLoaded && conversations.length === 0 ? (
              <div className="text-center py-12">
                <HiOutlineMail className={`w-12 h-12 mx-auto mb-4 opacity-30 ${
                  isDark ? 'text-white' : 'text-black'
                }`} />
                <h3 className={`text-lg font-semibold mb-2 transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  No conversations yet
                </h3>
                <p className={`transition-colors duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  Start a new message to begin a conversation
                </p>
              </div>
            ) : (
              conversations.filter((conversation) => {
                // Hide conversations with blocked users
                const blockedIds = getBlockedUserIds()
                const peer = conversation.participants.find(p => p.userId !== currentUser?.id)
                return !peer || !blockedIds.includes(peer.userId)
              }).map((conversation) => {
                const otherUser = conversation.type === 'DM'
                  ? conversation.participants.find(p => p.userId !== currentUser?.id)
                  : null

                return (
                  <div
                    key={conversation.id}
                    className="px-3 sm:px-6 py-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer"
                    onClick={() => handleConversationSelect(conversation.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-start space-x-3 flex-1">
                        <div className="flex-shrink-0">
                          {otherUser?.identity.user ? (
                            <Avatar
                              src={getUserAvatar(otherUser.identity.user)}
                              alt={otherUser.identity.user.username}
                              className="w-10 h-10 rounded-full"
                              size="small"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center">
                              <span className="text-white font-semibold">U</span>
                            </div>
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center space-x-2 mb-1">
                            <h3 className={`font-semibold text-base transition-colors duration-300 ${
                              isDark ? 'text-white' : 'text-black'
                            }`}>
                              {otherUser?.identity.user.displayName || otherUser?.identity.user.username || 'Unknown'}
                            </h3>
                            {conversation.unreadCount > 0 && (
                              <span className="px-2 py-0.5 text-xs font-medium bg-yellow-500 text-black rounded-full">
                                {conversation.unreadCount}
                              </span>
                            )}
                          </div>
                          <p className={`text-sm transition-colors duration-300 line-clamp-1 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            {conversation.lastMessagePreview
                              ? (conversation.lastMessageSenderId === currentUser?.id ? 'You: ' : '') + conversation.lastMessagePreview
                              : conversation.lastMessageAt ? 'Encrypted message' : 'Start a conversation'}
                          </p>
                        </div>
                        {isConversationMuted(conversation.id) && (
                          <HiOutlineVolumeOff className="w-4 h-4 text-white/20 flex-shrink-0" />
                        )}
                      </div>

                      <div className="flex-shrink-0 ml-4">
                        <span className={`text-sm transition-colors duration-300 ${
                          isDark ? 'text-gray-500' : 'text-gray-500'
                        }`}>
                          {conversation.lastMessageAt ? formatMessageTime(conversation.lastMessageAt) : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
            {hasMoreConversations && (
              <button
                onClick={loadMoreConversations}
                className={`w-full py-3 text-sm font-medium transition-colors ${
                  isDark ? 'text-yellow-400 hover:text-yellow-300' : 'text-yellow-600 hover:text-yellow-500'
                }`}
              >
                Load more conversations
              </button>
            )}
          </div>
        )}

        {/* Chat View */}
        {currentView === 'chat' && selectedConversationId && (
          <div className="flex flex-col flex-1 min-h-0">
            {/* Encryption Status Banner */}
            <div className={`flex-shrink-0 w-full flex items-center justify-center py-4 px-6 ${
              isDark ? 'bg-green-900/20 border-b border-green-800/30' : 'bg-green-50 border-b border-green-200'
            }`}>
              <div className="flex items-center space-x-2">
                <HiOutlineLockClosed className={`w-4 h-4 ${
                  isDark ? 'text-green-400' : 'text-green-600'
                }`} />
                <span className={`text-xs font-medium ${
                  isDark ? 'text-green-400' : 'text-green-700'
                }`}>
                  Messages are end-to-end encrypted
                </span>
              </div>
            </div>

            {/* Chat Messages — fixed height so overflow scrolling works, fade in when ready */}
            <div
              ref={messagesContainerRef}
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar-alt p-4 md:p-4 pt-4 pb-20 md:pb-4 transition-opacity duration-300"
              style={{ opacity: chatReady ? 1 : 0 }}
              onScroll={(e) => {
                const el = e.currentTarget
                // Load older messages when scrolled near the top
                if (el.scrollTop < 100 && hasMoreMessages && !isLoadingOlder) {
                  const prevHeight = el.scrollHeight
                  loadOlderMessages().then(() => {
                    // Maintain scroll position after prepending older messages
                    requestAnimationFrame(() => {
                      el.scrollTop = el.scrollHeight - prevHeight
                    })
                  })
                }
              }}
            >
              {/* Loading older messages indicator */}
              {isLoadingOlder && (
                <div className="flex justify-center py-2">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-yellow-500" />
                </div>
              )}
              {/* Typing Indicator */}
              {otherUserTyping && (
                <div className="flex items-start space-x-3 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center">
                    <span className="text-white font-semibold text-sm">
                      {otherParticipant?.identity.user.username?.[0]?.toUpperCase() || '?'}
                    </span>
                  </div>
                  <div className={`px-6 py-4 rounded-2xl ${
                    isDark ? 'bg-gray-700' : 'bg-gray-200'
                  }`}>
                    <div className="flex space-x-1">
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                    </div>
                  </div>
                </div>
              )}
              {(() => {
                // Find the last message from current user that the peer has seen
                const peerReadTime = peerLastReadAt ? new Date(peerLastReadAt).getTime() : null
                const lastSeenMsgId = peerReadTime
                  ? [...messages].reverse().find(m =>
                      m.isFromCurrentUser && new Date(m.createdAt).getTime() <= peerReadTime
                    )?.id
                  : null

                let lastDateLabel = ''

                return messages.map((message, msgIdx) => {
                  // Handle different content types
                  let messageContent = '';
                  let attachments: any[] = [];

                  // Check if content is an object (system message or metadata)
                  if (typeof message.content === 'object' && message.content !== null) {
                    return null;
                  }

                  // Content is a string - parse it
                  try {
                    const parsed = JSON.parse(message.content);
                    if (parsed.text !== undefined) {
                      messageContent = parsed.text;
                      attachments = parsed.attachments || [];
                    } else {
                      messageContent = JSON.stringify(parsed);
                    }
                  } catch {
                    messageContent = message.content;
                  }

                  // Date divider logic
                  const msgDate = new Date(message.createdAt)
                  const dateLabel = msgDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  const showDateDivider = dateLabel !== lastDateLabel
                  lastDateLabel = dateLabel

                  // Animate messages from the last 2 seconds
                  const isNew = Date.now() - new Date(message.createdAt).getTime() < 2000

                  // Look up the parent message for the in-bubble quoted
                  // preview. Local-only — if the parent is older than the
                  // currently loaded window, the preview falls back to
                  // "Original message unavailable" via previewForMessage.
                  const parentMessage = message.replyToMessageId
                    ? messages.find(m => m.id === message.replyToMessageId)
                    : undefined

                  const nextMsg = messages[msgIdx + 1]
                  const compactWithNext = !!nextMsg
                    && nextMsg.isFromCurrentUser === message.isFromCurrentUser
                    && new Date(nextMsg.createdAt).toDateString() === msgDate.toDateString()
                    && (new Date(nextMsg.createdAt).getTime() - msgDate.getTime()) <= 5 * 60 * 1000
                  const blockSpacing = compactWithNext && message.isFromCurrentUser ? 'mb-2' : 'mb-4'

                  return (
                    <div
                      key={message.id}
                      data-message-id={message.id}
                      className={`${blockSpacing} ${isNew ? (message.isFromCurrentUser ? 'dm-animate-in-right' : 'dm-animate-in-left') : ''} ${
                        highlightMessageId === message.id ? 'dm-highlight-flash' : ''
                      }`}
                    >
                      {/* Date divider */}
                      {showDateDivider && (
                        <div className="flex items-center gap-3 my-4">
                          <div className={`flex-1 h-px ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                          <span className={`text-xs font-medium px-2 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                            {dateLabel}
                          </span>
                          <div className={`flex-1 h-px ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
                        </div>
                      )}

                      <div className={`flex flex-col ${message.isFromCurrentUser ? 'items-end' : 'items-start'}`}>
                        {/* Tombstone for deleted messages */}
                        {message.contentType === 'deleted' ? (
                          <div className="px-4 py-2 italic text-white/30 text-sm">
                            [Message deleted]
                          </div>
                        ) : (
                        <>
                        {/* Previous versions — shown as separate bubbles when "edited" is clicked */}
                        {editHistoryMessageId === message.id && message.editHistory?.map((entry, idx) => (
                          <div key={`edit-${idx}`} className={`flex ${message.isFromCurrentUser ? 'justify-end' : 'justify-start'} mb-1`}>
                            <Tooltip
                              text={new Date(entry.editedAt).toLocaleString()}
                              position={message.isFromCurrentUser ? 'left' : 'right'}
                            >
                            <div className={`max-w-md lg:max-w-xl px-6 py-4 rounded-2xl opacity-40 ${
                              message.isFromCurrentUser
                                ? 'bg-gray-600 text-white'
                                : isDark
                                ? 'bg-gray-700 text-white'
                                : 'bg-gray-200 text-black'
                            }`}>
                              <p className="text-sm whitespace-pre-wrap">{entry.content}</p>
                            </div>
                            </Tooltip>
                          </div>
                        ))}

                        {/* Reply preview — small quoted block above the
                            bubble. Tappable: scrolls to + briefly
                            highlights the parent. Falls back to a
                            disabled preview if the parent isn't in the
                            currently-loaded message window. */}
                        {message.replyToMessageId && (
                          <button
                            type="button"
                            onClick={() => parentMessage && scrollToMessage(parentMessage.id)}
                            disabled={!parentMessage}
                            className={`mb-1 max-w-md lg:max-w-xl text-left px-3 py-1.5 rounded-lg border-l-2 text-xs flex flex-col gap-0.5 ${
                              isDark
                                ? 'bg-white/5 border-yellow-500/60 text-white/70 hover:bg-white/10'
                                : 'bg-black/5 border-yellow-500/70 text-black/70 hover:bg-black/10'
                            } ${parentMessage ? 'cursor-pointer' : 'cursor-default opacity-60'}`}
                          >
                            <span className="font-semibold opacity-80">
                              {parentMessage
                                ? (parentMessage.isFromCurrentUser
                                    ? 'You'
                                    : `@${parentMessage.sender?.user.username || 'unknown'}`)
                                : 'Replying to'}
                            </span>
                            <span className="opacity-70 truncate">
                              {previewForMessage(parentMessage)}
                            </span>
                          </button>
                        )}

                        <div className={`flex items-start gap-1 group ${message.isFromCurrentUser ? 'flex-row-reverse' : 'flex-row'}`}>
                          {/* Message bubble — full timestamp lives on the
                              "X minutes ago" line below now, so the bubble
                              itself isn't a tooltip trigger and doesn't
                              fight the reaction strip's hover area. */}
                          <div
                            className={`max-w-md lg:max-w-xl px-6 py-4 rounded-2xl relative ${
                              message.isFromCurrentUser
                                ? 'bg-gray-600 text-white'
                                : isDark
                                ? 'bg-gray-700 text-white'
                                : 'bg-gray-200 text-black'
                            }`}
                            onPointerDown={(e) => {
                              // Mobile UX: reactions open on long-press, not on random taps.
                              if (e.pointerType !== 'touch') return
                              // Only one long-press tracker at a time.
                              if (longPressRef.current.timer) window.clearTimeout(longPressRef.current.timer)
                              longPressRef.current = {
                                timer: window.setTimeout(() => {
                                  longPressRef.current.fired = true
                                  setReactionStripForMessage(message.id)
                                }, 420),
                                messageId: message.id,
                                pointerId: e.pointerId,
                                startX: e.clientX,
                                startY: e.clientY,
                                fired: false,
                              }
                            }}
                            onPointerMove={(e) => {
                              if (e.pointerType !== 'touch') return
                              if (longPressRef.current.pointerId !== e.pointerId) return
                              const dx = Math.abs(e.clientX - longPressRef.current.startX)
                              const dy = Math.abs(e.clientY - longPressRef.current.startY)
                              // If the user is scrolling, bail.
                              if (dx + dy > 12 && longPressRef.current.timer) {
                                window.clearTimeout(longPressRef.current.timer)
                                longPressRef.current.timer = null
                              }
                            }}
                            onPointerUp={(e) => {
                              if (e.pointerType !== 'touch') return
                              if (longPressRef.current.pointerId !== e.pointerId) return
                              if (longPressRef.current.timer) window.clearTimeout(longPressRef.current.timer)
                              longPressRef.current.timer = null
                              longPressRef.current.pointerId = null
                              longPressRef.current.messageId = null
                              longPressRef.current.fired = false
                            }}
                            onPointerCancel={(e) => {
                              if (e.pointerType !== 'touch') return
                              if (longPressRef.current.pointerId !== e.pointerId) return
                              if (longPressRef.current.timer) window.clearTimeout(longPressRef.current.timer)
                              longPressRef.current.timer = null
                              longPressRef.current.pointerId = null
                              longPressRef.current.messageId = null
                              longPressRef.current.fired = false
                            }}
                          >

                          {/* Inline editing mode */}
                          {editingMessageId === message.id ? (
                            <div className="space-y-2">
                              <input
                                type="text"
                                value={editingContent}
                                onChange={(e) => setEditingContent(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    dmEditMessage(message.id, editingContent)
                                    setEditingMessageId(null)
                                  }
                                  if (e.key === 'Escape') setEditingMessageId(null)
                                }}
                                autoFocus
                                className="w-full bg-black/30 rounded px-2 py-1 text-sm outline-none border border-white/20 focus:border-yellow-500"
                              />
                              <div className="flex gap-2 text-xs">
                                <button
                                  onClick={() => { dmEditMessage(message.id, editingContent); setEditingMessageId(null) }}
                                  className="text-yellow-500 hover:text-yellow-400 cursor-pointer"
                                >Save</button>
                                <button
                                  onClick={() => setEditingMessageId(null)}
                                  className="text-white/40 hover:text-white/60 cursor-pointer"
                                >Cancel</button>
                                <span className="text-white/20">esc to cancel, enter to save</span>
                              </div>
                            </div>
                          ) : (
                          <>
                          {/* Message content — handle text, images, GIFs, encrypted attachments */}
                          {messageContent && (() => {
                            const bubbleTime = formatBubbleTime(message.createdAt)
                            const bubbleTimeTextClass = message.isFromCurrentUser
                              ? 'text-white/70'
                              : isDark
                                ? 'text-white/60'
                                : 'text-black/60'
                            const bubbleTimePillClass = message.isFromCurrentUser
                              ? 'bg-black/40 text-white/80'
                              : isDark
                                ? 'bg-black/40 text-white/75'
                                : 'bg-white/80 text-black/70'

                            // Check for encrypted attachment JSON
                            try {
                              const parsed = JSON.parse(messageContent)
                              if (parsed.msgType === 'encrypted-attachment' && parsed.url) {
                                // Dispatch on mimeType, NOT parsed.type. The
                                // upload hook historically only set type to
                                // 'image' or 'file' (no 'video'), so legacy
                                // video DMs in DB have type='file' but a
                                // video/* mimeType. Falling back to mimeType
                                // means they render correctly going forward.
                                const mt = String(parsed.mimeType || '')
                                if (mt.startsWith('image/') || mt.startsWith('video/') || parsed.type === 'image') {
                                  return (
                                    <div className="relative">
                                      <EncryptedImage
                                        url={parsed.url}
                                        sharedSecret={chatSharedSecret}
                                        mimeType={parsed.mimeType}
                                        alt={parsed.name}
                                        className={mt.startsWith('video/')
                                          ? 'max-w-[320px] max-h-[320px] rounded-lg'
                                          : 'max-w-[240px] max-h-[240px] rounded-lg object-contain'}
                                      />
                                      {bubbleTime && (
                                        <span className={`absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${bubbleTimePillClass}`}>
                                          <span className="inline-flex items-center gap-1">
                                            {bubbleTime}
                                            <HiOutlineLockClosed className="w-3 h-3 text-green-400" />
                                          </span>
                                        </span>
                                      )}
                                    </div>
                                  )
                                }
                                // Generic file
                                return (
                                  <div className="grid grid-cols-[1fr_auto] items-end gap-2 min-w-0">
                                    <div className="flex items-center gap-2 p-2 rounded bg-black/20 min-w-0">
                                      <HiOutlinePaperClip className="w-4 h-4 flex-shrink-0" />
                                      <span className="text-xs truncate">{parsed.name}</span>
                                      <span className="text-xs text-white/30 flex-shrink-0">{(parsed.size / 1024).toFixed(0)}KB</span>
                                    </div>
                                    {bubbleTime && (
                                      <span className={`text-[11px] font-medium whitespace-nowrap inline-flex items-center gap-1 ${bubbleTimeTextClass}`}>
                                        {bubbleTime}
                                        <HiOutlineLockClosed className="w-3 h-3 text-green-400" />
                                      </span>
                                    )}
                                  </div>
                                )
                              }
                            } catch {}

                            // Check for image/GIF URLs
                            const imageUrlPattern = /^https?:\/\/\S+\.(gif|jpg|jpeg|png|webp)(\?\S*)?$/i
                            const giphyPattern = /^https?:\/\/(media\d?\.giphy\.com|i\.giphy\.com)\//i
                            const trimmed = messageContent.trim()
                            if (imageUrlPattern.test(trimmed) || giphyPattern.test(trimmed)) {
                              return (
                                <div className="relative">
                                  <img
                                    src={trimmed}
                                    alt="Shared image"
                                    className="max-w-[240px] max-h-[240px] rounded-lg object-contain"
                                    loading="lazy"
                                  />
                                  {bubbleTime && (
                                    <span className={`absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${bubbleTimePillClass}`}>
                                      <span className="inline-flex items-center gap-1">
                                        {bubbleTime}
                                        <HiOutlineLockClosed className="w-3 h-3 text-green-400" />
                                      </span>
                                    </span>
                                  )}
                                </div>
                              )
                            }

                            return (
                              <div className="grid grid-cols-[1fr_auto] items-end gap-2 min-w-0">
                                <p className={`${emojiOnlyTextClass(messageContent)} whitespace-pre-wrap break-words min-w-0`}>
                                  {messageContent}
                                </p>
                                {bubbleTime && (
                                  <span className={`text-[11px] font-medium whitespace-nowrap inline-flex items-center gap-1 ${bubbleTimeTextClass}`}>
                                    {bubbleTime}
                                    <HiOutlineLockClosed className="w-3 h-3 text-green-400" />
                                  </span>
                                )}
                              </div>
                            )
                          })()}

                          {/* Edited indicator */}
                          {message.editHistory && message.editHistory.length > 0 && (
                              <button
                                onClick={() => setEditHistoryMessageId(editHistoryMessageId === message.id ? null : message.id)}
                                className="text-xs text-white/30 hover:text-white/50 mt-1 block cursor-pointer"
                              >
                                ({editHistoryMessageId === message.id ? 'hide edits' : 'edited'})
                              </button>
                          )}

                          {/* Attachments */}
                          {attachments.length > 0 && (
                            <div className="mt-2 space-y-2">
                              {attachments.map((attachment: any, idx: number) => (
                                <div key={idx} className="flex items-center space-x-2 p-2 rounded bg-black/20">
                                  <HiOutlinePaperClip className="w-4 h-4" />
                                  <span className="text-xs truncate">{attachment.originalName}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          </>
                          )}
                          </div>

                          {/* Reaction strip — sits inside the same `group`
                              wrapper so the same hover state that reveals
                              the dot menu also reveals the strip. Mobile
                              long-press shows it via the parent's :active
                              variant if you ever style it that way; for
                              now the dots fallback works on touch. */}
                          {currentUser && (
                            <MessageReactionStrip
                              emojis={defaultReactions.length === 5 ? defaultReactions : DEFAULT_DM_REACTIONS}
                              reactions={message.reactions || []}
                              currentUserId={currentUser.id}
                              onReact={(emoji) => dmToggleReaction(message.id, emoji)}
                              onOpenPicker={() => setEmojiPickerForMessage(message.id)}
                              onOpenCustomize={() => setShowCustomizeReactions(true)}
                              alignRight={message.isFromCurrentUser}
                              anchor="bubble"
                              open={reactionStripForMessage === message.id}
                              onOpenChange={(nextOpen) => setReactionStripForMessage(nextOpen ? message.id : null)}
                            />
                          )}

                          {/* Reply — sits between the reaction strip and
                              the dots so the three hover affordances form
                              a single row. Uses the same opacity-on-hover
                              pattern as the dots. */}
                          <button
                            onClick={() => {
                              setReplyingToId(message.id)
                              requestAnimationFrame(() => {
                                const ta = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[data-dm-composer]')
                                ta?.focus()
                              })
                            }}
                            className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-white/10 self-center flex-shrink-0"
                            title="Reply"
                          >
                            <HiOutlineReply className="w-5 h-5 text-white/30" />
                          </button>

                          {/* Hover actions — outside the bubble, to the side */}
                          <button
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect()
                              setContextMenu({
                                messageId: message.id,
                                x: message.isFromCurrentUser ? rect.left - 180 : rect.right,
                                y: rect.top,
                                isOwn: message.isFromCurrentUser,
                                createdAt: message.createdAt,
                              })
                            }}
                            className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-white/10 self-center flex-shrink-0"
                          >
                            <HiOutlineDotsHorizontal className="w-5 h-5 text-white/30" />
                          </button>
                        </div>

                        {/* Reaction chips below the bubble — grouped by
                            emoji with a count, tap to toggle yours. */}
                        {currentUser && message.reactions && message.reactions.length > 0 && (
                          <MessageReactionsBar
                            reactions={message.reactions}
                            currentUserId={currentUser.id}
                            onToggle={(emoji) => dmToggleReaction(message.id, emoji)}
                            alignRight={message.isFromCurrentUser}
                          />
                        )}
                        </>
                        )}

                        {/* Seen indicator — shown below the last message the peer has read */}
                        {message.id === lastSeenMsgId && (
                          <div className="flex items-center justify-end gap-1.5 mt-1 px-2">
                            <HiOutlineCheckCircle className="w-3 h-3 text-yellow-500" />
                            <span className="text-xs text-yellow-500/70">
                              Seen {formatDistanceToNow(new Date(peerLastReadAt!), { addSuffix: true })}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })
              })()}
            </div>

            {/* Context menu for message actions */}
            {contextMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
                <div
                  className="fixed z-50 bg-gray-800 border border-white/20 rounded-lg shadow-xl py-1 min-w-[180px]"
                  style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                  {/* Edit — only own messages within 15 min */}
                  {contextMenu.isOwn && (Date.now() - new Date(contextMenu.createdAt).getTime() < 15 * 60 * 1000) && (
                    <button
                      onClick={() => {
                        const msg = messages.find(m => m.id === contextMenu.messageId)
                        if (msg) {
                          setEditingMessageId(msg.id)
                          setEditingContent(msg.content)
                        }
                        setContextMenu(null)
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-white hover:bg-white/10 cursor-pointer flex justify-between items-center"
                    >
                      <span className="mr-3">Edit</span>
                      <span className="text-xs text-white/30 flex-shrink-0">
                        {Math.max(0, Math.ceil((15 * 60 * 1000 - (Date.now() - new Date(contextMenu.createdAt).getTime())) / 60000))}m left
                      </span>
                    </button>
                  )}

                  {/* Delete for everyone — only own messages within 5 min */}
                  {contextMenu.isOwn && (Date.now() - new Date(contextMenu.createdAt).getTime() < 5 * 60 * 1000) && (
                    <button
                      onClick={() => {
                        dmDeleteForEveryone(contextMenu.messageId)
                        setContextMenu(null)
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-white/10 cursor-pointer flex justify-between items-center"
                    >
                      <span className="mr-3">Delete for everyone</span>
                      <span className="text-xs text-red-400/50 flex-shrink-0">
                        {Math.max(0, Math.ceil((5 * 60 * 1000 - (Date.now() - new Date(contextMenu.createdAt).getTime())) / 60000))}m left
                      </span>
                    </button>
                  )}

                  {/* Delete for me — always available */}
                  <button
                    onClick={() => {
                      dmDeleteForMe(contextMenu.messageId)
                      setContextMenu(null)
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-white/60 hover:bg-white/10 cursor-pointer"
                  >
                    Delete for me
                  </button>
                </div>
              </>
            )}

            {/* GIF Picker — fixed overlay */}
            {showGifPicker && !gifPreview && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowGifPicker(false)} />
                <div className={`fixed bottom-16 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] md:w-[500px] md:max-w-[80vw] md:bottom-20 z-50 rounded-xl border shadow-2xl max-h-[60vh] overflow-auto ${isDark ? 'border-white/10 bg-black' : 'border-gray-200 bg-white'}`}>
                  <GifPicker
                    onSelect={(gif) => {
                      setGifPreview({ url: gif.url, preview: gif.preview })
                      setShowGifPicker(false)
                    }}
                    onClose={() => setShowGifPicker(false)}
                  />
                </div>
              </>
            )}

            {/* Bottom bar — anchored to bottom, doesn't scroll with messages */}
            <div className={`flex-shrink-0 fixed md:sticky bottom-0 left-0 right-0 z-20 ${isDark ? 'bg-black' : 'bg-white'}`}>

              {/* Unlock banner — replaces input when keys need derivation */}
              {needsKeyDerivation && !identityLoading ? (
                <div className={`p-4 border-t flex items-center justify-between ${
                  isDark ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'
                }`}>
                  <p className={`text-sm ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
                    {!address ? 'Connect your wallet to read messages' : 'Sign to unlock your encrypted messages'}
                  </p>
                  {!address ? (
                    <ConnectButton />
                  ) : (
                    <button
                      onClick={handleRegisterDm}
                      disabled={identityLoading}
                      className="px-4 py-1.5 rounded-full text-sm font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all cursor-pointer disabled:opacity-50"
                    >
                      {identityLoading ? 'Signing...' : 'Unlock'}
                    </button>
                  )}
                </div>
              ) : (
              <>

              {/* GIF Preview */}
              {gifPreview && (
                <div className="border-t border-white/10 p-3">
                  <div className="relative inline-block">
                    <img src={gifPreview.preview || gifPreview.url} alt="GIF preview" className="max-h-48 rounded-lg border border-white/10" />
                    <button
                      onClick={() => setGifPreview(null)}
                      className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white hover:bg-black/80 cursor-pointer"
                    >
                      <HiOutlineX className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      dmSendMessage(gifPreview.url)
                      setGifPreview(null)
                    }}
                    className="mt-2 px-4 py-1.5 rounded-full text-sm font-semibold bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer"
                  >
                    Send GIF
                  </button>
                </div>
              )}

              {/* File Preview */}
              {filePreview && !isUploading && (
                <div className="border-t border-white/10 p-3">
                  <div className="relative inline-block">
                    {filePreview.isImage ? (
                      <img src={filePreview.previewUrl} alt="File preview" className="max-h-48 rounded-lg border border-white/10" />
                    ) : (
                      <div className="flex items-center gap-2 p-3 rounded-lg bg-white/5">
                        <HiOutlinePaperClip className="w-5 h-5 text-white/50" />
                        <div>
                          <p className="text-sm text-white truncate max-w-[200px]">{filePreview.file.name}</p>
                          <p className="text-xs text-white/40">{(filePreview.file.size / 1024).toFixed(0)}KB</p>
                        </div>
                      </div>
                    )}
                    <button
                      onClick={handleCancelFilePreview}
                      className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white hover:bg-black/80 cursor-pointer"
                    >
                      <HiOutlineX className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    onClick={handleSendFile}
                    className="mt-2 px-4 py-1.5 rounded-full text-sm font-semibold bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer"
                  >
                    {filePreview.isImage ? 'Send Image' : 'Send File'}
                  </button>
                </div>
              )}

              {/* Upload progress / error */}
              {(isUploading || uploadError) && (
                <div className={`border-t border-white/10 px-4 py-2 text-sm ${uploadError ? 'text-red-400' : 'text-yellow-400'}`}>
                  {uploadError || uploadProgress || 'Uploading...'}
                </div>
              )}

              {/* Emoji Picker */}
              {showEmojiPicker && !gifPreview && !filePreview && (
                <div className={`border-t p-3 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                  <div className={`p-4 border rounded-lg ${
                    isDark ? 'border-white/20 bg-black' : 'border-gray-200 bg-gray-50'
                  }`}>
                    <div className="grid grid-cols-7 gap-2 max-h-32 overflow-y-auto">
                      {['😀', '😂', '🤣', '😊', '😍', '🤔', '😎', '🔥', '💯', '❤️', '👍', '👎', '🌙'].map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => {
                            setNewMessageContent((prev) => prev + emoji)
                            setShowEmojiPicker(false)
                          }}
                          className={`p-1 text-xl rounded transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-gray-200'}`}
                        >
                          {emoji}
                        </button>
                      ))}
                      {/* "+" opens the full emoji-mart picker — same modal
                          used for message reactions, keeps both flows on
                          one component. */}
                      <button
                        onClick={() => {
                          setShowEmojiPicker(false)
                          setComposerEmojiPickerOpen(true)
                        }}
                        title="More emojis"
                        className={`p-1 text-xl rounded transition-colors flex items-center justify-center ${isDark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-gray-200 text-black/60'}`}
                      >
                        <HiOutlinePlus className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Reply chip — shown above the input when the user has
                  selected a message to reply to. X button cancels;
                  Escape inside the textarea cancels too (handled there). */}
              {replyingToId && (() => {
                const target = messages.find(m => m.id === replyingToId)
                return (
                  <div className={`mx-2 md:mx-4 mt-2 px-3 py-2 rounded-lg flex items-start gap-2 border-l-2 border-yellow-500/70 ${
                    isDark ? 'bg-white/5' : 'bg-black/5'
                  }`}>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-semibold ${isDark ? 'text-white/80' : 'text-black/80'}`}>
                        Replying to {target?.isFromCurrentUser
                          ? 'yourself'
                          : `@${target?.sender?.user.username || 'unknown'}`}
                      </p>
                      <p className={`text-xs truncate ${isDark ? 'text-white/60' : 'text-black/60'}`}>
                        {previewForMessage(target)}
                      </p>
                    </div>
                    <button
                      onClick={() => setReplyingToId(null)}
                      className={`p-1 rounded-full ${isDark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-black/10 text-black/60'}`}
                      title="Cancel reply (Esc)"
                    >
                      <HiOutlineX className="w-4 h-4" />
                    </button>
                  </div>
                )
              })()}

              {/* Message Input */}
              <div className="border-t border-white/10 p-2 md:p-4">
              <div className={`flex items-center rounded-full border transition-all duration-300 focus-within:ring-2 focus-within:ring-gray-500/30 ${
                isDark
                  ? 'bg-black border-white/20'
                  : 'bg-white border-gray-300'
              }`}>
                {/* Left side icons - fixed area */}
                <div className="flex items-center space-x-3 px-3 py-3">
                  {/* Encrypted image upload */}
                    <label title="Send encrypted image" className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                      isDark
                        ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                        : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50'
                    }`}>
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
                      </svg>
                      <input
                        type="file"
                        accept="image/*,video/*"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.length) {
                            handleFileSelected(e.target.files)
                            e.target.value = ''
                          }
                        }}
                      />
                    </label>

                  {/* GIF picker */}
                  <button
                    onClick={() => {
                      setShowEmojiPicker(false)
                      setShowGifPicker(!showGifPicker)
                    }}
                    className={`px-2 py-1 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer ${
                      showGifPicker
                        ? isDark
                          ? 'text-yellow-400 bg-yellow-400/20'
                          : 'text-yellow-600 bg-yellow-200'
                        : isDark
                          ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                          : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50'
                    }`}>
                    GIF
                  </button>

                  {/* Emoji icon */}
                  <button
                    onClick={() => {
                      setShowGifPicker(false)
                      setShowEmojiPicker(!showEmojiPicker)
                    }}
                    className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                      showEmojiPicker
                        ? (isDark ? 'text-yellow-400 bg-yellow-400/20' : 'text-yellow-600 bg-yellow-200')
                        : (isDark
                          ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                          : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </button>
                </div>

                {/* Input area - where user can type */}
                <textarea
                  data-dm-composer
                  placeholder="Start a new message"
                  value={newMessageContent}
                  onChange={(e) => {
                    handleInputChange(e.target.value)
                    // Auto-resize
                    e.target.style.height = 'auto'
                    e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px'
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSendMessage()
                    }
                    // Escape clears the reply chip — same UX as Slack /
                    // iMessage. We only intercept when there's an active
                    // reply target so plain Esc behavior elsewhere
                    // (modals, etc.) is unaffected.
                    if (e.key === 'Escape' && replyingToId) {
                      e.preventDefault()
                      setReplyingToId(null)
                    }
                  }}
                  rows={1}
                  className={`flex-1 py-3 pr-12 bg-transparent border-none outline-none resize-none ${
                    isDark
                      ? 'text-white placeholder-gray-500'
                      : 'text-black placeholder-gray-500'
                  }`}
                  style={{ maxHeight: '128px' }}
                />

                {/* Send button */}
                <button
                  onClick={handleSendMessage}
                  disabled={isSending || !newMessageContent.trim()}
                  className={`p-2 rounded-full transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    isDark
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50'
                  }`}
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>
            </div>
              </>
              )}
          </div>
          </div>
        )}
      </div>

      {/* Full emoji picker — opened from the `+` on a message's
          reaction strip. Picking an emoji posts it as a reaction on
          that specific message. */}
      <EmojiPickerModal
        open={emojiPickerForMessage !== null}
        onClose={() => setEmojiPickerForMessage(null)}
        onPick={(emoji) => {
          if (emojiPickerForMessage) dmToggleReaction(emojiPickerForMessage, emoji)
        }}
      />

      {/* Same full picker, but for the composer — picking inserts the
          emoji into the textarea instead of reacting. */}
      <EmojiPickerModal
        open={composerEmojiPickerOpen}
        onClose={() => setComposerEmojiPickerOpen(false)}
        onPick={(emoji) => {
          setNewMessageContent(prev => prev + emoji)
          setComposerEmojiPickerOpen(false)
        }}
      />

      {/* Customize the 5 default reactions. Triggered by right-click
          on the `+` button. */}
      {currentUser && (
        <CustomizeReactionsModal
          open={showCustomizeReactions}
          onClose={() => setShowCustomizeReactions(false)}
          userId={currentUser.id}
          current={defaultReactions}
          onSaved={(next) => setDefaultReactions(next)}
        />
      )}

      {/* Block User Confirmation */}
      <MuteConfirmModal
        isOpen={showBlockConfirm}
        onClose={() => setShowBlockConfirm(false)}
        actionType="block-account"
        targetName={otherParticipant?.identity.user.username}
        onConfirm={() => {
          const peer = otherParticipant
          if (peer) {
            blockUser(currentUser!.id, peer.userId, peer.identity.user.username)
          }
          setShowBlockConfirm(false)
          goBackToInbox()
        }}
      />

      {/* Report User Modal */}
      {otherParticipant && (
        <ReportUserModal
          isOpen={showReportUser}
          onClose={() => setShowReportUser(false)}
          userId={otherParticipant.userId}
          username={otherParticipant.identity.user.username}
        />
      )}

      {/* New Message Modal */}
      <ModalWrapper
        isOpen={isNewMessageModalOpen}
        onClose={closeModal}
        maxWidth="max-w-md"
        className="max-h-[80vh] flex flex-col"
      >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/20">
              {modalStep === 'compose' && (
                <button
                  onClick={() => setModalStep('select')}
                  className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}
                >
                  ←
                </button>
              )}
              <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                {modalStep === 'select' ? 'New Message' : 'Send Message'}
              </h2>
              <button
                onClick={closeModal}
                className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 ${
                  isDark ? 'text-white' : 'text-black'
                }`}
              >
                <HiOutlineX className="w-5 h-5" />
              </button>
            </div>

            {modalStep === 'select' ? (
              <>
                {/* Search Input */}
                <div className="p-4 border-b border-white/20">
                  <div className="relative">
                    <HiOutlineSearch className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 ${
                      isDark ? 'text-gray-400' : 'text-gray-500'
                    }`} />
                    <input
                      type="text"
                      placeholder="Search people..."
                      value={newMessageSearch}
                      onChange={(e) => setNewMessageSearch(e.target.value)}
                      className={`w-full pl-10 pr-4 py-2 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-yellow-500/30 ${
                        isDark
                          ? 'bg-black border-gray-600 text-white placeholder-gray-500'
                          : 'bg-white border-gray-300 text-black placeholder-gray-400'
                      }`}
                      autoFocus
                    />
                  </div>
                </div>

                {/* User List */}
                <div className="flex-1 overflow-y-auto">
                  {isSearching ? (
                    <div className="flex justify-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-500"></div>
                    </div>
                  ) : newMessageSearch.trim() !== '' ? (
                    // Show search results
                    searchResults.length > 0 ? (
                      <div>
                        {searchResults.map(user => (
                          <button
                            key={user.tokenId}
                            onClick={() => user.hasDmIdentity !== false && handleSelectUserToMessage(user)}
                            disabled={user.hasDmIdentity === false}
                            className={`w-full px-4 py-3 flex items-center space-x-3 transition-all duration-300 ${
                              user.hasDmIdentity === false
                                ? 'opacity-50 cursor-not-allowed'
                                : 'hover:bg-gray-500/10 cursor-pointer'
                            } ${
                              isDark ? 'text-white' : 'text-black'
                            }`}
                          >
                            <Avatar
                              src={getUserAvatar(user)}
                              alt={user.username}
                              className="w-10 h-10 rounded-full"
                              size="small"
                            />
                            <div className="flex-1 text-left">
                              <div className="font-semibold">{user.displayName || user.username}</div>
                              <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                @{user.username}
                                {user.hasDmIdentity === false && (
                                  <span className="ml-2 text-xs text-yellow-500">DMs not enabled</span>
                                )}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className={`text-center py-8 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        No users found
                      </div>
                    )
                  ) : (
                    // Show recent follows
                    recentFollows.length > 0 ? (
                      <div>
                        <div className={`px-4 py-2 text-sm font-semibold ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                          Recent follows
                        </div>
                        {recentFollows.map(user => (
                          <button
                            key={user.tokenId}
                            onClick={() => user.hasDmIdentity !== false && handleSelectUserToMessage(user)}
                            disabled={user.hasDmIdentity === false}
                            className={`w-full px-4 py-3 flex items-center space-x-3 transition-all duration-300 ${
                              user.hasDmIdentity === false
                                ? 'opacity-50 cursor-not-allowed'
                                : 'hover:bg-gray-500/10 cursor-pointer'
                            } ${
                              isDark ? 'text-white' : 'text-black'
                            }`}
                          >
                            <Avatar
                              src={getUserAvatar(user)}
                              alt={user.username}
                              className="w-10 h-10 rounded-full"
                              size="small"
                            />
                            <div className="flex-1 text-left">
                              <div className="font-semibold">{user.displayName || user.username}</div>
                              <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                @{user.username}
                                {user.hasDmIdentity === false && (
                                  <span className="ml-2 text-xs text-yellow-500">DMs not enabled</span>
                                )}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className={`text-center py-8 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        Start typing to search for people
                      </div>
                    )
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Compose Step - Show selected user and message input */}
                <div className="p-4 border-b border-white/20">
                  <div className="flex items-center space-x-3">
                    <img
                      src={selectedUser?.avatar || '/images/logo.jpeg'}
                      alt={selectedUser?.name}
                      className="w-10 h-10 rounded-full object-cover"
                    />
                    <div>
                      <div className={`font-semibold ${isDark ? 'text-white' : 'text-black'}`}>
                        {selectedUser?.name}
                      </div>
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        @{selectedUser?.handle}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Message Input */}
                <div className="flex-1 p-4">
                  <textarea
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    placeholder="Type your message..."
                    className={`w-full h-32 px-4 py-3 rounded-lg border resize-none transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-yellow-500/30 ${
                      isDark
                        ? 'bg-black border-gray-600 text-white placeholder-gray-500'
                        : 'bg-white border-gray-300 text-black placeholder-gray-400'
                    }`}
                    autoFocus
                  />
                </div>

                {/* Send Button */}
                <div className="p-4 border-t border-white/20">
                  <button
                    onClick={handleSendNewMessage}
                    disabled={!messageText.trim()}
                    className="w-full py-2 px-6 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Send Message
                  </button>
                </div>
              </>
            )}
      </ModalWrapper>

      {/* Message Settings Modal */}
      <ModalWrapper isOpen={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} maxWidth="max-w-sm">
        <div className="p-5 space-y-4">
          <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Message Settings
          </h3>
          <div>
            <p className={`text-sm mb-3 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
              Receive messages from:
            </p>
            <div className="space-y-2">
              {([
                { value: 'EVERYONE' as const, label: 'Everyone', desc: 'Anyone with DMs enabled can message you' },
                { value: 'FOLLOWERS' as const, label: 'Users who follow me', desc: 'Your followers and people you follow' },
                { value: 'FOLLOWING' as const, label: 'Users I follow', desc: 'Only people you follow' },
              ]).map(option => (
                <label
                  key={option.value}
                  className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                    dmPrivacy === option.value
                      ? isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'
                      : isDark ? 'bg-white/5 hover:bg-white/10 border border-transparent' : 'bg-gray-50 hover:bg-gray-100 border border-transparent'
                  }`}
                >
                  <input
                    type="radio"
                    name="dmPrivacy"
                    value={option.value}
                    checked={dmPrivacy === option.value}
                    onChange={() => {
                      setDmPrivacy(option.value)
                      if (currentUser?.id) {
                        apiFetch('/api/dm/settings', {
                          method: 'PUT',
                          body: JSON.stringify({ userId: currentUser.id, dmPrivacy: option.value })
                        }).catch(err => console.error('Failed to save DM settings:', err))
                      }
                    }}
                    className="mt-1 accent-yellow-500"
                  />
                  <div>
                    <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {option.label}
                    </p>
                    <p className={`text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                      {option.desc}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <button
            onClick={() => setIsSettingsModalOpen(false)}
            className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              isDark
                ? 'bg-white/10 text-white hover:bg-white/20'
                : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
            }`}
          >
            Done
          </button>
        </div>
      </ModalWrapper>

      {/* DM Privacy Restriction Modal */}
      <ModalWrapper isOpen={!!dmPrivacyError} onClose={() => setDmPrivacyError(null)} maxWidth="max-w-md">
        {dmPrivacyError && (
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-full ${isDark ? 'bg-yellow-500/10' : 'bg-yellow-50'}`}>
                <HiOutlineMail className="w-5 h-5 text-yellow-500" />
              </div>
              <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Can't Send Message
              </h3>
            </div>

            <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
              {dmPrivacyError.peer?.username ? (
                <>
                  <a
                    href={`/users/${dmPrivacyError.peer.username}`}
                    onClick={(e) => { e.preventDefault(); setDmPrivacyError(null); navigate(`/users/${dmPrivacyError.peer.username}`) }}
                    className="text-yellow-500 hover:text-yellow-400 hover:underline"
                  >
                    @{dmPrivacyError.peer.username}
                  </a>
                  {dmPrivacyError.reason === 'following'
                    ? ' only accepts messages from users they follow.'
                    : ' only accepts messages from their followers.'}
                </>
              ) : dmPrivacyError.message}
            </p>

            {/* Show peer info with follow button if the reason is they need to be followed */}
            {dmPrivacyError.peer && (dmPrivacyError.reason === 'followers') && (
              <div className={`flex items-center justify-between p-3 rounded-lg ${
                isDark ? 'bg-white/5' : 'bg-gray-50'
              }`}>
                <div className="flex items-center gap-3">
                  <Avatar
                    src={getUserAvatar(dmPrivacyError.peer)}
                    alt={dmPrivacyError.peer.username}
                    className="w-10 h-10 rounded-full"
                    size="small"
                  />
                  <div>
                    <p className={`font-medium text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {dmPrivacyError.peer.displayName || dmPrivacyError.peer.username}
                    </p>
                    <p className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      @{dmPrivacyError.peer.username}
                    </p>
                  </div>
                </div>
                <FollowButton
                  targetUserId={dmPrivacyError.peer.tokenId}
                  initialIsFollowing={false}
                  size="small"
                />
              </div>
            )}

            {dmPrivacyError.reason === 'following' && (
              <p className={`text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                This user needs to follow you before you can message them.
              </p>
            )}

            <button
              onClick={() => setDmPrivacyError(null)}
              className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                isDark
                  ? 'bg-white/10 text-white hover:bg-white/20'
                  : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
              }`}
            >
              Got it
            </button>
          </div>
        )}
      </ModalWrapper>

      {/* Search Modal */}
      {showSearchModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setShowSearchModal(false)}
        >
          <div
            className={`w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-2xl transition-all duration-300 p-6 ${
              isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <div className="flex justify-between items-center mb-4">
              <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                Search Messages
              </h2>
              <button
                onClick={() => setShowSearchModal(false)}
                className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 ${
                  isDark ? 'text-white' : 'text-black'
                }`}
              >
                <HiOutlineX className="w-5 h-5" />
              </button>
            </div>

            {/* Message Search Component */}
            <MessageSearch
              userId={currentUser?.id}
              onSearchComplete={(results) => {
                console.log('Search results:', results)
              }}
            />
          </div>
        </div>
      )}
      <ModalWrapper isOpen={!!errorModal} onClose={() => setErrorModal(null)} usePortal>
        {errorModal && (
          <div className="p-6 text-center">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${
              isDark ? 'bg-red-500/20' : 'bg-red-100'
            }`}>
              <HiOutlineX className="w-6 h-6 text-red-500" />
            </div>
            <h2 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
              {errorModal.title}
            </h2>
            <p className={`text-sm mb-5 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              {errorModal.message}
            </p>
            <button
              onClick={() => setErrorModal(null)}
              className="px-6 py-2.5 rounded-lg font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-colors cursor-pointer"
            >
              OK
            </button>
          </div>
        )}
      </ModalWrapper>
    </MainLayout>
  )
}

export default MessagesPage
