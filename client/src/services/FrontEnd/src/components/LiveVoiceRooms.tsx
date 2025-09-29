import React from 'react'
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineMicrophone } from 'react-icons/hi'

interface LiveVoiceRoom {
  id: string
  hostName: string
  topic: string
  participants: number
  isRecording: boolean
  hostAvatar: string
}

interface LiveVoiceRoomsProps {
  onJoinRoom: (roomId: string) => void
}

const LiveVoiceRooms: React.FC<LiveVoiceRoomsProps> = ({ onJoinRoom }) => {
  const { isDark } = useTheme()

  // Helper function to truncate host name with ellipsis
  const truncateHostName = (name: string, maxLength: number = 8) => {
    if (name.length <= maxLength) return name
    return name.substring(0, maxLength) + '...'
  }

  // Mock data for live voice rooms
  const liveRooms: LiveVoiceRoom[] = [
    {
      id: '1',
      hostName: 'crypto_enthusiast',
      topic: 'DeFi Trends 2024',
      participants: 12,
      isRecording: true,
      hostAvatar: 'C'
    },
    {
      id: '2',
      hostName: 'web3_builder',
      topic: 'NFT Market Analysis',
      participants: 8,
      isRecording: false,
      hostAvatar: 'W'
    },
    {
      id: '3',
      hostName: 'defi_trader',
      topic: 'Yield Farming Strategies',
      participants: 15,
      isRecording: true,
      hostAvatar: 'D'
    },
    {
      id: '4',
      hostName: 'nft_creator',
      topic: 'Art & Technology',
      participants: 6,
      isRecording: false,
      hostAvatar: 'N'
    }
  ]

  return (
    <>
      <div className="md:hidden py-3 border-b border-white/10">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">Voice Rooms</h3>
          <div className="flex items-center space-x-1">
            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
            <span className="text-xs text-gray-400">{liveRooms.length} live</span>
          </div>
        </div>

      {/* Horizontal Scroll Container */}
      <div className="flex space-x-3 overflow-x-auto scrollbar-hide pb-2 -mx-3 px-3">
        {liveRooms.map((room) => (
          <div
            key={room.id}
            onClick={() => onJoinRoom(room.id)}
            className="flex-shrink-0 w-56 bg-gray-800/50 rounded-lg p-3 cursor-pointer hover:bg-gray-700/50 transition-colors duration-200 border border-gray-700/50"
          >
            {/* Content in horizontal layout */}
            <div className="flex items-center space-x-3">
              {/* Host Avatar */}
              <div className="flex items-center justify-center">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-semibold ${
                  room.isRecording 
                    ? 'bg-yellow-500 text-black' 
                    : 'bg-gray-600 text-white'
                }`}>
                  {room.hostAvatar}
                </div>
              </div>

              {/* Room Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2 mb-1">
                  <p className="text-sm font-medium text-white truncate">
                    {truncateHostName(room.hostName)}
                  </p>
                  {/* Animated voice wave icon */}
                  <div className="flex items-center space-x-0.5 ml-1">
                    <div className="w-0.5 h-2 bg-yellow-400 rounded-full animate-pulse"></div>
                    <div className="w-0.5 h-3 bg-yellow-400 rounded-full animate-pulse" style={{animationDelay: '0.2s'}}></div>
                    <div className="w-0.5 h-2 bg-yellow-400 rounded-full animate-pulse" style={{animationDelay: '0.4s'}}></div>
                  </div>
                </div>
                
                <p className="text-xs text-gray-300 truncate mb-2">
                  {room.topic}
                </p>
                
                <div className="flex items-center space-x-1">
                  <HiOutlineMicrophone className="w-3 h-3 text-gray-400" />
                  <span className="text-xs text-gray-400">
                    {room.participants} participants
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      </div>
    </>
  )
}

export default LiveVoiceRooms
