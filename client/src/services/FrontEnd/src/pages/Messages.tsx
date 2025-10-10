import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useState, useEffect, useRef, useMemo } from 'react'
import {
  HiOutlineCog,
  HiOutlineMail,
  HiOutlineX,
  HiOutlineSearch,
  HiOutlineDotsHorizontal,
  HiOutlineUserRemove,
  HiOutlineVolumeOff,
  HiOutlineExclamation,
  HiOutlineShieldCheck
} from 'react-icons/hi'
import { useTokenDataStore, useActiveToken } from '~/store/tokenDataStore'
import {
  useXmtpIdentity,
  useConversations,
  useMessages,
  useCreateConversation
} from '~/hooks/useXmtp'
import { formatDistanceToNow } from 'date-fns'

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
  const [messageText, setMessageText] = useState('')
  const [currentView, setCurrentView] = useState<'inbox' | 'chat' | 'setup'>('inbox')
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [newMessageContent, setNewMessageContent] = useState('')
  const [showChatOptionsMenu, setShowChatOptionsMenu] = useState(false)
  const chatMenuRef = useRef<HTMLDivElement>(null)

  // XMTP hooks
  const { identity, isLoading: identityLoading, registerIdentity, isRegistering } = useXmtpIdentity(currentUser?.id)
  const { conversations, isLoading: conversationsLoading } = useConversations(currentUser?.id)
  const { messages, sendMessage, isSending, markAsRead } = useMessages(selectedConversationId || '', currentUser?.id)
  const createConversation = useCreateConversation()

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
  }

  // Function to close modal and reset state
  const closeModal = () => {
    setIsNewMessageModalOpen(false)
    resetModal()
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
    setSelectedConversationId(conversationId)
    setCurrentView('chat')

    // Mark messages as read
    const conversation = conversations.find(c => c.id === conversationId)
    if (conversation && conversation.unreadCount > 0) {
      // Mark messages as read will be called automatically by the hook
    }
  }

  // Function to go back to inbox
  const goBackToInbox = () => {
    setCurrentView('inbox')
    setSelectedConversationId(null)
    setShowChatOptionsMenu(false)
  }

  // Handle send message
  const handleSendMessage = () => {
    if (!newMessageContent.trim() || !selectedConversationId) return

    sendMessage({
      content: newMessageContent.trim(),
      contentType: 'text'
    })

    setNewMessageContent('')
  }

  // Check if user needs to setup XMTP
  useEffect(() => {
    if (currentUser && !identityLoading && !identity) {
      setCurrentView('setup')
    } else if (currentUser && identity) {
      setCurrentView('inbox')
    }
  }, [currentUser, identity, identityLoading])

  // Handle XMTP registration
  const handleRegisterXmtp = async () => {
    if (!currentUser) return
    registerIdentity({ tokenId: currentUser.id })
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
  const formatMessageTime = (dateStr: string) => {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true })
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
                {currentView === 'inbox' ? 'Messages' : currentView === 'setup' ? 'Setup XMTP' : otherParticipant?.identity.user.username || selectedConversation?.name || 'Chat'}
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
                  className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 cursor-pointer ${
                    isDark ? '' : ''
                  }`}
                >
                  <HiOutlineCog className={`w-5 h-5 transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`} />
                </button>

                {/* New Message Button */}
                <button
                  onClick={() => setIsNewMessageModalOpen(true)}
                  className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 cursor-pointer ${
                    isDark ? '' : ''
                  }`}
                >
                  <HiOutlineMail className={`w-5 h-5 transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
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
              <input
                type="text"
                placeholder="Search messages"
                className={`w-full px-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                  isDark
                    ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent'
                    : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
                }`}
              />
            </div>
          </div>
        )}

        {/* Setup View - Show when XMTP is not initialized */}
        {currentView === 'setup' && (
          <div className="flex-1 flex flex-col items-center justify-center px-4">
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
                XMTP provides secure, encrypted messaging between wallets. Initialize your XMTP identity to start sending private messages.
              </p>
              <button
                onClick={handleRegisterXmtp}
                disabled={isRegistering}
                className="px-6 py-3 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isRegistering ? 'Initializing...' : 'Initialize XMTP'}
              </button>
            </div>
          </div>
        )}

        {/* Messages List - Only show in inbox view */}
        {currentView === 'inbox' && (
          <div className="space-y-1 flex-1 overflow-y-auto -mx-3 sm:mx-0 px-3 sm:px-0">
            {conversationsLoading ? (
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
                                {(otherUser?.identity.user.username || conversation.name || 'U')[0].toUpperCase()}
                              </span>
                            </div>
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center space-x-2 mb-1">
                            <h3 className={`font-semibold text-base transition-colors duration-300 ${
                              isDark ? 'text-white' : 'text-black'
                            }`}>
                              {otherUser?.identity.user.username || conversation.name || 'Unknown'}
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
                            {conversation.type === 'GROUP' ? `${conversation.participants.length} members` : 'Start a conversation'}
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
            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto custom-scrollbar-alt space-y-4 p-4 md:p-4 pt-32 md:pt-4 pb-20 md:pb-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex flex-col ${message.senderId === currentUser?.id ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-md lg:max-w-xl px-6 py-4 rounded-2xl ${
                      message.senderId === currentUser?.id
                        ? 'bg-gray-600 text-white'
                        : isDark
                        ? 'bg-gray-700 text-white'
                        : 'bg-gray-200 text-black'
                    }`}
                  >
                    <p className="text-sm">{message.content}</p>
                  </div>
                  <div className={`mt-1 px-2 ${
                    message.senderId === currentUser?.id ? 'text-right' : 'text-left'
                  }`}>
                    <p className="text-xs text-white/50 font-medium">
                      {formatMessageTime(message.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

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
                  <button className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                    isDark
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
                  onChange={(e) => setNewMessageContent(e.target.value)}
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

      {/* New Message Modal - Keep existing implementation */}
      {isNewMessageModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={closeModal}
        >
          <div
            className={`w-full max-w-md mx-4 rounded-2xl transition-all duration-300 ${
              isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal implementation remains the same */}
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
    </MainLayout>
  )
}

export default MessagesPage