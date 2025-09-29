import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useState, useEffect, useRef } from 'react'
import MobileBottomNavbar from '~/components/MobileBottomNavbar'
import { 
  HiOutlineCog, 
  HiOutlineMail,
  HiOutlineX,
  HiOutlineSearch,
  HiOutlineDotsHorizontal,
  HiOutlineUserRemove,
  HiOutlineVolumeOff,
  HiOutlineExclamation
} from 'react-icons/hi'

const MessagesPage: React.FC = () => {
  const { isDark } = useTheme()
  const [isNewMessageModalOpen, setIsNewMessageModalOpen] = useState(false)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [messageSettings, setMessageSettings] = useState('Everyone')
  const [activeBottomTab, setActiveBottomTab] = useState('messages')
  const [selectedUser, setSelectedUser] = useState<{name: string, handle: string, avatar: string} | null>(null)
  const [modalStep, setModalStep] = useState<'select' | 'compose'>('select')
  const [messageText, setMessageText] = useState('')
  const [currentView, setCurrentView] = useState<'inbox' | 'chat'>('inbox')
  const [selectedConversation, setSelectedConversation] = useState<{name: string, handle: string, avatar: string, lastMessage: string, date: string} | null>(null)
  const [chatMessages, setChatMessages] = useState<Array<{id: string, text: string, isOwn: boolean, timestamp: string, date: string, time: string}>>([])
  const [showChatOptionsMenu, setShowChatOptionsMenu] = useState(false)
  const chatMenuRef = useRef<HTMLDivElement>(null)

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

  // Function to handle conversation selection
  const handleConversationSelect = (conversation: {name: string, handle: string, avatar: string, lastMessage: string, date: string}) => {
    setSelectedConversation(conversation)
    setCurrentView('chat')
    
    // Mock chat messages for the conversation
    const mockMessages = [
      { id: '1', text: conversation.lastMessage, isOwn: false, timestamp: conversation.date, date: "Sep 3", time: "2:30 PM" },
      { id: '2', text: "Thanks for reaching out!", isOwn: true, timestamp: "Aug 28", date: "Aug 28", time: "1:45 PM" },
      { id: '3', text: "How are you doing?", isOwn: false, timestamp: "Aug 27", date: "Sep 2", time: "11:20 AM" },
      { id: '4', text: "I'm doing great! How about you?", isOwn: true, timestamp: "Aug 26", date: "Aug 26", time: "9:15 AM" }
    ]
    setChatMessages(mockMessages)
  }

  // Function to go back to inbox
  const goBackToInbox = () => {
    setCurrentView('inbox')
    setSelectedConversation(null)
    setChatMessages([])
    setShowChatOptionsMenu(false)
  }

  // Function to handle chat options menu actions
  const handleChatMenuAction = (action: string) => {
    setShowChatOptionsMenu(false)
    switch (action) {
      case 'block-user':
        break
      case 'mute-notifications':
        break
      case 'report':
        break
      default:
        break
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
                {currentView === 'inbox' ? 'Messages' : selectedConversation?.name || 'Chat'}
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
                    {/* Overlay de fondo oscuro */}
                    <div 
                      className="fixed inset-0 bg-black/70 z-40"
                      onClick={() => setShowChatOptionsMenu(false)}
                    />
                    
                    {/* Menú dropdown */}
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

        {/* Messages List - Only show in inbox view */}
        {currentView === 'inbox' && (
          <div className="space-y-1 flex-1 overflow-y-auto -mx-3 sm:mx-0 px-3 sm:px-0">
            <div 
              className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer"
              onClick={() => handleConversationSelect({
                name: 'cryptocapo',
                handle: '@cryptocapo',
                avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face',
                lastMessage: 'Hey bro! Are you still active?',
                date: 'Aug 29'
              })}
            >
              <div className="flex items-center justify-between">
                {/* Left side - Avatar and Content */}
                <div className="flex items-start space-x-3 flex-1">
                  {/* Avatar */}
                  <div className="flex-shrink-0">
                    <img
                      src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face"
                      alt="cryptocapo"
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  </div>
                  
                  {/* Message Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 mb-1">
                      <h3 className={`font-semibold text-base transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        cryptocapo
                      </h3>
                    </div>
                    <p className={`text-sm transition-colors duration-300 ${
                      isDark ? 'text-gray-300' : 'text-gray-700'
                    }`}>
                      Hey bro! Are you still active?
                    </p>
                  </div>
                </div>
                
                {/* Right side - Date */}
                <div className="flex-shrink-0 ml-4">
                  <span className={`text-sm transition-colors duration-300 ${
                    isDark ? 'text-gray-500' : 'text-gray-500'
                  }`}>
                    Aug 29
                  </span>
                </div>
              </div>
            </div>

            <div 
              className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer"
              onClick={() => handleConversationSelect({
                name: 'Iced',
                handle: '@Iced',
                avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=40&h=40&fit=crop&crop=face',
                lastMessage: 'Hey mate! All good? If at some point you ne...',
                date: 'Aug 26'
              })}
            >
              <div className="flex items-center justify-between">
                {/* Left side - Avatar and Content */}
                <div className="flex items-start space-x-3 flex-1">
                  {/* Avatar */}
                  <div className="flex-shrink-0">
                    <img
                      src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=40&h=40&fit=crop&crop=face"
                      alt="Iced"
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  </div>
                  
                  {/* Message Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 mb-1">
                      <h3 className={`font-semibold text-base transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        Iced
                      </h3>
                    </div>
                    <p className={`text-sm transition-colors duration-300 ${
                      isDark ? 'text-gray-300' : 'text-gray-700'
                    }`}>
                      Hey mate! All good? If at some point you ne...
                    </p>
                  </div>
                </div>
                
                {/* Right side - Date */}
                <div className="flex-shrink-0 ml-4">
                  <span className={`text-sm transition-colors duration-300 ${
                    isDark ? 'text-gray-500' : 'text-gray-500'
                  }`}>
                    Aug 26
                  </span>
                </div>
              </div>
            </div>

          <div className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
            <div className="flex items-center justify-between">
              {/* Left side - Avatar and Content */}
              <div className="flex items-start space-x-3 flex-1">
                {/* Avatar */}
                <div className="flex-shrink-0">
                  <img
                    src="https://images.unsplash.com/photo-1494790108755-2616b612b786?w=40&h=40&fit=crop&crop=face"
                    alt="chesi"
                    className="w-10 h-10 rounded-full object-cover"
                  />
                </div>
                
                {/* Message Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 mb-1">
                    <h3 className={`font-semibold text-base transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}>
                      chesi♡
                    </h3>
                  </div>
                  <p className={`text-sm transition-colors duration-300 ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    You reacted with 😂 : hahaha
                  </p>
                </div>
              </div>
              
              {/* Right side - Date */}
              <div className="flex-shrink-0 ml-4">
                <span className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Aug 25
                </span>
              </div>
            </div>
          </div>

          {/* Additional Messages */}
          <div className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
            <div className="flex items-center justify-between">
              {/* Left side - Avatar and Content */}
              <div className="flex items-start space-x-3 flex-1">
                <div className="flex-shrink-0">
                  <img
                    src="https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=40&h=40&fit=crop&crop=face"
                    alt="alex"
                    className="w-10 h-10 rounded-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 mb-1">
                    <h3 className={`font-semibold text-base transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}>
                      alex
                    </h3>
                  </div>
                  <p className={`text-sm transition-colors duration-300 ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    What's up with the new features?
                  </p>
                </div>
              </div>
              
              {/* Right side - Date */}
              <div className="flex-shrink-0 ml-4">
                <span className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Aug 24
                </span>
              </div>
            </div>
          </div>

          <div className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
            <div className="flex items-center justify-between">
              {/* Left side - Avatar and Content */}
              <div className="flex items-start space-x-3 flex-1">
                <div className="flex-shrink-0">
                  <img
                    src="https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=40&h=40&fit=crop&crop=face"
                    alt="mike"
                    className="w-10 h-10 rounded-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 mb-1">
                    <h3 className={`font-semibold text-base transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}>
                      mike
                    </h3>
                  </div>
                  <p className={`text-sm transition-colors duration-300 ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    Thanks for the help yesterday!
                  </p>
                </div>
              </div>
              
              {/* Right side - Date */}
              <div className="flex-shrink-0 ml-4">
                <span className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Aug 23
                </span>
              </div>
            </div>
          </div>

          <div className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
            <div className="flex items-center justify-between">
              {/* Left side - Avatar and Content */}
              <div className="flex items-start space-x-3 flex-1">
              <div className="flex-shrink-0">
                <img
                  src="https://images.unsplash.com/photo-1494790108755-2616b612b786?w=40&h=40&fit=crop&crop=face"
                  alt="sarah"
                  className="w-10 h-10 rounded-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2 mb-1">
                  <h3 className={`font-semibold text-base transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    sarah
                  </h3>
                </div>
                <p className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Can we schedule a call for tomorrow?
                </p>
                </div>
              </div>
              
              {/* Right side - Date */}
              <div className="flex-shrink-0 ml-4">
                <span className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Aug 22
                </span>
              </div>
            </div>
          </div>

          <div className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
            <div className="flex items-center justify-between">
              {/* Left side - Avatar and Content */}
              <div className="flex items-start space-x-3 flex-1">
              <div className="flex-shrink-0">
                <img
                  src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face"
                  alt="david"
                  className="w-10 h-10 rounded-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2 mb-1">
                  <h3 className={`font-semibold text-base transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    david
                  </h3>
                </div>
                <p className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  The project is looking great so far
                </p>
                </div>
              </div>
              
              {/* Right side - Date */}
              <div className="flex-shrink-0 ml-4">
                <span className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Aug 21
                </span>
              </div>
            </div>
          </div>

          <div className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
            <div className="flex items-center justify-between">
              {/* Left side - Avatar and Content */}
              <div className="flex items-start space-x-3 flex-1">
              <div className="flex-shrink-0">
                <img
                  src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=40&h=40&fit=crop&crop=face"
                  alt="emma"
                  className="w-10 h-10 rounded-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2 mb-1">
                  <h3 className={`font-semibold text-base transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    emma
                  </h3>
                </div>
                <p className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Just sent you the files
                </p>
                </div>
              </div>
              
              {/* Right side - Date */}
              <div className="flex-shrink-0 ml-4">
                <span className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Aug 20
                </span>
              </div>
            </div>
          </div>

          <div className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
            <div className="flex items-center justify-between">
              {/* Left side - Avatar and Content */}
              <div className="flex items-start space-x-3 flex-1">
              <div className="flex-shrink-0">
                <img
                  src="https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=40&h=40&fit=crop&crop=face"
                  alt="james"
                  className="w-10 h-10 rounded-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2 mb-1">
                  <h3 className={`font-semibold text-base transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    james
                  </h3>
                </div>
                <p className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Let me know when you're ready
                </p>
                </div>
              </div>
              
              {/* Right side - Date */}
              <div className="flex-shrink-0 ml-4">
                <span className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Aug 19
                </span>
              </div>
            </div>
          </div>

          <div className="p-2 rounded-lg transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
            <div className="flex items-center justify-between">
              {/* Left side - Avatar and Content */}
              <div className="flex items-start space-x-3 flex-1">
              <div className="flex-shrink-0">
                <img
                  src="https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=40&h=40&fit=crop&crop=face"
                  alt="lisa"
                  className="w-10 h-10 rounded-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2 mb-1">
                  <h3 className={`font-semibold text-base transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    lisa
                  </h3>
                </div>
                <p className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Perfect! See you later
                </p>
                </div>
              </div>
              
              {/* Right side - Date */}
              <div className="flex-shrink-0 ml-4">
                <span className={`text-sm transition-colors duration-300 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Aug 18
                </span>
              </div>
            </div>
          </div>
          </div>
        )}

        {/* Chat View */}
        {currentView === 'chat' && selectedConversation && (
          <div className="flex flex-col flex-1 md:flex-1 h-screen md:h-auto">
            {/* Mobile Chat Header - Fixed below main header */}
            <div className="md:hidden fixed top-16 left-0 right-0 z-20 bg-black p-4 border-b border-white/10">
              <div className="flex items-center justify-between max-w-2xl mx-auto">
                <div className="flex items-center space-x-4">
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
                  <h1 className={`text-xl font-bold transition-colors duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {selectedConversation?.name || 'Chat'}
                  </h1>
                </div>
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
                      {/* Overlay de fondo oscuro */}
                      <div 
                        className="fixed inset-0 bg-black/70 z-40"
                        onClick={() => setShowChatOptionsMenu(false)}
                      />
                      
                      {/* Menú dropdown */}
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
              </div>
            </div>

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto custom-scrollbar-alt space-y-4 p-4 md:p-4 pt-32 md:pt-4 pb-32 md:pb-4">
              {chatMessages.map((message) => (
                <div
                  key={message.id}
                  className={`flex flex-col ${message.isOwn ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-md lg:max-w-xl px-6 py-4 rounded-2xl ${
                      message.isOwn
                        ? 'bg-gray-600 text-white'
                        : isDark
                        ? 'bg-gray-700 text-white'
                        : 'bg-gray-200 text-black'
                    }`}
                  >
                    <p className="text-sm">{message.text}</p>
                  </div>
                  <div className={`mt-1 px-2 ${
                    message.isOwn ? 'text-right' : 'text-left'
                  }`}>
                    <p className="text-xs text-white/50 font-medium">
                      {message.date} • {message.time}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Message Input - Fixed above navbar */}
            <div className="flex-shrink-0 border-t border-white/10 px-1 py-3 md:p-4 fixed md:relative bottom-16 left-0 right-0 z-50 bg-black md:bg-transparent">
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

      {/* New Message Modal */}
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
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/10">
              <h2 className={`text-xl font-bold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {modalStep === 'select' ? 'New message' : 'Send message'}
              </h2>
              <button
                onClick={closeModal}
                className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 ${
                  isDark ? 'text-white' : 'text-black'
                }`}
              >
                <HiOutlineX className="w-5 h-5" />
              </button>
            </div>

            {/* Step 1: User Selection */}
            {modalStep === 'select' && (
              <>
                {/* Search Bar */}
                <div className="p-6 border-b border-white/10">
                  <div className="relative">
                    <HiOutlineSearch className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-all duration-300 ${
                      isDark ? 'text-white/70' : 'text-gray-600'
                    }`} />
                    <input
                      type="text"
                      placeholder="Search people"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className={`w-full pl-10 pr-4 py-3 rounded-full border transition-all duration-300 focus:outline-none ${
                        isDark 
                          ? 'bg-black border-white/20 text-white placeholder-white/50 focus:border-white/30 focus:bg-black' 
                          : 'bg-gray-100 border-gray-300 text-black placeholder-gray-500 focus:border-gray-400 focus:bg-gray-200'
                      }`}
                    />
                  </div>
                </div>

                {/* Followers List */}
                <div className="max-h-96 overflow-y-auto custom-scrollbar-alt">
                  <div className="p-6">
                    <h3 className={`text-sm font-semibold mb-4 transition-colors duration-300 ${
                      isDark ? 'text-gray-300' : 'text-gray-600'
                    }`}>
                      Suggested
                    </h3>
                    
                    {/* Mock Followers */}
                    <div className="space-y-3">
                      <div 
                        className={`flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition-all duration-300 ${
                          selectedUser?.name === 'alex' 
                            ? 'bg-gray-500/20 border border-gray-500/30' 
                            : 'hover:bg-gray-500/5'
                        }`}
                        onClick={() => handleUserSelect({name: 'alex', handle: '@alex', avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face'})}
                      >
                        <img
                          src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=40&h=40&fit=crop&crop=face"
                          alt="alex"
                          className="w-10 h-10 rounded-full object-cover"
                        />
                        <div className="flex-1">
                          <h4 className={`font-semibold transition-colors duration-300 ${
                            isDark ? 'text-white' : 'text-black'
                          }`}>
                            alex
                          </h4>
                          <p className={`text-sm transition-colors duration-300 ${
                            isDark ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            @alex
                          </p>
                        </div>
                      </div>

                      <div 
                        className={`flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition-all duration-300 ${
                          selectedUser?.name === 'mike' 
                            ? 'bg-gray-500/20 border border-gray-500/30' 
                            : 'hover:bg-gray-500/5'
                        }`}
                        onClick={() => handleUserSelect({name: 'mike', handle: '@mike', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=40&h=40&fit=crop&crop=face'})}
                      >
                        <img
                          src="https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=40&h=40&fit=crop&crop=face"
                          alt="mike"
                          className="w-10 h-10 rounded-full object-cover"
                        />
                        <div className="flex-1">
                          <h4 className={`font-semibold transition-colors duration-300 ${
                            isDark ? 'text-white' : 'text-black'
                          }`}>
                            mike
                          </h4>
                          <p className={`text-sm transition-colors duration-300 ${
                            isDark ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            @mike
                          </p>
                        </div>
                      </div>

                      <div 
                        className={`flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition-all duration-300 ${
                          selectedUser?.name === 'sarah' 
                            ? 'bg-gray-500/20 border border-gray-500/30' 
                            : 'hover:bg-gray-500/5'
                        }`}
                        onClick={() => handleUserSelect({name: 'sarah', handle: '@sarah', avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=40&h=40&fit=crop&crop=face'})}
                      >
                        <img
                          src="https://images.unsplash.com/photo-1494790108755-2616b612b786?w=40&h=40&fit=crop&crop=face"
                          alt="sarah"
                          className="w-10 h-10 rounded-full object-cover"
                        />
                        <div className="flex-1">
                          <h4 className={`font-semibold transition-colors duration-300 ${
                            isDark ? 'text-white' : 'text-black'
                          }`}>
                            sarah
                          </h4>
                          <p className={`text-sm transition-colors duration-300 ${
                            isDark ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            @sarah
                          </p>
                        </div>
                      </div>

                      <div 
                        className={`flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition-all duration-300 ${
                          selectedUser?.name === 'david' 
                            ? 'bg-gray-500/20 border border-gray-500/30' 
                            : 'hover:bg-gray-500/5'
                        }`}
                        onClick={() => handleUserSelect({name: 'david', handle: '@david', avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=40&h=40&fit=crop&crop=face'})}
                      >
                        <img
                          src="https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=40&h=40&fit=crop&crop=face"
                          alt="david"
                          className="w-10 h-10 rounded-full object-cover"
                        />
                        <div className="flex-1">
                          <h4 className={`font-semibold transition-colors duration-300 ${
                            isDark ? 'text-white' : 'text-black'
                          }`}>
                            david
                          </h4>
                          <p className={`text-sm transition-colors duration-300 ${
                            isDark ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            @david
                          </p>
                        </div>
                      </div>

                      <div 
                        className={`flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition-all duration-300 ${
                          selectedUser?.name === 'emma' 
                            ? 'bg-gray-500/20 border border-gray-500/30' 
                            : 'hover:bg-gray-500/5'
                        }`}
                        onClick={() => handleUserSelect({name: 'emma', handle: '@emma', avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=40&h=40&fit=crop&crop=face'})}
                      >
                        <img
                          src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=40&h=40&fit=crop&crop=face"
                          alt="emma"
                          className="w-10 h-10 rounded-full object-cover"
                        />
                        <div className="flex-1">
                          <h4 className={`font-semibold transition-colors duration-300 ${
                            isDark ? 'text-white' : 'text-black'
                          }`}>
                            emma
                          </h4>
                          <p className={`text-sm transition-colors duration-300 ${
                            isDark ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            @emma
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Next Button - Only show when a user is selected */}
                {selectedUser && (
                  <div className="p-6 border-t border-white/10">
                    <button
                      onClick={() => setModalStep('compose')}
                      className="w-full py-2 px-6 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Step 2: Send Message */}
            {modalStep === 'compose' && selectedUser && (
              <>
                {/* Selected User Display */}
                <div className="p-6 border-b border-white/10">
                  <div className="flex items-center space-x-3">
                    <img
                      src={selectedUser.avatar}
                      alt={selectedUser.name}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                    <div>
                      <h3 className={`font-semibold text-lg transition-colors duration-300 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        {selectedUser.name}
                      </h3>
                      <p className={`text-sm transition-colors duration-300 ${
                        isDark ? 'text-gray-400' : 'text-gray-500'
                      }`}>
                        {selectedUser.handle}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Message Input */}
                <div className="p-6">
                  <label className={`block text-sm font-medium mb-3 transition-colors duration-300 ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    Message:
                  </label>
                  <textarea
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    placeholder="What's happening?"
                    rows={4}
                    className={`w-full px-4 py-3 rounded-lg border transition-all duration-300 focus:outline-none resize-none ${
                      isDark 
                        ? 'bg-black border-white/20 text-white placeholder-white/50 focus:border-white/30 focus:bg-black' 
                        : 'bg-gray-100 border-gray-300 text-black placeholder-gray-500 focus:border-gray-400 focus:bg-gray-200'
                    }`}
                  />
                </div>

                {/* Send Button */}
                <div className="px-6 py-4 border-t border-white/10">
                  <button
                    onClick={() => {
                      // Handle send message logic here
                      closeModal()
                    }}
                    className="w-full py-2 px-6 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300"
                  >
                    Send
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Message Settings Modal */}
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
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/10">
              <h2 className={`text-xl font-bold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                Message Settings
              </h2>
              <button
                onClick={() => setIsSettingsModalOpen(false)}
                className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 ${
                  isDark ? 'text-white' : 'text-black'
                }`}
              >
                <HiOutlineX className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6">
              <div className="space-y-4">
                <div>
                  <h3 className={`text-sm font-medium mb-3 transition-colors duration-300 ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    Allow messages from:
                  </h3>
                  
                  <div className="space-y-3">
                    {/* Everyone */}
                    <label className={`flex items-center space-x-3 cursor-pointer transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}>
                      <input
                        type="radio"
                        name="messageSettings"
                        value="Everyone"
                        checked={messageSettings === 'Everyone'}
                        onChange={(e) => setMessageSettings(e.target.value)}
                        className={`w-5 h-5 transition-colors duration-300 ${
                          isDark ? 'text-black' : 'text-black'
                        }`}
                      />
                      <span className="text-sm">Everyone</span>
                    </label>

                    {/* People you follow */}
                    <label className={`flex items-center space-x-3 cursor-pointer transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}>
                      <input
                        type="radio"
                        name="messageSettings"
                        value="People you follow"
                        checked={messageSettings === 'People you follow'}
                        onChange={(e) => setMessageSettings(e.target.value)}
                        className={`w-5 h-5 transition-colors duration-300 ${
                          isDark ? 'text-black' : 'text-black'
                        }`}
                      />
                      <span className="text-sm">People you follow</span>
                    </label>

                    {/* No one */}
                    <label className={`flex items-center space-x-3 cursor-pointer transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}>
                      <input
                        type="radio"
                        name="messageSettings"
                        value="No one"
                        checked={messageSettings === 'No one'}
                        onChange={(e) => setMessageSettings(e.target.value)}
                        className={`w-5 h-5 transition-colors duration-300 ${
                          isDark ? 'text-black' : 'text-black'
                        }`}
                      />
                      <span className="text-sm">No one</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end space-x-3 p-6 border-t border-white/10">
              <button
                onClick={() => setIsSettingsModalOpen(false)}
                className="px-6 py-2 rounded-full font-medium transition-all duration-300 border border-white/20 text-white hover:bg-gray-500/20 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  // Handle save logic here
                  setIsSettingsModalOpen(false)
                }}
                className="px-6 py-2 rounded-full font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300 cursor-pointer"
              >
                Save
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

export default MessagesPage