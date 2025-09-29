import React, { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineMicrophone, HiOutlineX } from 'react-icons/hi'
import Share from '~/assets/images/share.svg?react'

interface Participant {
  id: number
  name: string
  isSpeaking: boolean
  isMuted: boolean
  isHost: boolean
}

interface VoiceRoomActiveProps {
  onClose: () => void
  onMinimizeChange?: (isMinimized: boolean) => void
  topic: string
  isRecording: boolean
}

const VoiceRoomActive: React.FC<VoiceRoomActiveProps> = ({ 
  onClose, 
  onMinimizeChange, 
  topic, 
  isRecording 
}) => {
  const [isMuted, setIsMuted] = useState(false)
  const [currentSlide, setCurrentSlide] = useState(0)
  const [touchStart, setTouchStart] = useState<number | null>(null)
  const [touchEnd, setTouchEnd] = useState<number | null>(null)
  const [isMinimized, setIsMinimized] = useState(false)
  const [showEmojiPanel, setShowEmojiPanel] = useState(false)

  // Available emojis for reactions
  const emojis = ['👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🎉', '🚀', '🔥', '💯', '🙏', '👏', '🤔', '😊', '😎']
  const [participants] = useState([
    { id: 1, name: 'You', isSpeaking: true, isMuted: false, isHost: true },
    { id: 2, name: 'crypto_enthusiast', isSpeaking: false, isMuted: true, isHost: false },
    { id: 3, name: 'web3_builder', isSpeaking: true, isMuted: false, isHost: false },
    { id: 4, name: 'defi_trader', isSpeaking: false, isMuted: false, isHost: false },
    { id: 5, name: 'nft_creator', isSpeaking: true, isMuted: false, isHost: false },
    { id: 6, name: 'blockchain_dev', isSpeaking: false, isMuted: true, isHost: false },
    { id: 7, name: 'crypto_analyst', isSpeaking: false, isMuted: false, isHost: false },
    { id: 8, name: 'dao_member', isSpeaking: true, isMuted: false, isHost: false },
    { id: 9, name: 'metaverse_explorer', isSpeaking: false, isMuted: false, isHost: false },
    { id: 10, name: 'yield_farmer', isSpeaking: false, isMuted: true, isHost: false },
    { id: 11, name: 'crypto_influencer', isSpeaking: true, isMuted: false, isHost: false },
    { id: 12, name: 'web3_enthusiast', isSpeaking: false, isMuted: false, isHost: false },
    { id: 13, name: 'defi_protocol', isSpeaking: true, isMuted: false, isHost: false },
    { id: 14, name: 'nft_collector', isSpeaking: false, isMuted: false, isHost: false },
    { id: 15, name: 'dao_governor', isSpeaking: true, isMuted: false, isHost: false },
    { id: 16, name: 'liquidity_provider', isSpeaking: false, isMuted: true, isHost: false },
    { id: 17, name: 'smart_contract_dev', isSpeaking: true, isMuted: false, isHost: false },
    { id: 18, name: 'token_holder', isSpeaking: false, isMuted: false, isHost: false },
    { id: 19, name: 'staking_validator', isSpeaking: true, isMuted: false, isHost: false },
    { id: 20, name: 'cross_chain_bridge', isSpeaking: false, isMuted: true, isHost: false },
    { id: 21, name: 'layer2_scaler', isSpeaking: true, isMuted: false, isHost: false },
    { id: 22, name: 'consensus_mechanism', isSpeaking: false, isMuted: false, isHost: false },
    { id: 23, name: 'hash_function', isSpeaking: true, isMuted: false, isHost: false },
    { id: 24, name: 'merkle_tree', isSpeaking: false, isMuted: true, isHost: false },
    { id: 25, name: 'consensus_node', isSpeaking: true, isMuted: false, isHost: false },
    { id: 26, name: 'validator_pool', isSpeaking: false, isMuted: false, isHost: false },
    { id: 27, name: 'block_producer', isSpeaking: true, isMuted: false, isHost: false },
    { id: 28, name: 'transaction_fee', isSpeaking: false, isMuted: true, isHost: false },
    { id: 29, name: 'gas_limit', isSpeaking: true, isMuted: false, isHost: false },
    { id: 30, name: 'block_size', isSpeaking: false, isMuted: false, isHost: false },
    { id: 31, name: 'network_hash', isSpeaking: true, isMuted: false, isHost: false },
    { id: 32, name: 'mining_pool', isSpeaking: false, isMuted: true, isHost: false },
    { id: 33, name: 'proof_of_work', isSpeaking: true, isMuted: false, isHost: false },
    { id: 34, name: 'proof_of_stake', isSpeaking: false, isMuted: false, isHost: false },
    { id: 35, name: 'delegated_proof', isSpeaking: true, isMuted: false, isHost: false },
    { id: 36, name: 'consensus_algorithm', isSpeaking: false, isMuted: true, isHost: false },
  ])
  
  const { isDark } = useTheme()
  
  // Use props for topic and recording

  const toggleMute = () => {
    setIsMuted(!isMuted)
  }

  const leaveRoom = () => {
    onClose()
  }

  const minimizeRoom = () => {
    setIsMinimized(true)
    onMinimizeChange?.(true)
  }

  const expandRoom = () => {
    setIsMinimized(false)
    onMinimizeChange?.(false)
  }

  const endVoiceRoom = () => {
    onClose()
  }

  // Calculate participants per slide and total slides
  const participantsPerSlide = 12
  const totalSlides = Math.ceil(participants.length / participantsPerSlide)
  const currentParticipants = participants.slice(
    currentSlide * participantsPerSlide,
    (currentSlide + 1) * participantsPerSlide
  )

  const nextSlide = () => {
    setCurrentSlide((prev) => (prev + 1) % totalSlides)
  }

  const prevSlide = () => {
    setCurrentSlide((prev) => (prev - 1 + totalSlides) % totalSlides)
  }

  // Touch handlers for swipe navigation
  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchEnd(null)
    setTouchStart(e.targetTouches[0].clientX)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    setTouchEnd(e.targetTouches[0].clientX)
  }

  const handleTouchEnd = () => {
    if (!touchStart || !touchEnd) return
    
    const distance = touchStart - touchEnd
    const isLeftSwipe = distance > 50
    const isRightSwipe = distance < -50


    if (isLeftSwipe && totalSlides > 1) {
      nextSlide()
    } else if (isRightSwipe && totalSlides > 1) {
      prevSlide()
    }
    
    // Reset touch states
    setTouchStart(null)
    setTouchEnd(null)
  }

  return (
    <>
      {/* Clickable area outside panel for minimizing */}
      {!isMinimized && (
        <div 
          className="md:hidden fixed inset-0 z-[65]"
          onClick={minimizeRoom}
        />
      )}

      {/* Voice Room Panel - Mobile only */}
      {!isMinimized && (
        <div 
          className="md:hidden fixed top-24 left-0 right-0 bottom-0 z-[70] bg-black rounded-t-3xl border-t border-white/10 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
        {/* Header */}
        <div className="flex items-center justify-center p-4 border-b border-white/10">
          <button
            onClick={leaveRoom}
            className="absolute left-4 p-1 rounded-lg text-white hover:bg-white/10"
          >
            <HiOutlineX className="w-4 h-4" />
          </button>
          
          <div className="text-center">
            <h1 className="text-lg font-semibold">
              {topic || 'Voice Room'}
            </h1>
            <p className="text-sm text-gray-400">
              {participants.length} participant{participants.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        {/* Main Content */}
        <div className="px-4 py-8 pb-20 max-h-[calc(100vh-200px)] overflow-y-auto">
          <div className="max-w-md mx-auto">
          {/* Recording Indicator and Controls */}
          <div className="mb-8 flex items-center justify-between">
            {/* Recording Indicator - Left */}
            <div className="flex items-center px-3 py-2 rounded-full bg-red-500/20 border border-red-500/30">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse mr-2"></div>
              <span className="text-sm font-medium text-red-400">Rec</span>
            </div>
            
            {/* Control Buttons - Right */}
            <div className="flex items-center space-x-2">
              {/* Share Link Button */}
              <button
                onClick={() => {}}
                className="p-2 hover:bg-gray-800/50 transition-colors duration-200 rounded-lg"
              >
                <Share className="w-6 h-6 text-white stroke-white stroke-[1.5]" />
              </button>
              
              {/* End Voice Button */}
              <button
                onClick={endVoiceRoom}
                className="px-3 py-2 rounded-full bg-red-600 hover:bg-red-500 transition-colors duration-200 text-sm font-medium text-white"
              >
                End
              </button>
            </div>
          </div>

          {/* Participants List */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-400">Participants</h3>
            </div>
            
            <div 
              className="grid grid-cols-4 gap-3 justify-items-center"
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {currentParticipants.map((participant) => (
                <div
                  key={participant.id}
                  className="flex flex-col items-center text-center"
                >
                  {/* Avatar */}
                  <div className="relative">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-200 ${
                      participant.isSpeaking
                        ? 'bg-yellow-500 text-black ring-2 ring-yellow-500/30'
                        : 'bg-gray-700 text-white'
                    }`}>
                      {participant.name.charAt(0).toUpperCase()}
                    </div>
                    
                    {/* Speaking indicator */}
                    {participant.isSpeaking && (
                      <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-yellow-500 rounded-full flex items-center justify-center">
                        <div className="w-1 h-1 bg-black rounded-full animate-pulse"></div>
                      </div>
                    )}
                    
                    {/* Muted indicator */}
                    {participant.isMuted && (
                      <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full flex items-center justify-center">
                        <HiOutlineMicrophone className="w-2 h-2 text-white" style={{ opacity: 0.8 }} />
                      </div>
                    )}
                  </div>
                  
                  {/* Name and role */}
                  <div className="mt-1">
                    <p className="text-xs font-medium text-white truncate max-w-16">
                      {participant.name}
                    </p>
                    {participant.isHost && (
                      <p className="text-xs text-yellow-400 font-medium">Host</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            
            {/* Slide Indicators - Only dots */}
            {totalSlides > 1 && (
              <div className="flex justify-center mt-4 space-x-2">
                {Array.from({ length: totalSlides }).map((_, index) => (
                  <button
                    key={index}
                    onClick={() => setCurrentSlide(index)}
                    className={`w-2 h-2 rounded-full transition-all duration-200 ${
                      index === currentSlide 
                        ? 'bg-yellow-500' 
                        : 'bg-gray-600 hover:bg-gray-500'
                    }`}
                  />
                ))}
              </div>
            )}
          </div>

            {/* Status Text */}
            <div className="mb-8 text-center">
              <p className="text-sm text-gray-400">
                {isMuted ? 'You are muted' : 'You are speaking'}
              </p>
            </div>
          </div>
        </div>

        </div>
      )}

      {/* Minimized Bar - Mobile only */}
      {isMinimized && (
        <div 
          className="md:hidden fixed bottom-0 left-0 right-0 z-[70] bg-black border-t border-white/10 shadow-2xl rounded-t-2xl"
          onClick={expandRoom}
        >
          <div className="flex items-center justify-between px-4 py-3">
            {/* Left side - Room info */}
            <div className="flex items-center space-x-3">
              {/* Recording indicator */}
              <div className="flex items-center">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse mr-2"></div>
                <span className="text-xs text-red-400">Rec</span>
              </div>
              
              {/* Room title and participants */}
              <div>
                <h3 className="text-sm font-semibold text-white">{topic || 'Voice Room'}</h3>
                <p className="text-xs text-gray-400">{participants.length} participants</p>
              </div>
            </div>

            {/* Right side - Controls */}
            <div className="flex items-center space-x-2">
              {/* Microphone status */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  toggleMute()
                }}
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 ${
                  isMuted
                    ? 'bg-red-500 text-white'
                    : '!bg-yellow-500 !text-black'
                }`}
              >
                <HiOutlineMicrophone className={`w-4 h-4 ${isMuted ? 'opacity-50' : ''}`} />
              </button>

              {/* End button */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  endVoiceRoom()
                }}
                className="px-3 py-1 rounded-full bg-red-600 hover:bg-red-500 transition-colors duration-200 text-xs font-medium text-white"
              >
                End
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Controls - Fixed at bottom (only when not minimized) */}
      {!isMinimized && (
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-[70] bg-black border-t border-white/10">
        <div className="flex items-center justify-between px-8 py-4">
          {/* Microphone Button - Left */}
          <button
            onClick={toggleMute}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 ${
              isMuted
                ? 'bg-red-500 hover:bg-red-400 text-white'
                : '!bg-yellow-500 hover:!bg-yellow-400 !text-black'
            }`}
          >
            <HiOutlineMicrophone 
              className={`w-5 h-5 ${isMuted ? 'opacity-50' : ''}`} 
            />
          </button>

          {/* Emoji Button - Right */}
          <button
            onClick={() => setShowEmojiPanel(!showEmojiPanel)}
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
              showEmojiPanel 
                ? '!text-yellow-500 !bg-yellow-500/20' 
                : '!text-yellow-400 hover:!text-yellow-300 hover:!bg-yellow-400/10'
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>

        {/* Emoji Panel - Mobile only, appears above input bar */}
        {showEmojiPanel && (
          <div className={`md:hidden absolute bottom-full left-0 right-0 p-4 rounded-t-2xl border-b transition-all duration-300 ${
            isDark 
              ? 'bg-white/10 border-white/20' 
              : 'bg-white/90 border-gray-200'
          }`}>
            <div className="grid grid-cols-8 gap-2 max-h-48 overflow-y-auto">
              {emojis.map((emoji, index) => (
                <button
                  key={index}
                  onClick={() => {
                    // Here you would handle emoji selection
                    console.log('Selected emoji:', emoji)
                    setShowEmojiPanel(false)
                  }}
                  className={`p-3 rounded-xl transition-all duration-200 hover:scale-110 ${
                    isDark 
                      ? 'hover:bg-white/10' 
                      : 'hover:bg-gray-100'
                  }`}
                >
                  <span className="text-2xl">{emoji}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      )}

      {/* Desktop - Hidden */}
      <div className="hidden md:flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-4">Voice Room</h2>
          <p className="text-gray-500">This feature is only available on mobile devices.</p>
        </div>
      </div>
    </>
  )
}

export default VoiceRoomActive
