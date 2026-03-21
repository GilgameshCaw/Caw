import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSearchParams, useParams, useNavigate } from 'react-router-dom'
import ConnectButton from '~/components/buttons/ConnectButton'
import Tooltip from '~/components/Tooltip'
import { apiFetch, API_HOST } from '~/api/client'
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
  HiOutlinePlus
} from 'react-icons/hi'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import {
  useDmClient,
  useDmMessages
} from '~/hooks/useDm'
import { useDmWebSocket } from '~/hooks/useDmWebSocket'
import { useMessageNotifications, useTypingStatus } from '~/hooks/useMessageNotifications'
import { formatDistanceToNow } from 'date-fns'
import MessageSearch from '~/components/MessageSearch'
import MessageFileUpload from '~/components/MessageFileUpload'

const MessagesPage: React.FC = () => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const currentUser = activeToken ? { id: activeToken.tokenId, username: activeToken.username } : null
  const { username: urlUsername } = useParams<{ username?: string }>()
  const navigate = useNavigate()
  const [isNewMessageModalOpen, setIsNewMessageModalOpen] = useState(false)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [messageSettings, setMessageSettings] = useState('Everyone')
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
  const [isTyping, setIsTyping] = useState(false)
  const typingTimeoutRef = useRef<NodeJS.Timeout>()
  const chatMenuRef = useRef<HTMLDivElement>(null)
  const [targetUser, setTargetUser] = useState<{ tokenId: number, username: string } | null>(null)
  const [attemptedConversations, setAttemptedConversations] = useState<Set<string>>(new Set())

  // Auth state
  const { verify, isVerifying, error: verifyError } = useVerifyWallet()
  const authorizedAddresses = useAuthStore(s => s.authorizedAddresses)
  const isWalletAuthorized = !!activeToken?.address && authorizedAddresses.includes(activeToken.address.toLowerCase())

  // Get wallet address from wagmi
  const { address } = useAccount()
  const { openConnectModal } = useConnectModal()

  // Get URL parameters
  const [searchParams, setSearchParams] = useSearchParams()

  // DM hooks
  const {
    isInitialized: identity,
    needsKeyDerivation,
    isLoading: identityLoading,
    initializeClient,
    conversations,
    error: dmError,
    startConversation: dmStartConversation,
    refreshConversations,
    clearUnreadCount
  } = useDmClient(currentUser?.id)
  const { messages, sendMessage: dmSendMessage, isSending, markAsRead, addIncomingMessage, peerLastReadAt } = useDmMessages(selectedConversationId || '', currentUser?.id)

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
    onNewMessage: addIncomingMessage
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
      avatar: user.avatarUrl || '/images/logo.jpeg'
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
        if (err.message?.includes('not enabled DMs')) {
          alert(`@${targetUser.username} hasn't enabled DMs yet. They need to enable DMs before you can message them.`)
        } else {
          alert(`Failed to start conversation: ${err.message || 'Unknown error'}`)
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
  }

  // Handle send message
  const handleSendMessage = () => {
    if (!newMessageContent.trim() || !selectedConversationId) return

    dmSendMessage(newMessageContent.trim())

    setNewMessageContent('')

    // Stop typing indicator
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }
    sendTyping(selectedConversationId, false)
  }

  // Handle file upload
  const handleFilesSelected = async (files: File[]) => {
    if (!selectedConversationId || files.length === 0) return

    // Create FormData for file upload
    const formData = new FormData()
    formData.append('conversationId', selectedConversationId)
    formData.append('senderId', currentUser?.id?.toString() || '')
    formData.append('content', newMessageContent)

    files.forEach(file => {
      formData.append('files', file)
    })

    try {
      // File attachments not yet supported in E2E encrypted DMs
      console.log('File upload not yet implemented for E2E encrypted DMs')
      alert('File attachments are not yet supported in encrypted DMs')

      setShowFileUpload(false)
      setNewMessageContent('')
    } catch (error) {
      console.error('Error sending files:', error)
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

  // Redirect legacy ?user= param to /messages/:username
  useEffect(() => {
    const userParam = searchParams.get('user')
    if (userParam) {
      navigate(`/messages/${userParam}`, { replace: true })
    }
  }, [searchParams, navigate])

  // Handle /messages/:username URL param — open conversation with that user
  useEffect(() => {
    if (!urlUsername || !currentUser || !identity || identityLoading) return
    if (attemptedConversations.has(urlUsername)) return

    setAttemptedConversations(prev => new Set(prev).add(urlUsername))

    // Check if we already have this conversation open
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
    } else {
      // Fetch user and create conversation
      fetch(`/api/users/${urlUsername}`)
        .then(res => res.json())
        .then(userData => {
          if (userData && !userData.error) {
            setTargetUser({ tokenId: userData.tokenId, username: userData.username })
            dmStartConversation(userData.tokenId)
              .then((newConv: any) => {
                setSelectedConversationId(newConv.id)
                setCurrentView('chat')
                joinConversation(newConv.id)
              })
              .catch((err: any) => {
                console.error('Failed to create conversation:', err)
                navigate('/messages', { replace: true })
              })
          } else {
            navigate('/messages', { replace: true })
          }
        })
        .catch(() => navigate('/messages', { replace: true }))
    }
  }, [urlUsername, currentUser, identity, identityLoading, conversations, attemptedConversations, dmStartConversation, selectedConversationId])

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

  // Route user through sign-in → DM setup → inbox
  useEffect(() => {
    if (!currentUser) return
    if (!isWalletAuthorized) {
      setCurrentView('signin')
    } else if (!identityLoading && !identity) {
      setCurrentView('setup')
    } else if (identity && (currentView === 'signin' || currentView === 'setup')) {
      setCurrentView('inbox')
    }
  }, [currentUser, isWalletAuthorized, identity, identityLoading])

  // Load recent follows when new message modal opens
  useEffect(() => {
    if (isNewMessageModalOpen && currentUser?.username) {
      // Fetch recent follows then check DM identity for each
      apiFetch<{ items: Array<{ tokenId: number, username: string, displayName?: string, avatarUrl?: string }> }>(
        `/api/users/${currentUser.username}/following?limit=10`
      )
        .then(async (response) => {
          const items = (response.items || []).filter(u => u.tokenId !== currentUser?.id)
          const withDm = await Promise.all(items.map(async (user) => {
            try {
              const res = await fetch(`${API_HOST}/api/dm/identity/${user.tokenId}`)
              const data = await res.json()
              return { ...user, hasDmIdentity: !!data.hasIdentity }
            } catch {
              return { ...user, hasDmIdentity: undefined }
            }
          }))
          setRecentFollows(withDm)
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
          const withDm = await Promise.all(users.map(async (user) => {
            try {
              const res = await fetch(`${API_HOST}/api/dm/identity/${user.tokenId}`)
              const data = await res.json()
              return { ...user, hasDmIdentity: !!data.hasIdentity }
            } catch {
              return { ...user, hasDmIdentity: undefined }
            }
          }))
          setSearchResults(withDm)
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
    if (!address) {
      openConnectModal?.()
      return
    }

    try {
      await initializeClient()
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
      console.error('Failed to enable DMs:', error)
      alert(`Failed to enable DMs: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Function to handle chat options menu actions
  const handleChatMenuAction = (action: string) => {
    setShowChatOptionsMenu(false)
    switch (action) {
      case 'block-user':
        console.log('Block user:', otherParticipant?.identity.user.username)
        break
      case 'mute-notifications':
        console.log('Mute notifications for:', otherParticipant?.identity.user.username)
        break
      case 'report':
        console.log('Report user:', otherParticipant?.identity.user.username)
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
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4 bg-black h-screen flex flex-col">
        {/* Messages Header */}
        <div className={`mb-6 flex-shrink-0 ${currentView === 'chat' ? 'fixed md:relative top-0 left-0 right-0 z-30 bg-black md:bg-transparent p-4 md:p-0' : ''}`}>
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
              <h1 className={`text-2xl font-bold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {currentView === 'inbox' ? 'Messages' : currentView === 'setup' ? 'Enable DMs' : otherParticipant?.identity.user.displayName || otherParticipant?.identity.user.username || 'Chat'}
              </h1>
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
                          <span className="text-sm font-medium">Mute notifications</span>
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
          <div className="mb-6 flex-shrink-0">
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
                <div className="w-9 h-9" style={{ backgroundColor: '#eab308', maskImage: 'url(/icons/crow-2.svg)', maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskImage: 'url(/icons/crow-2.svg)', WebkitMaskSize: 'contain', WebkitMaskRepeat: 'no-repeat', WebkitMaskPosition: 'center' }} />
              </div>
              <h2 className={`text-xl font-bold mb-3 ${isDark ? 'text-white' : 'text-black'}`}>
                Log In to Access Messages
              </h2>
              <p className={`mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {!address ? 'Connect your wallet to get started.' : 'Sign a free message to verify you own this wallet.'}
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
                  disabled={isVerifying}
                  className={`px-6 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 cursor-pointer ${isVerifying ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isVerifying ? 'Signing...' : 'Sign to Log In'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Setup View - Show when DMs are not enabled */}
        {currentView === 'setup' && (
          <div className="flex-1 flex flex-col items-center justify-center px-4">
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
                  Sign a message to derive your encryption keys. This is a free, one-time setup.
                </p>
                {dmError && (
                  <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500">
                    <p className="text-red-500 text-sm">
                      {dmError.message || 'Failed to enable DMs. Please try again.'}
                    </p>
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
                      <p className="text-sm text-red-400">Please switch to the wallet that owns this profile</p>
                    </div>
                  ) : !address ? (
                    <div className="flex flex-col items-center gap-2">
                      <button
                        onClick={() => openConnectModal?.()}
                        className="px-6 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 cursor-pointer"
                      >
                        Connect Wallet
                      </button>
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
          <div className={`mb-3 p-3 rounded-lg border flex items-center justify-between ${
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
        )}

        {/* Messages List - Only show in inbox view */}
        {currentView === 'inbox' && (
          <div className="space-y-1 flex-1 overflow-y-auto -mx-3 sm:mx-0 px-3 sm:px-0">
            {identityLoading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-500"></div>
              </div>
            ) : conversations.length === 0 ? (
              <div className="text-center py-8">
                <p className={`text-sm ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  No conversations yet
                </p>
                <p className={`text-xs mt-2 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Start a new message to begin a conversation
                </p>
              </div>
            ) : (
              conversations.map((conversation) => {
                const otherUser = conversation.type === 'DM'
                  ? conversation.participants.find(p => p.userId !== currentUser?.id)
                  : null

                return (
                  <div
                    key={conversation.id}
                    className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer"
                    onClick={() => handleConversationSelect(conversation.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-start space-x-3 flex-1">
                        <div className="flex-shrink-0">
                          {otherUser?.identity.user.image ? (
                            <img
                              src={otherUser.identity.user.image}
                              alt={otherUser.identity.user.username}
                              className="w-10 h-10 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center">
                              <span className="text-white font-semibold">
                                {(otherUser?.identity.user.username || 'U')[0].toUpperCase()}
                              </span>
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
          </div>
        )}

        {/* Chat View */}
        {currentView === 'chat' && selectedConversationId && (
          <div className="flex flex-col flex-1 md:flex-1 h-screen md:h-auto">
            {/* Encryption Status Banner */}
            <div className={`flex items-center justify-center py-2 px-4 ${
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

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto custom-scrollbar-alt space-y-4 p-4 md:p-4 pt-32 md:pt-4 pb-20 md:pb-4">
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

                return messages.map((message) => {
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

                  return (
                    <div key={message.id}>
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
                        <div
                          className={`max-w-md lg:max-w-xl px-6 py-4 rounded-2xl ${
                            message.isFromCurrentUser
                              ? 'bg-gray-600 text-white'
                              : isDark
                              ? 'bg-gray-700 text-white'
                              : 'bg-gray-200 text-black'
                          }`}
                        >
                          {/* Message text */}
                          {messageContent && <p className="text-sm">{messageContent}</p>}

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
                        </div>

                        {/* Message metadata with encryption indicator */}
                        <div className={`mt-1 px-2 flex items-center space-x-2 ${
                          message.isFromCurrentUser ? 'flex-row-reverse space-x-reverse' : 'flex-row'
                        }`}>
                          <div className="flex items-center space-x-1">
                            {/* Encryption indicator */}
                            <Tooltip text="End-to-end encrypted" position="top">
                              <HiOutlineLockClosed className="w-3 h-3 text-green-400" />
                            </Tooltip>

                            {/* Read receipt */}
                            {message.isFromCurrentUser && message.status === 'READ' && (
                              <Tooltip text="Read" position="top">
                                <HiOutlineCheckCircle className="w-3 h-3 text-blue-400" />
                              </Tooltip>
                            )}
                          </div>

                          <p className="text-xs text-white/50 font-medium">
                            {formatMessageTime(message.createdAt)}
                          </p>
                        </div>

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

            {/* File Upload Component - Show when enabled */}
            {showFileUpload && (
              <MessageFileUpload
                onFilesSelected={handleFilesSelected}
                onCancel={() => setShowFileUpload(false)}
                maxSize={10}
              />
            )}

            {/* Message Input - Fixed at bottom */}
            <div className="flex-shrink-0 border-t border-white/10 p-2 md:p-4 fixed md:relative bottom-0 left-0 right-0 z-20 bg-black md:bg-transparent">
              <div className={`flex items-center rounded-full border transition-all duration-300 focus-within:ring-2 focus-within:ring-gray-500/30 ${
                isDark
                  ? 'bg-black border-white/20'
                  : 'bg-white border-gray-300'
              }`}>
                {/* Left side icons - fixed area */}
                <div className="flex items-center space-x-3 px-3 py-3">
                  {/* Image icon */}
                  <button
                    onClick={() => setShowFileUpload(!showFileUpload)}
                    className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                      showFileUpload
                        ? isDark
                          ? 'text-yellow-400 bg-yellow-400/20'
                          : 'text-yellow-600 bg-yellow-200'
                        : isDark
                          ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                          : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50'
                    }`}>
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
                    </svg>
                  </button>

                  {/* GIF text */}
                  <button className={`px-2 py-1 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer ${
                    isDark
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50'
                  }`}>
                    GIF
                  </button>

                  {/* Emoji icon */}
                  <button className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                    isDark
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50'
                  }`}>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </button>
                </div>

                {/* Input area - where user can type */}
                <input
                  type="text"
                  placeholder="Start a new message"
                  value={newMessageContent}
                  onChange={(e) => handleInputChange(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                  className={`flex-1 py-3 pr-12 bg-transparent border-none outline-none ${
                    isDark
                      ? 'text-white placeholder-gray-500'
                      : 'text-black placeholder-gray-500'
                  }`}
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
          </div>
        )}
      </div>

      {/* New Message Modal */}
      {isNewMessageModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={closeModal}
        >
          <div
            className={`w-full max-w-md max-h-[80vh] flex flex-col rounded-2xl transition-all duration-300 ${
              isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
            }`}
            onClick={(e) => e.stopPropagation()}
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
                            <img
                              src={user.avatarUrl || '/images/logo.jpeg'}
                              alt={user.username}
                              className="w-10 h-10 rounded-full"
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
                            <img
                              src={user.avatarUrl || '/images/logo.jpeg'}
                              alt={user.username}
                              className="w-10 h-10 rounded-full"
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
                      className="w-10 h-10 rounded-full"
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
          </div>
        </div>
      )}

      {/* Message Settings Modal - Keep existing implementation */}
      {isSettingsModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={() => setIsSettingsModalOpen(false)}
        >
          <div
            className={`w-full max-w-md mx-4 rounded-2xl transition-all duration-300 ${
              isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Settings modal implementation remains the same */}
          </div>
        </div>
      )}

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
    </MainLayout>
  )
}

export default MessagesPage