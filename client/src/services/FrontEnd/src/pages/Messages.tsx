import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useAccount } from 'wagmi'
import { useSearchParams } from 'react-router-dom'
import ConnectButton from '~/components/buttons/ConnectButton'
import { apiFetch } from '~/api/client'
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
  const [isNewMessageModalOpen, setIsNewMessageModalOpen] = useState(false)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [messageSettings, setMessageSettings] = useState('Everyone')
  const [selectedUser, setSelectedUser] = useState<{name: string, handle: string, avatar: string} | null>(null)
  const [modalStep, setModalStep] = useState<'select' | 'compose'>('select')
  const [newMessageSearch, setNewMessageSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ tokenId: number, username: string, displayName?: string, avatarUrl?: string }>>([])
  const [recentFollows, setRecentFollows] = useState<Array<{ tokenId: number, username: string, displayName?: string, avatarUrl?: string }>>([])
  const [isSearching, setIsSearching] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [currentView, setCurrentView] = useState<'inbox' | 'chat' | 'setup'>('inbox')
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [newMessageContent, setNewMessageContent] = useState('')
  const [showChatOptionsMenu, setShowChatOptionsMenu] = useState(false)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [showFileUpload, setShowFileUpload] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const typingTimeoutRef = useRef<NodeJS.Timeout>()
  const chatMenuRef = useRef<HTMLDivElement>(null)
  const [targetUser, setTargetUser] = useState<{ tokenId: number, username: string } | null>(null)
  const [attemptedConversations, setAttemptedConversations] = useState<Set<string>>(new Set())

  // Get wallet address from wagmi
  const { address } = useAccount()

  // Get URL parameters
  const [searchParams, setSearchParams] = useSearchParams()

  // DM hooks
  const {
    isInitialized: identity,
    isLoading: identityLoading,
    initializeClient,
    conversations,
    error: dmError,
    startConversation: dmStartConversation,
    refreshConversations
  } = useDmClient(currentUser?.id)
  const { messages, sendMessage: dmSendMessage, isSending, markAsRead, addIncomingMessage } = useDmMessages(selectedConversationId || '', currentUser?.id)

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
      // Open existing conversation
      handleConversationSelect(existingConv.id)
      // Send the message
      dmSendMessage(messageText.trim())
    } else {
      // Start new conversation
      try {
        const newConv = await dmStartConversation(targetUser.tokenId)
        console.log('New conversation created:', newConv)
        // Select the new conversation
        handleConversationSelect(newConv.id)
        // Send the message
        dmSendMessage(messageText.trim())
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

    // Join new conversation room
    joinConversation(conversationId)

    // Mark messages as read
    const conversation = conversations.find(c => c.id === conversationId)
    if (conversation && conversation.unreadCount > 0) {
      // Mark messages as read will be called automatically by the hook
    }
  }

  // Function to go back to inbox
  const goBackToInbox = () => {
    // Leave conversation room
    if (selectedConversationId) {
      leaveConversation(selectedConversationId)
    }

    setCurrentView('inbox')
    setSelectedConversationId(null)
    setShowChatOptionsMenu(false)
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

  // Handle URL parameter for direct user messaging
  useEffect(() => {
    const userParam = searchParams.get('user')
    if (userParam && currentUser && identity && !identityLoading) {
      // Check if we've already attempted this user
      if (attemptedConversations.has(userParam)) {
        console.log('Already attempted conversation with:', userParam)
        return
      }

      // Mark as attempted immediately to prevent retries
      setAttemptedConversations(prev => new Set(prev).add(userParam))

      // Fetch user details
      fetch(`/api/users/${userParam}`)
        .then(res => res.json())
        .then(userData => {
          if (userData && !userData.error) {
            setTargetUser({ tokenId: userData.tokenId, username: userData.username })

            // Check if conversation already exists
            const existingConv = conversations.find(c =>
              c.type === 'DM' &&
              c.participants.some(p => p.userId === userData.tokenId)
            )

            if (existingConv) {
              // Select existing conversation and clear URL param
              handleConversationSelect(existingConv.id)
              setSearchParams(params => {
                params.delete('user')
                return params
              })
            } else {
              // Create new conversation
              console.log('Creating conversation with user:', userData)
              if (!identity) {
                console.log('DMs not initialized - user needs to enable DMs first')
                setCurrentView('setup')
              } else {
                // DMs already initialized, create conversation directly
                dmStartConversation(userData.tokenId)
                  .then((newConversation: any) => {
                    console.log('Conversation created:', newConversation)
                    handleConversationSelect(newConversation.id)
                    setSearchParams(params => {
                      params.delete('user')
                      return params
                    })
                  })
                  .catch((error: any) => {
                    console.error('Failed to create conversation:', error)
                    setSearchParams(params => {
                      params.delete('user')
                      return params
                    })
                  })
              }
            }
          } else {
            console.log('User not found:', userParam)
            // Clear URL param if user not found
            setSearchParams(params => {
              params.delete('user')
              return params
            })
          }
        })
        .catch(err => {
          console.error('Error fetching user:', err)
          // Clear URL param on error
          setSearchParams(params => {
            params.delete('user')
            return params
          })
        })
    }
  }, [searchParams, currentUser, identity, identityLoading, attemptedConversations, dmStartConversation, handleConversationSelect, conversations, setSearchParams])

  // Check if user needs to enable DMs
  useEffect(() => {
    // Only show setup view if:
    // 1. User is logged in
    // 2. DMs not initialized
    // 3. Correct wallet is connected (address matches activeToken)
    const hasCorrectWallet = activeToken && address && address.toLowerCase() === activeToken.address.toLowerCase()

    if (currentUser && !identityLoading && !identity && hasCorrectWallet) {
      setCurrentView('setup')
    } else if (currentUser && identity && currentView === 'setup') {
      // Only set to inbox if we're currently in setup view
      setCurrentView('inbox')
    } else if (currentView === 'setup' && !hasCorrectWallet) {
      // If in setup view but wrong wallet, go back to inbox
      setCurrentView('inbox')
    }
  }, [currentUser, identity, identityLoading, currentView, activeToken, address])

  // Load recent follows when new message modal opens
  useEffect(() => {
    if (isNewMessageModalOpen && currentUser?.username) {
      // Fetch recent follows
      apiFetch<{ items: Array<{ tokenId: number, username: string, displayName?: string, avatarUrl?: string }> }>(
        `/api/users/${currentUser.username}/following?limit=10`
      )
        .then(response => {
          setRecentFollows(response.items || [])
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
        .then(response => {
          setSearchResults(response.users || [])
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
    if (!currentUser || !address) return

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
                  {!address ? 'Please connect your wallet first.' : 'Sign a message to derive your encryption keys. This is a free, one-time setup.'}
                </p>
                {dmError && (
                  <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500">
                    <p className="text-red-500 text-sm">
                      {dmError.message || 'Failed to enable DMs. Please try again.'}
                    </p>
                  </div>
                )}
                {!address ? (
                  <ConnectButton />
                ) : activeToken && address.toLowerCase() !== activeToken.address.toLowerCase() ? (
                  <div className="flex flex-col items-center">
                    <button
                      disabled
                      className="px-6 py-3 rounded-full font-semibold bg-yellow-500/50 text-black transition-all duration-300 opacity-50 cursor-not-allowed"
                    >
                      Enable DMs
                    </button>
                    <p className="mt-3 text-sm text-yellow-500">
                      Please switch to the correct wallet address
                    </p>
                  </div>
                ) : (
                  <button
                    onClick={handleRegisterDm}
                    disabled={identityLoading}
                    className="px-6 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {identityLoading ? 'Enabling...' : 'Enable DMs'}
                  </button>
                )}
              </div>
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
                            Start a conversation
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
              {messages.map((message) => {
                console.log('Rendering message:', message);
                console.log('Message properties:', Object.keys(message));

                // Handle different content types
                let messageContent = '';
                let attachments = [];

                // Check if content is an object (system message or metadata)
                if (typeof message.content === 'object' && message.content !== null) {
                  // This is likely a system/metadata message, skip rendering it
                  console.log('Skipping system message:', message.content);
                  return null;
                }

                // Content is a string - parse it
                try {
                  const parsed = JSON.parse(message.content);
                  if (parsed.text !== undefined) {
                    messageContent = parsed.text;
                    attachments = parsed.attachments || [];
                  } else {
                    // JSON but not our format, convert to string
                    messageContent = JSON.stringify(parsed);
                  }
                } catch {
                  // Content is plain text
                  messageContent = message.content;
                }

                return (
                  <div
                    key={message.id}
                    className={`flex flex-col ${message.isFromCurrentUser ? 'items-end' : 'items-start'}`}
                  >
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
                        <HiOutlineLockClosed className="w-3 h-3 text-green-400" title="End-to-end encrypted" />

                        {/* Read receipt */}
                        {message.isFromCurrentUser && message.status === 'READ' && (
                          <HiOutlineCheckCircle className="w-3 h-3 text-blue-400" title="Read" />
                        )}
                      </div>

                      <p className="text-xs text-white/50 font-medium">
                        {formatMessageTime(message.createdAt)}
                      </p>
                    </div>
                  </div>
                )
              })}
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
                            onClick={() => handleSelectUserToMessage(user)}
                            className={`w-full px-4 py-3 flex items-center space-x-3 transition-all duration-300 hover:bg-gray-500/10 ${
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
                            onClick={() => handleSelectUserToMessage(user)}
                            className={`w-full px-4 py-3 flex items-center space-x-3 transition-all duration-300 hover:bg-gray-500/10 ${
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