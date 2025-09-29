import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useState, useEffect } from 'react'
import MobileBottomNavbar from '~/components/MobileBottomNavbar'
import { 
  HiOutlineCog, 
  HiOutlineChatAlt2,
  HiOutlineSearch,
  HiOutlinePlus,
  HiOutlineUsers,
  HiOutlineDotsHorizontal
} from 'react-icons/hi'
import cawLogo from '~/assets/images/caw-logo.png'

const ChatPage: React.FC = () => {
  const { isDark } = useTheme()
  const [searchQuery, setSearchQuery] = useState('')
  const [activeBottomTab, setActiveBottomTab] = useState('chat')
  const [currentView, setCurrentView] = useState<'list' | 'chat'>('list')
  const [selectedChat, setSelectedChat] = useState<{
    id: string
    name: string
    isGroup: boolean
    avatar: string
    members?: number
    activeMembers?: number
  } | null>(null)
  const [showReactions, setShowReactions] = useState<string | null>(null)
  const [hoveredMessage, setHoveredMessage] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    messageId: string
    x: number
    y: number
  } | null>(null)
  const [showMoreEmojis, setShowMoreEmojis] = useState(false)
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [showNewChatOptionsModal, setShowNewChatOptionsModal] = useState(false)
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false)
  const [showJoinGroupModal, setShowJoinGroupModal] = useState(false)
  const [newChatStep, setNewChatStep] = useState<'select' | 'compose'>('select')
  const [selectedUser, setSelectedUser] = useState<{name: string, handle: string, avatar: string} | null>(null)
  const [messageText, setMessageText] = useState('')
  
  // Create Group states
  const [groupName, setGroupName] = useState('')
  const [isPrivateGroup, setIsPrivateGroup] = useState(false)
  const [groupLink, setGroupLink] = useState('')
  
  // Join Group states
  const [joinGroupSearch, setJoinGroupSearch] = useState('')
  const [joinGroupLink, setJoinGroupLink] = useState('')
  
  // Chat settings states
  const [allowMessagesFromEveryone, setAllowMessagesFromEveryone] = useState(true)
  const [readReceipts, setReadReceipts] = useState(true)
  const [pushNotifications, setPushNotifications] = useState(true)
  const [soundNotifications, setSoundNotifications] = useState(true)
  const [showOnlineStatus, setShowOnlineStatus] = useState(true)

  // Mock data for available groups to join
  const mockAvailableGroups = [
    {
      id: '1',
      name: 'Crypto Traders',
      description: 'Discussing latest crypto trends',
      members: 156,
      isPrivate: false,
      avatar: 'https://images.unsplash.com/photo-1560472354-b33ff0c44a43?w=40&h=40&fit=crop&crop=face'
    },
    {
      id: '2',
      name: 'DeFi Enthusiasts',
      description: 'DeFi protocols and yield farming',
      members: 89,
      isPrivate: false,
      avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=40&h=40&fit=crop&crop=face'
    },
    {
      id: '3',
      name: 'NFT Collectors',
      description: 'NFT marketplace and collections',
      members: 234,
      isPrivate: false,
      avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=40&h=40&fit=crop&crop=face'
    },
    {
      id: '4',
      name: 'Blockchain Developers',
      description: 'Smart contracts and dApps',
      members: 67,
      isPrivate: false,
      avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face'
    }
  ]

  // Mock data for followers
  const mockFollowers = [
    {
      id: '1',
      name: 'Alex Johnson',
      handle: '@alexjohnson',
      avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face',
      isOnline: true
    },
    {
      id: '2',
      name: 'Sarah Wilson',
      handle: '@sarahwilson',
      avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=40&h=40&fit=crop&crop=face',
      isOnline: false
    },
    {
      id: '3',
      name: 'Mike Chen',
      handle: '@mikechen',
      avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=40&h=40&fit=crop&crop=face',
      isOnline: true
    },
    {
      id: '4',
      name: 'Emma Davis',
      handle: '@emmadavis',
      avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=40&h=40&fit=crop&crop=face',
      isOnline: true
    },
    {
      id: '5',
      name: 'David Brown',
      handle: '@davidbrown',
      avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=40&h=40&fit=crop&crop=face',
      isOnline: false
    }
  ]

  // Mock data for chats
  const mockChats = [
    {
      id: '1',
      name: 'CAW - A Hunters Dream',
      lastMessage: 'Bitcoin is looking bullish today!',
      time: '2m',
      unread: 3,
      isGroup: true,
      avatar: cawLogo,
      members: 24,
      activeMembers: 8
    },
    {
      id: '2',
      name: 'Alex Johnson',
      lastMessage: 'Thanks for the help with the project',
      time: '1h',
      unread: 0,
      isGroup: false,
      avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face'
    },
    {
      id: '3',
      name: 'DeFi Discussion',
      lastMessage: 'New yield farming opportunities',
      time: '3h',
      unread: 1,
      isGroup: true,
      avatar: 'https://images.unsplash.com/photo-1560472354-b33ff0c44a43?w=40&h=40&fit=crop&crop=face',
      members: 12,
      activeMembers: 3
    },
    {
      id: '4',
      name: 'Sarah Wilson',
      lastMessage: 'Can we schedule a call?',
      time: '5h',
      unread: 0,
      isGroup: false,
      avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=40&h=40&fit=crop&crop=face'
    }
  ]

  // Mock data for chat messages
  const mockChatMessages = {
    '1': [ // CAW Group messages
      {
        id: '1',
        text: 'Bitcoin is looking bullish today!',
        sender: 'crypto_trader',
        senderName: 'Crypto Trader',
        timestamp: '2m',
        isOwn: false,
        avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face',
        reactions: [
          { emoji: '👍', count: 3, users: ['alex_johnson', 'defi_expert', 'crypto_trader'] },
          { emoji: '🚀', count: 2, users: ['alex_johnson', 'defi_expert'] }
        ]
      },
      {
        id: '2',
        text: 'I agree! The technical analysis shows strong support levels.',
        sender: 'current_user',
        senderName: 'You',
        timestamp: '1m',
        isOwn: true,
        avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=40&h=40&fit=crop&crop=face',
        reactions: [
          { emoji: '💯', count: 1, users: ['crypto_trader'] }
        ]
      },
      {
        id: '3',
        text: 'What about the DeFi sector? Any thoughts?',
        sender: 'defi_expert',
        senderName: 'DeFi Expert',
        timestamp: '30s',
        isOwn: false,
        avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=40&h=40&fit=crop&crop=face',
        reactions: []
      }
    ],
    '2': [ // Alex Johnson individual chat
      {
        id: '1',
        text: 'Thanks for the help with the project',
        sender: 'alex_johnson',
        senderName: 'Alex Johnson',
        timestamp: '1h',
        isOwn: false,
        avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face',
        reactions: [
          { emoji: '🙏', count: 1, users: ['current_user'] }
        ]
      },
      {
        id: '2',
        text: 'No problem! Happy to help. How is it going so far?',
        sender: 'current_user',
        senderName: 'You',
        timestamp: '45m',
        isOwn: true,
        avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=40&h=40&fit=crop&crop=face',
        reactions: []
      },
      {
        id: '3',
        text: 'Great! The implementation is working perfectly. We should be ready for launch next week.',
        sender: 'alex_johnson',
        senderName: 'Alex Johnson',
        timestamp: '30m',
        isOwn: false,
        avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face',
        reactions: [
          { emoji: '🎉', count: 2, users: ['current_user', 'alex_johnson'] },
          { emoji: '🔥', count: 1, users: ['current_user'] }
        ]
      }
    ]
  }

  // State for current messages (for reactions)
  const [currentMessages, setCurrentMessages] = useState(mockChatMessages)

  // Function to handle chat selection
  const handleChatSelect = (chat: {id: string, name: string, isGroup: boolean, avatar: string, members?: number, activeMembers?: number}) => {
    setSelectedChat(chat)
    setCurrentView('chat')
  }

  // Function to go back to chat list
  const goBackToList = () => {
    setCurrentView('list')
    setSelectedChat(null)
  }

  // Function to open config modal
  const openConfigModal = () => {
    setShowConfigModal(true)
  }

  // Function to close config modal
  const closeConfigModal = () => {
    setShowConfigModal(false)
  }

  // Function to open new chat options modal
  const openNewChatOptionsModal = () => {
    setShowNewChatOptionsModal(true)
  }

  // Function to close new chat options modal
  const closeNewChatOptionsModal = () => {
    setShowNewChatOptionsModal(false)
  }

  // Function to open new chat flow modal
  const openNewChatFlowModal = () => {
    setShowNewChatOptionsModal(false)
    setNewChatStep('select')
    setSelectedUser(null)
    setMessageText('')
    setSearchQuery('')
    setShowNewChatModal(true)
  }

  // Function to close new chat flow modal
  const closeNewChatFlowModal = () => {
    setShowNewChatModal(false)
    setNewChatStep('select')
    setSelectedUser(null)
    setMessageText('')
    setSearchQuery('')
  }

  // Function to open create group modal
  const openCreateGroupModal = () => {
    setShowNewChatOptionsModal(false)
    setGroupName('')
    setIsPrivateGroup(false)
    setGroupLink('')
    setShowCreateGroupModal(true)
  }

  // Function to close create group modal
  const closeCreateGroupModal = () => {
    setShowCreateGroupModal(false)
    setGroupName('')
    setIsPrivateGroup(false)
    setGroupLink('')
  }

  // Function to create group
  const handleCreateGroup = () => {
    if (groupName.trim()) {
      closeCreateGroupModal()
    }
  }

  // Function to open join group modal
  const openJoinGroupModal = () => {
    setShowNewChatOptionsModal(false)
    setJoinGroupSearch('')
    setJoinGroupLink('')
    setShowJoinGroupModal(true)
  }

  // Function to close join group modal
  const closeJoinGroupModal = () => {
    setShowJoinGroupModal(false)
    setJoinGroupSearch('')
    setJoinGroupLink('')
  }

  // Function to join group
  const handleJoinGroup = (groupId?: string, groupLink?: string) => {
    if (groupId || groupLink?.trim()) {
      closeJoinGroupModal()
    }
  }

  // Function to handle user selection
  const handleUserSelect = (user: {name: string, handle: string, avatar: string}) => {
    setSelectedUser(user)
  }

  // Function to go to compose step
  const goToCompose = () => {
    if (selectedUser) {
      setNewChatStep('compose')
    }
  }

  // Function to go back to select step
  const goBackToSelect = () => {
    setNewChatStep('select')
  }

  // Function to send message
  const handleSendMessage = () => {
    if (messageText.trim() && selectedUser) {
      // Here you would send the message to the backend
      closeNewChatFlowModal()
    }
  }

  // Function to handle reaction toggle
  const handleReactionToggle = (messageId: string, emoji: string) => {
    // Here you would update the message reactions in your state/backend
  }

  // Function to add new reaction
  const handleAddReaction = (messageId: string, emoji: string) => {
    // Find the message and add the reaction
    const updatedMessages = { ...currentMessages }
    const chatId = selectedChat?.id
    if (chatId && updatedMessages[chatId]) {
      const messageIndex = updatedMessages[chatId].findIndex(msg => msg.id === messageId)
      if (messageIndex !== -1) {
        const message = { ...updatedMessages[chatId][messageIndex] }
        const existingReaction = message.reactions?.find(r => r.emoji === emoji)
        
        if (existingReaction) {
          // Increment count if reaction exists
          existingReaction.count += 1
          if (!existingReaction.users.includes('current_user')) {
            existingReaction.users.push('current_user')
          }
        } else {
          // Add new reaction
          if (!message.reactions) {
            message.reactions = []
          }
          message.reactions.push({
            emoji,
            count: 1,
            users: ['current_user']
          })
        }
        
        // Update the message in the array
        updatedMessages[chatId][messageIndex] = message
        setCurrentMessages(updatedMessages)
      }
    }
  }

  // Available reaction emojis
  const reactionEmojis = ['👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🎉', '🚀', '🔥', '💯', '🙏']

  // Function to handle right-click context menu
  const handleContextMenu = (e: React.MouseEvent, messageId: string) => {
    e.preventDefault()
    setContextMenu({
      messageId,
      x: e.clientX,
      y: e.clientY
    })
  }

  // Function to close context menu
  const closeContextMenu = () => {
    setContextMenu(null)
    setShowMoreEmojis(false)
  }

  // Function to handle reaction from context menu
  const handleContextReaction = (messageId: string, emoji: string) => {
    handleAddReaction(messageId, emoji)
    closeContextMenu()
  }

  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu) return
    
    function handleClickOutside(event: MouseEvent) {
      setContextMenu(null)
      setShowMoreEmojis(false)
    }
    
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [contextMenu])

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4 bg-black h-screen flex flex-col">
                {/* Chat Header */}
                <div className="mb-6 flex-shrink-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      {currentView === 'chat' && (
                        <button
                          onClick={goBackToList}
                          className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 cursor-pointer ${
                            isDark ? 'text-white' : 'text-black'
                          }`}
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                          </svg>
                        </button>
                      )}
                      <div className="flex flex-col">
                        <h1 className={`text-2xl font-bold transition-colors duration-300 ${
                          isDark ? 'text-white' : 'text-black'
                        }`}>
                          {currentView === 'chat' ? selectedChat?.name || 'Chat' : 'Chat'}
                        </h1>
                        {currentView === 'chat' && selectedChat?.isGroup && (
                          <div className="flex items-center space-x-2 mt-1">
                            <span className={`text-sm transition-colors duration-300 ${
                              isDark ? 'text-gray-400' : 'text-gray-600'
                            }`}>
                              {selectedChat.members || 24} members
                            </span>
                            <span className={`text-xs transition-colors duration-300 ${
                              isDark ? 'text-gray-500' : 'text-gray-500'
                            }`}>
                              •
                            </span>
                            <span className={`text-sm transition-colors duration-300 ${
                              isDark ? 'text-green-400' : 'text-green-600'
                            }`}>
                              {selectedChat.activeMembers || 8} active
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    {currentView === 'list' && (
                      <div className="flex items-center space-x-3">
                        {/* Configuration Button */}
                        <button 
                          onClick={openConfigModal}
                          className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 cursor-pointer ${
                            isDark ? 'text-white' : 'text-black'
                          }`}
                        >
                          <HiOutlineCog className="w-5 h-5" />
                        </button>
                        
                        {/* New Chat Button */}
                        <button 
                          onClick={openNewChatOptionsModal}
                          className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/20 cursor-pointer ${
                            isDark ? 'text-white' : 'text-black'
                          }`}
                        >
                          <HiOutlinePlus className="w-5 h-5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

        {/* Search Bar - Only show in list view */}
        {currentView === 'list' && (
          <div className="mb-6 flex-shrink-0">
            <div className="relative">
              <HiOutlineSearch className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-all duration-300 ${
                isDark ? 'text-white/70' : 'text-gray-600'
              }`} />
              <input
                type="text"
                placeholder="Search chats..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`w-full pl-10 pr-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                  isDark 
                    ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent' 
                    : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
                }`}
              />
            </div>
          </div>
        )}

        {/* Groups Section - Only show in list view */}
        {currentView === 'list' && (
          <div className="mb-6 flex-shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className={`text-lg font-semibold transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              Groups
            </h2>
            <button className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'
            }`}>
              See all
            </button>
          </div>
          
          <div className="flex space-x-4 overflow-x-auto pb-2">
            {/* CAW Group */}
            <div 
              className="flex-shrink-0 text-center cursor-pointer"
              onClick={() => handleChatSelect(mockChats[0])}
            >
              <div className="relative inline-block">
                <img
                  src={cawLogo}
                  alt="CAW - A Hunters Dream"
                  className="w-12 h-12 rounded-full object-cover"
                />
                <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${
                  isDark ? 'bg-green-500 border-black' : 'bg-green-500 border-white'
                }`} />
              </div>
              <p className={`text-xs mt-2 font-medium transition-colors duration-300 ${
                isDark ? 'text-gray-300' : 'text-gray-700'
              }`}>
                CAW - A Hunters...
              </p>
              <p className={`text-xs transition-colors duration-300 ${
                isDark ? 'text-gray-500' : 'text-gray-500'
              }`}>
                24 members
              </p>
            </div>

            {/* DeFi Discussion Group */}
            <div className="flex-shrink-0 text-center cursor-pointer">
              <div className="relative inline-block">
                <img
                  src="https://images.unsplash.com/photo-1560472354-b33ff0c44a43?w=40&h=40&fit=crop&crop=face"
                  alt="DeFi Discussion"
                  className="w-12 h-12 rounded-full object-cover"
                />
                <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${
                  isDark ? 'bg-green-500 border-black' : 'bg-green-500 border-white'
                }`} />
              </div>
              <p className={`text-xs mt-2 font-medium transition-colors duration-300 ${
                isDark ? 'text-gray-300' : 'text-gray-700'
              }`}>
                DeFi Discussion
              </p>
              <p className={`text-xs transition-colors duration-300 ${
                isDark ? 'text-gray-500' : 'text-gray-500'
              }`}>
                12 members
              </p>
            </div>

            {/* NFT Community Group */}
            <div className="flex-shrink-0 text-center cursor-pointer">
              <div className="relative inline-block">
                <img
                  src="https://images.unsplash.com/photo-1560472354-b33ff0c44a43?w=40&h=40&fit=crop&crop=face"
                  alt="NFT Community"
                  className="w-12 h-12 rounded-full object-cover"
                />
                <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${
                  isDark ? 'bg-green-500 border-black' : 'bg-green-500 border-white'
                }`} />
              </div>
              <p className={`text-xs mt-2 font-medium transition-colors duration-300 ${
                isDark ? 'text-gray-300' : 'text-gray-700'
              }`}>
                NFT Community
              </p>
              <p className={`text-xs transition-colors duration-300 ${
                isDark ? 'text-gray-500' : 'text-gray-500'
              }`}>
                8 members
              </p>
            </div>
          </div>
        </div>
        )}

        {/* Chats List - Only show in list view */}
        {currentView === 'list' && (
        <div className="flex-1 overflow-y-auto -mx-3 sm:mx-0 px-3 sm:px-0">
          <div className="space-y-1">
            {mockChats.map((chat) => (
              <div
                key={chat.id}
                        onClick={() => handleChatSelect({
                          id: chat.id,
                          name: chat.name,
                          isGroup: chat.isGroup,
                          avatar: chat.avatar,
                          members: chat.members,
                          activeMembers: chat.activeMembers
                        })}
                className={`p-3 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer ${
                  chat.unread > 0 ? 'bg-gray-500/10' : ''
                }`}
              >
                <div className="flex items-center space-x-3">
                  {/* Avatar */}
                  <div className="relative flex-shrink-0">
                    <img
                      src={chat.avatar}
                      alt={chat.name}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                    {chat.isGroup && (
                      <div className={`absolute -bottom-2 -right-2 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        isDark ? 'bg-blue-500 border-black' : 'bg-blue-500 border-white'
                      }`}>
                        <HiOutlineUsers className="w-2 h-2 text-white" />
                      </div>
                    )}
                  </div>
                  
                  {/* Chat Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className={`font-semibold text-base transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        {chat.name}
                      </h3>
                      <div className="flex items-center space-x-2">
                        <span className={`text-sm transition-colors duration-300 ${
                          isDark ? 'text-gray-500' : 'text-gray-500'
                        }`}>
                          {chat.time}
                        </span>
                        {chat.unread > 0 && (
                          <span className="bg-red-500 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[20px] h-5 flex items-center justify-center">
                            {chat.unread}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className={`text-sm transition-colors duration-300 ${
                      isDark ? 'text-gray-300' : 'text-gray-700'
                    }`}>
                      {chat.lastMessage}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        )}

        {/* Individual Chat View */}
        {currentView === 'chat' && selectedChat && (
          <div className="flex flex-col flex-1 h-screen">
            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto custom-scrollbar-alt space-y-3 p-4 pb-20">
              {currentMessages[selectedChat.id as keyof typeof currentMessages]?.map((message) => (
                <div
                  key={message.id}
                  className="flex items-start space-x-3 group"
                  onMouseEnter={() => setHoveredMessage(message.id)}
                  onMouseLeave={() => setHoveredMessage(null)}
                >
                  {/* Avatar - Always on the left */}
                  <img
                    src={message.avatar}
                    alt={message.senderName}
                    className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                  />
                  
                  {/* Message Content */}
                  <div className="flex-1 max-w-md lg:max-w-xl relative">
                    {/* Sender name for groups */}
                    {selectedChat.isGroup && (
                      <p className="text-xs font-semibold mb-1 opacity-70 text-white/70">
                        {message.senderName}
                      </p>
                    )}
                    
                    {/* Message bubble with reaction button */}
                    <div className="flex items-start gap-2 relative">
                      <div
                        onContextMenu={(e) => handleContextMenu(e, message.id)}
                        className={`px-4 py-3 rounded-2xl inline-block ${
                          isDark
                            ? 'bg-gray-700 text-white'
                            : 'bg-gray-200 text-black'
                        }`}
                      >
                        <p className="text-sm">{message.text}</p>
                      </div>
                      
                      {/* Reaction button - appears on hover */}
                      {hoveredMessage === message.id && (
                        <button
                          onClick={() => setShowReactions(showReactions === message.id ? null : message.id)}
                          className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                            isDark
                              ? 'bg-gray-600 hover:bg-gray-500 text-white'
                              : 'bg-gray-100 hover:bg-gray-200 text-black'
                          }`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </button>
                      )}
                      
                      {/* Reaction picker - positioned above the emoji icon */}
                      {showReactions === message.id && (
                        <div className={`absolute z-50 p-2 rounded-lg shadow-lg border bottom-full mb-2 left-1/2 transform -translate-x-1/2 ${
                          isDark 
                            ? 'bg-black border-white/20' 
                            : 'bg-white border-gray-200'
                        }`}>
                          <div className="flex space-x-1">
                            {reactionEmojis.slice(0, 5).map((emoji) => (
                              <button
                                key={emoji}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleAddReaction(message.id, emoji)
                                  // Don't close the modal - keep it open
                                }}
                                className="p-1 hover:bg-gray-500/20 rounded transition-all duration-200 cursor-pointer"
                              >
                                {emoji}
                              </button>
                            ))}
                            
                            {/* More button */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setShowMoreEmojis(!showMoreEmojis)
                              }}
                              className={`p-1 hover:bg-gray-500/20 rounded transition-all duration-200 cursor-pointer ${
                                isDark ? 'text-gray-300' : 'text-gray-600'
                              }`}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    
                    {/* Reactions - Always below the message bubble */}
                    {message.reactions && message.reactions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {message.reactions.map((reaction, index) => (
                          <button
                            key={index}
                            onClick={() => handleReactionToggle(message.id, reaction.emoji)}
                            className={`px-2 py-1 rounded-full text-xs transition-all duration-200 cursor-pointer ${
                              isDark
                                ? 'bg-gray-600 hover:bg-gray-500 text-white'
                                : 'bg-gray-100 hover:bg-gray-200 text-black'
                              }`}
                          >
                            {reaction.emoji} {reaction.count}
                          </button>
                        ))}
                      </div>
                    )}
                    
                    {/* Timestamp */}
                    <p className="text-xs text-white/50 font-medium mt-1">
                      {message.timestamp}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Message Input - Fixed above navbar */}
            <div className="flex-shrink-0 border-t border-white/10 px-1 py-3 md:p-6 fixed md:relative bottom-16 left-0 right-0 z-40 bg-black md:bg-transparent">
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
                  className={`flex-1 py-3 pr-4 md:pr-12 bg-transparent border-none outline-none ${
                    isDark 
                      ? 'text-white placeholder-gray-500' 
                      : 'text-black placeholder-gray-500'
                  }`}
                />
                
                {/* Send button */}
                <button className={`p-2 mr-0 md:mr-1 rounded-full transition-all duration-200 cursor-pointer flex-shrink-0 ${
                  isDark 
                    ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10' 
                    : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50'
                }`}>
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <>
          {/* Overlay to close context menu */}
          <div 
            className="fixed inset-0 z-40"
            onClick={closeContextMenu}
          />
          
          {/* Context Menu */}
          <div
            className="fixed z-50"
            style={{
              left: contextMenu.x,
              top: contextMenu.y - 60,
              transform: 'translateX(-50%)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative">
              {/* Main emoji bar */}
              <div className={`px-4 py-2 rounded-full shadow-lg border flex items-center gap-1 ${
                isDark 
                  ? 'bg-gray-800 border-gray-600' 
                  : 'bg-white border-gray-300'
              }`}>
                {/* First 5 emojis */}
                {reactionEmojis.slice(0, 5).map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => handleContextReaction(contextMenu.messageId, emoji)}
                    className="p-2 hover:bg-gray-500/20 rounded-full transition-all duration-200 cursor-pointer text-lg"
                  >
                    {emoji}
                  </button>
                ))}
                
                {/* More button */}
                <button
                  onClick={() => setShowMoreEmojis(!showMoreEmojis)}
                  className={`p-2 hover:bg-gray-500/20 rounded-full transition-all duration-200 cursor-pointer ${
                    isDark ? 'text-gray-300' : 'text-gray-600'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>
              
              {/* More emojis dropdown */}
              {showMoreEmojis && (
                <div className={`absolute top-full left-0 mt-2 px-4 py-2 rounded-lg shadow-lg border flex items-center gap-1 ${
                  isDark 
                    ? 'bg-gray-800 border-gray-600' 
                    : 'bg-white border-gray-300'
                }`}>
                  {reactionEmojis.slice(5).map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => handleContextReaction(contextMenu.messageId, emoji)}
                      className="p-2 hover:bg-gray-500/20 rounded-full transition-all duration-200 cursor-pointer text-lg"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

              {/* Configuration Modal */}
              {showConfigModal && (
                <div 
                  className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
                  onClick={closeConfigModal}
                >
                  <div 
                    className={`w-full max-w-md mx-4 rounded-2xl transition-all duration-300 ${
                      isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Modal Header */}
                    <div className="flex items-center justify-between p-6 border-b border-white/10">
                      <h2 className={`text-xl font-bold transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        Chat Settings
                      </h2>
                      <button
                        onClick={closeConfigModal}
                        className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 cursor-pointer ${
                          isDark ? 'text-white' : 'text-black'
                        }`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* Modal Content */}
                    <div className="p-6">
                      <div className="space-y-6">
                        {/* Message Settings */}
                        <div className="space-y-4">
                          <h3 className={`text-sm font-medium mb-3 transition-colors duration-300 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            Message Settings
                          </h3>
                          
                          {/* Allow messages from everyone */}
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <p className={`text-sm font-medium transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Allow messages from everyone
                              </p>
                              <p className={`text-xs transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Let anyone send you messages
                              </p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={allowMessagesFromEveryone}
                                onChange={(e) => setAllowMessagesFromEveryone(e.target.checked)}
                              />
                              <div className={`w-11 h-6 rounded-full peer transition-all duration-300 ${
                                allowMessagesFromEveryone
                                  ? 'bg-yellow-500' 
                                  : isDark 
                                    ? 'bg-gray-600' 
                                    : 'bg-gray-300'
                              }`}>
                                <div className={`absolute top-0.5 bg-white w-5 h-5 rounded-full transition-transform duration-300 ${
                                  allowMessagesFromEveryone ? 'left-6' : 'left-0.5'
                                }`}></div>
                              </div>
                            </label>
                          </div>

                          {/* Read receipts */}
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <p className={`text-sm font-medium transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Read receipts
                              </p>
                              <p className={`text-xs transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Show when messages are read
                              </p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={readReceipts}
                                onChange={(e) => setReadReceipts(e.target.checked)}
                              />
                              <div className={`w-11 h-6 rounded-full peer transition-all duration-300 ${
                                readReceipts
                                  ? 'bg-yellow-500' 
                                  : isDark 
                                    ? 'bg-gray-600' 
                                    : 'bg-gray-300'
                              }`}>
                                <div className={`absolute top-0.5 bg-white w-5 h-5 rounded-full transition-transform duration-300 ${
                                  readReceipts ? 'left-6' : 'left-0.5'
                                }`}></div>
                              </div>
                            </label>
                          </div>
                        </div>

                        {/* Notification Settings */}
                        <div className="space-y-4">
                          <h3 className={`text-sm font-medium mb-3 transition-colors duration-300 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            Notification Settings
                          </h3>
                          
                          {/* Push notifications */}
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <p className={`text-sm font-medium transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Push notifications
                              </p>
                              <p className={`text-xs transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Receive notifications for new messages
                              </p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={pushNotifications}
                                onChange={(e) => setPushNotifications(e.target.checked)}
                              />
                              <div className={`w-11 h-6 rounded-full peer transition-all duration-300 ${
                                pushNotifications
                                  ? 'bg-yellow-500' 
                                  : isDark 
                                    ? 'bg-gray-600' 
                                    : 'bg-gray-300'
                              }`}>
                                <div className={`absolute top-0.5 bg-white w-5 h-5 rounded-full transition-transform duration-300 ${
                                  pushNotifications ? 'left-6' : 'left-0.5'
                                }`}></div>
                              </div>
                            </label>
                          </div>

                          {/* Sound notifications */}
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <p className={`text-sm font-medium transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Sound notifications
                              </p>
                              <p className={`text-xs transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Play sound for new messages
                              </p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={soundNotifications}
                                onChange={(e) => setSoundNotifications(e.target.checked)}
                              />
                              <div className={`w-11 h-6 rounded-full peer transition-all duration-300 ${
                                soundNotifications
                                  ? 'bg-yellow-500' 
                                  : isDark 
                                    ? 'bg-gray-600' 
                                    : 'bg-gray-300'
                              }`}>
                                <div className={`absolute top-0.5 bg-white w-5 h-5 rounded-full transition-transform duration-300 ${
                                  soundNotifications ? 'left-6' : 'left-0.5'
                                }`}></div>
                              </div>
                            </label>
                          </div>

                          {/* Online status */}
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <p className={`text-sm font-medium transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Show online status
                              </p>
                              <p className={`text-xs transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Let others see when you're online
                              </p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={showOnlineStatus}
                                onChange={(e) => setShowOnlineStatus(e.target.checked)}
                              />
                              <div className={`w-11 h-6 rounded-full peer transition-all duration-300 ${
                                showOnlineStatus
                                  ? 'bg-yellow-500' 
                                  : isDark 
                                    ? 'bg-gray-600' 
                                    : 'bg-gray-300'
                              }`}>
                                <div className={`absolute top-0.5 bg-white w-5 h-5 rounded-full transition-transform duration-300 ${
                                  showOnlineStatus ? 'left-6' : 'left-0.5'
                                }`}></div>
                              </div>
                            </label>
                          </div>
                        </div>

                        {/* Blocked Users Section */}
                        <div className="space-y-4">
                          <h3 className={`text-sm font-medium mb-3 transition-colors duration-300 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            Blocked Users
                          </h3>
                          
                          <div className="flex items-center justify-between">
                            <div>
                              <p className={`font-medium transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Manage Blocked Users
                              </p>
                              <p className={`text-sm transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                View and manage blocked contacts
                              </p>
                            </div>
                            <button className={`px-4 py-2 rounded-lg transition-all duration-300 cursor-pointer ${
                              isDark 
                                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' 
                                : 'bg-red-100 text-red-600 hover:bg-red-200'
                            }`}>
                              Manage
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Modal Footer */}
                    <div className="flex justify-end space-x-3 p-6 border-t border-white/10">
                      <button
                        onClick={closeConfigModal}
                        className="px-6 py-2 rounded-full font-medium transition-all duration-300 border border-white/20 text-white hover:bg-gray-500/20 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          // Handle save logic here
                          console.log('Saving chat settings')
                          closeConfigModal()
                        }}
                        className="px-6 py-2 rounded-full font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 cursor-pointer"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* New Chat Options Modal */}
              {showNewChatOptionsModal && (
                <div 
                  className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
                  onClick={closeNewChatOptionsModal}
                >
                  <div 
                    className={`w-full max-w-md mx-4 rounded-2xl transition-all duration-300 ${
                      isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Modal Header */}
                    <div className="flex items-center justify-between p-6 border-b border-white/10">
                      <h2 className={`text-xl font-bold transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        New Chat
                      </h2>
                      <button
                        onClick={closeNewChatOptionsModal}
                        className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 cursor-pointer ${
                          isDark ? 'text-white' : 'text-black'
                        }`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* Modal Content */}
                    <div className="p-6">
                      <div className="space-y-4">
                        {/* Create Individual Chat */}
                        <button 
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            console.log('New Chat button clicked')
                            openNewChatFlowModal()
                          }}
                          className={`w-full p-4 rounded-lg border transition-all duration-300 cursor-pointer hover:bg-white/5 ${
                            isDark 
                              ? 'bg-white/10 border-white/20 hover:bg-white/15' 
                              : 'bg-white/50 border-white/30 hover:bg-white/60'
                          }`}
                        >
                          <div className="flex items-center space-x-4">
                            <svg className="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            <div className="text-left">
                              <h3 className={`font-semibold transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                New Chat
                              </h3>
                              <p className={`text-sm transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Start a conversation with someone
                              </p>
                            </div>
                          </div>
                        </button>

                        {/* Create Group */}
                        <button 
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            openCreateGroupModal()
                          }}
                          className={`w-full p-4 rounded-lg border transition-all duration-300 cursor-pointer hover:bg-white/5 ${
                            isDark 
                              ? 'bg-white/10 border-white/20 hover:bg-white/15' 
                              : 'bg-white/50 border-white/30 hover:bg-white/60'
                          }`}
                        >
                          <div className="flex items-center space-x-4">
                            <svg className="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                            </svg>
                            <div className="text-left">
                              <h3 className={`font-semibold transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Create Group
                              </h3>
                              <p className={`text-sm transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Start a group conversation
                              </p>
                            </div>
                          </div>
                        </button>

                        {/* Join Group */}
                        <button 
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            openJoinGroupModal()
                          }}
                          className={`w-full p-4 rounded-lg border transition-all duration-300 cursor-pointer hover:bg-white/5 ${
                            isDark 
                              ? 'bg-white/10 border-white/20 hover:bg-white/15' 
                              : 'bg-white/50 border-white/30 hover:bg-white/60'
                          }`}
                        >
                          <div className="flex items-center space-x-4">
                            <svg className="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                            </svg>
                            <div className="text-left">
                              <h3 className={`font-semibold transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Join Group
                              </h3>
                              <p className={`text-sm transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Join an existing group with a link
                              </p>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>

                    {/* Modal Footer */}
                    <div className="flex justify-end space-x-3 p-6 border-t border-white/10">
                      <button
                        onClick={closeNewChatOptionsModal}
                        className="px-6 py-2 rounded-full font-medium transition-all duration-300 border border-white/20 text-white hover:bg-gray-500/20 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* New Chat Flow Modal */}
              {showNewChatModal && (
                <div 
                  className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
                  onClick={closeNewChatFlowModal}
                >
                  <div 
                    className={`w-full max-w-md mx-4 rounded-2xl transition-all duration-300 ${
                      isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Modal Header */}
                    <div className="flex items-center justify-between p-6 border-b border-white/10">
                      <h2 className={`text-xl font-bold transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        New Chat
                      </h2>
                      <button
                        onClick={closeNewChatFlowModal}
                        className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 cursor-pointer ${
                          isDark ? 'text-white' : 'text-black'
                        }`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* Modal Content */}
                    <div className="p-6">
                      {newChatStep === 'select' ? (
                        <>
                          {/* Search Bar */}
                          <div className="mb-6">
                            <div className="relative">
                              <HiOutlineSearch className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-all duration-300 ${
                                isDark ? 'text-white/70' : 'text-gray-600'
                              }`} />
                              <input
                                type="text"
                                placeholder="Search followers..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className={`w-full pl-10 pr-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                                  isDark 
                                    ? 'bg-white/10 border-white/20 text-white placeholder-gray-400 focus:bg-white/15' 
                                    : 'bg-white/50 border-white/30 text-black placeholder-gray-500 focus:bg-white/60'
                                }`}
                              />
                            </div>
                          </div>

                          {/* Followers List */}
                          <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
                            {mockFollowers
                              .filter(follower => 
                                follower.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                follower.handle.toLowerCase().includes(searchQuery.toLowerCase())
                              )
                              .map((follower) => (
                                <div
                                  key={follower.id}
                                  onClick={() => handleUserSelect(follower)}
                                  className={`p-3 rounded-lg transition-all duration-300 cursor-pointer hover:bg-white/5 ${
                                    selectedUser?.id === follower.id
                                      ? 'bg-white/10 border border-white/20'
                                      : 'hover:bg-white/5'
                                  }`}
                                >
                                  <div className="flex items-center space-x-3">
                                    <div className="relative">
                                      <img
                                        src={follower.avatar}
                                        alt={follower.name}
                                        className="w-10 h-10 rounded-full object-cover"
                                      />
                                      {follower.isOnline && (
                                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-black"></div>
                                      )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <h3 className={`font-semibold text-sm transition-colors duration-300 ${
                                        isDark ? 'text-white' : 'text-black'
                                      }`}>
                                        {follower.name}
                                      </h3>
                                      <p className={`text-xs transition-colors duration-300 ${
                                        isDark ? 'text-gray-400' : 'text-gray-600'
                                      }`}>
                                        {follower.handle}
                                      </p>
                                    </div>
                                    {selectedUser?.id === follower.id && (
                                      <div className="w-5 h-5 bg-yellow-500 rounded-full flex items-center justify-center">
                                        <svg className="w-3 h-3 text-black" fill="currentColor" viewBox="0 0 20 20">
                                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                        </svg>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        </>
                      ) : (
                        <>
                          {/* Selected User Info */}
                          {selectedUser && (
                            <div className="mb-6">
                              <div className="flex items-center space-x-3 p-3 rounded-lg bg-white/10">
                                <img
                                  src={selectedUser.avatar}
                                  alt={selectedUser.name}
                                  className="w-10 h-10 rounded-full object-cover"
                                />
                                <div>
                                  <h3 className={`font-semibold text-sm transition-colors duration-300 ${
                                    isDark ? 'text-white' : 'text-black'
                                  }`}>
                                    {selectedUser.name}
                                  </h3>
                                  <p className={`text-xs transition-colors duration-300 ${
                                    isDark ? 'text-gray-400' : 'text-gray-600'
                                  }`}>
                                    {selectedUser.handle}
                                  </p>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Message Input */}
                          <div className="space-y-4">
                            <div>
                              <label className={`text-sm font-medium mb-2 block transition-colors duration-300 ${
                                isDark ? 'text-gray-300' : 'text-gray-700'
                              }`}>
                                Message:
                              </label>
                              <textarea
                                value={messageText}
                                onChange={(e) => setMessageText(e.target.value)}
                                placeholder="Type your message..."
                                className={`w-full resize-none rounded-lg border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 py-3 px-4 ${
                                  isDark 
                                    ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent' 
                                    : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
                                }`}
                                rows={4}
                              />
                            </div>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Modal Footer */}
                    <div className="flex justify-between items-center p-6 border-t border-white/10">
                      {newChatStep === 'compose' && (
                        <button
                          onClick={goBackToSelect}
                          className="px-6 py-2 rounded-full font-medium transition-all duration-300 border border-white/20 text-white hover:bg-gray-500/20 cursor-pointer"
                        >
                          Back
                        </button>
                      )}
                      
                      <div className="flex space-x-3 ml-auto">
                        <button
                          onClick={closeNewChatFlowModal}
                          className="px-6 py-2 rounded-full font-medium transition-all duration-300 border border-white/20 text-white hover:bg-gray-500/20 cursor-pointer"
                        >
                          Cancel
                        </button>
                        
                        {newChatStep === 'select' ? (
                          <button
                            onClick={goToCompose}
                            disabled={!selectedUser}
                            className={`px-6 py-2 rounded-full font-medium transition-all duration-300 cursor-pointer ${
                              selectedUser
                                ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
                                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                            }`}
                          >
                            Next
                          </button>
                        ) : (
                          <button
                            onClick={handleSendMessage}
                            disabled={!messageText.trim()}
                            className={`px-6 py-2 rounded-full font-medium transition-all duration-300 cursor-pointer ${
                              messageText.trim()
                                ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
                                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                            }`}
                          >
                            Send
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Create Group Modal */}
              {showCreateGroupModal && (
                <div 
                  className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
                  onClick={closeCreateGroupModal}
                >
                  <div 
                    className={`w-full max-w-md mx-4 rounded-2xl transition-all duration-300 ${
                      isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Modal Header */}
                    <div className="flex items-center justify-between p-6 border-b border-white/10">
                      <h2 className={`text-xl font-bold transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        Create Group
                      </h2>
                      <button
                        onClick={closeCreateGroupModal}
                        className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 cursor-pointer ${
                          isDark ? 'text-white' : 'text-black'
                        }`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* Modal Content */}
                    <div className="p-6">
                      <div className="space-y-6">
                        {/* Group Name */}
                        <div>
                          <label className={`text-sm font-medium mb-2 block transition-colors duration-300 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            Group Name *
                          </label>
                          <input
                            type="text"
                            placeholder="Enter group name..."
                            value={groupName}
                            onChange={(e) => setGroupName(e.target.value)}
                            className={`w-full px-4 py-3 rounded-lg border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                              isDark 
                                ? 'bg-white/10 border-white/20 text-white placeholder-gray-400 focus:bg-white/15' 
                                : 'bg-white/50 border-white/30 text-black placeholder-gray-500 focus:bg-white/60'
                            }`}
                          />
                        </div>

                        {/* Privacy Setting */}
                        <div className="space-y-4">
                          <h3 className={`text-sm font-medium transition-colors duration-300 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            Privacy Settings
                          </h3>
                          
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <p className={`text-sm font-medium transition-colors duration-300 ${
                                isDark ? 'text-white' : 'text-black'
                              }`}>
                                Private Group
                              </p>
                              <p className={`text-xs transition-colors duration-300 ${
                                isDark ? 'text-gray-400' : 'text-gray-600'
                              }`}>
                                Only people with the link can join
                              </p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={isPrivateGroup}
                                onChange={(e) => setIsPrivateGroup(e.target.checked)}
                              />
                              <div className={`w-11 h-6 rounded-full peer transition-all duration-300 ${
                                isPrivateGroup
                                  ? 'bg-yellow-500' 
                                  : isDark 
                                    ? 'bg-gray-600' 
                                    : 'bg-gray-300'
                              }`}>
                                <div className={`absolute top-0.5 bg-white w-5 h-5 rounded-full transition-transform duration-300 ${
                                  isPrivateGroup ? 'left-6' : 'left-0.5'
                                }`}></div>
                              </div>
                            </label>
                          </div>
                        </div>

                        {/* Group Link - Only show if private */}
                        {isPrivateGroup && (
                          <div>
                            <label className={`text-sm font-medium mb-2 block transition-colors duration-300 ${
                              isDark ? 'text-gray-300' : 'text-gray-700'
                            }`}>
                              Group Link
                            </label>
                            <div className="flex items-center space-x-2">
                              <input
                                type="text"
                                placeholder="Enter custom link (optional)..."
                                value={groupLink}
                                onChange={(e) => setGroupLink(e.target.value)}
                                className={`flex-1 px-4 py-3 rounded-lg border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                                  isDark 
                                    ? 'bg-white/10 border-white/20 text-white placeholder-gray-400 focus:bg-white/15' 
                                    : 'bg-white/50 border-white/30 text-black placeholder-gray-500 focus:bg-white/60'
                                }`}
                              />
                              <button
                                onClick={() => {
                                  const randomLink = Math.random().toString(36).substring(2, 8)
                                  setGroupLink(randomLink)
                                }}
                                className={`px-3 py-3 rounded-lg border transition-all duration-300 cursor-pointer ${
                                  isDark 
                                    ? 'bg-white/10 border-white/20 text-white hover:bg-white/15' 
                                    : 'bg-white/50 border-white/30 text-black hover:bg-white/60'
                                }`}
                              >
                                Generate
                              </button>
                            </div>
                            <p className={`text-xs mt-1 transition-colors duration-300 ${
                              isDark ? 'text-gray-400' : 'text-gray-600'
                            }`}>
                              Leave empty to auto-generate a random link
                            </p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Modal Footer */}
                    <div className="flex justify-end space-x-3 p-6 border-t border-white/10">
                      <button
                        onClick={closeCreateGroupModal}
                        className="px-6 py-2 rounded-full font-medium transition-all duration-300 border border-white/20 text-white hover:bg-gray-500/20 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleCreateGroup}
                        disabled={!groupName.trim()}
                        className={`px-6 py-2 rounded-full font-medium transition-all duration-300 cursor-pointer ${
                          groupName.trim()
                            ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
                            : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        Create Group
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Join Group Modal */}
              {showJoinGroupModal && (
                <div 
                  className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
                  onClick={closeJoinGroupModal}
                >
                  <div 
                    className={`w-full max-w-md mx-4 rounded-2xl transition-all duration-300 ${
                      isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Modal Header */}
                    <div className="flex items-center justify-between p-6 border-b border-white/10">
                      <h2 className={`text-xl font-bold transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        Join Group
                      </h2>
                      <button
                        onClick={closeJoinGroupModal}
                        className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 cursor-pointer ${
                          isDark ? 'text-white' : 'text-black'
                        }`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* Modal Content */}
                    <div className="p-6">
                      <div className="space-y-6">
                        {/* Search Bar for Groups */}
                        <div>
                          <label className={`text-sm font-medium mb-2 block transition-colors duration-300 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            Search Groups
                          </label>
                          <div className="relative">
                            <HiOutlineSearch className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-all duration-300 ${
                              isDark ? 'text-white/70' : 'text-gray-600'
                            }`} />
                            <input
                              type="text"
                              placeholder="Search available groups..."
                              value={joinGroupSearch}
                              onChange={(e) => setJoinGroupSearch(e.target.value)}
                              className={`w-full pl-10 pr-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                                isDark 
                                  ? 'bg-white/10 border-white/20 text-white placeholder-gray-400 focus:bg-white/15' 
                                  : 'bg-white/50 border-white/30 text-black placeholder-gray-500 focus:bg-white/60'
                              }`}
                            />
                          </div>
                        </div>

                        {/* Available Groups List */}
                        <div>
                          <h3 className={`text-sm font-medium mb-3 transition-colors duration-300 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            Available Groups
                          </h3>
                          <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                            {mockAvailableGroups
                              .filter(group => 
                                group.name.toLowerCase().includes(joinGroupSearch.toLowerCase()) ||
                                group.description.toLowerCase().includes(joinGroupSearch.toLowerCase())
                              )
                              .map((group) => (
                                <div
                                  key={group.id}
                                  onClick={() => handleJoinGroup(group.id)}
                                  className={`p-3 rounded-lg transition-all duration-300 cursor-pointer hover:bg-white/5 ${
                                    isDark 
                                      ? 'bg-white/5 border border-white/10 hover:bg-white/10' 
                                      : 'bg-white/20 border border-white/30 hover:bg-white/30'
                                  }`}
                                >
                                  <div className="flex items-center space-x-3">
                                    <img
                                      src={group.avatar}
                                      alt={group.name}
                                      className="w-10 h-10 rounded-full object-cover"
                                    />
                                    <div className="flex-1 min-w-0">
                                      <h4 className={`font-semibold text-sm transition-colors duration-300 ${
                                        isDark ? 'text-white' : 'text-black'
                                      }`}>
                                        {group.name}
                                      </h4>
                                      <p className={`text-xs transition-colors duration-300 ${
                                        isDark ? 'text-gray-400' : 'text-gray-600'
                                      }`}>
                                        {group.description}
                                      </p>
                                      <p className={`text-xs transition-colors duration-300 ${
                                        isDark ? 'text-gray-500' : 'text-gray-500'
                                      }`}>
                                        {group.members} members
                                      </p>
                                    </div>
                                    <button className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-300 cursor-pointer ${
                                      isDark 
                                        ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30' 
                                        : 'bg-yellow-100 text-yellow-600 hover:bg-yellow-200'
                                    }`}>
                                      Join
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>

                        {/* Private Group Link Input */}
                        <div>
                          <label className={`text-sm font-medium mb-2 block transition-colors duration-300 ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          }`}>
                            Or Join Private Group
                          </label>
                          <div className="flex items-center space-x-2">
                            <input
                              type="text"
                              placeholder="Enter group link..."
                              value={joinGroupLink}
                              onChange={(e) => setJoinGroupLink(e.target.value)}
                              className={`flex-1 px-4 py-3 rounded-lg border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                                isDark 
                                  ? 'bg-white/10 border-white/20 text-white placeholder-gray-400 focus:bg-white/15' 
                                  : 'bg-white/50 border-white/30 text-black placeholder-gray-500 focus:bg-white/60'
                              }`}
                            />
                            <button
                              onClick={() => handleJoinGroup(undefined, joinGroupLink)}
                              disabled={!joinGroupLink.trim()}
                              className={`px-4 py-3 rounded-lg font-medium transition-all duration-300 cursor-pointer ${
                                joinGroupLink.trim()
                                  ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
                                  : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                              }`}
                            >
                              Join
                            </button>
                          </div>
                          <p className={`text-xs mt-1 transition-colors duration-300 ${
                            isDark ? 'text-gray-400' : 'text-gray-600'
                          }`}>
                            Enter the link provided by the group admin
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Modal Footer */}
                    <div className="flex justify-end space-x-3 p-6 border-t border-white/10">
                      <button
                        onClick={closeJoinGroupModal}
                        className="px-6 py-2 rounded-full font-medium transition-all duration-300 border border-white/20 text-white hover:bg-gray-500/20 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Mobile Bottom Navbar */}
              <MobileBottomNavbar 
                activeTab={activeBottomTab}
                onTabChange={(tab) => setActiveBottomTab(tab)}
                isVisible={true}
              />
            </MainLayout>
          )
        }

export default ChatPage
