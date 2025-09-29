import React, { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineArrowLeft } from 'react-icons/hi'

interface VoiceRoomProps {
  onStartRoom: (topic: string, isRecording: boolean) => void
}

const VoiceRoom: React.FC<VoiceRoomProps> = ({ onStartRoom }) => {
  const [topic, setTopic] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const { isDark } = useTheme()

  const handleStartRoom = () => {
    onStartRoom(topic || 'General Discussion', isRecording)
  }

  const toggleRecording = () => {
    setIsRecording(!isRecording)
  }

  return (
    <div className={`md:hidden fixed inset-0 z-[70] transition-all duration-300 ${
      isDark ? 'bg-black text-white' : 'bg-white text-black'
    }`}>
      {/* Mobile Header */}
      <div className={`md:hidden fixed top-0 left-0 right-0 z-[80] flex items-center justify-center p-4 border-b w-screen transition-all duration-300 ${
        isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'
      }`}>
               <button
                 onClick={() => onStartRoom('', false)} // Close modal
                 className={`absolute left-4 p-2 rounded-lg transition-colors duration-200 ${
                   isDark ? 'text-white hover:bg-white/10' : 'text-black hover:bg-gray-100'
                 }`}
               >
                 <HiOutlineArrowLeft className="w-6 h-6" />
               </button>
        
        <h1 className="text-lg font-semibold text-center">
          Create a Room
        </h1>
      </div>

      {/* Main Content - Mobile only */}
      <div className="md:hidden pt-20 px-6 py-8">
        <div className="max-w-md mx-auto">
          {/* Topic Input */}
          <div className="mb-8">
            <input
              id="topic"
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What do you want to talk about?"
              className={`w-full px-4 py-3 rounded-lg border transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-yellow-500 ${
                isDark 
                  ? 'bg-gray-800 border-gray-700 text-white placeholder-gray-400' 
                  : 'bg-gray-50 border-gray-300 text-black placeholder-gray-500'
              }`}
            />
          </div>

          {/* Record Voice Room Toggle */}
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-400">
                Record Voice Room
              </label>
              <button
                onClick={toggleRecording}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2 ${
                  isRecording 
                    ? 'bg-yellow-500' 
                    : 'bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                    isRecording ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Start Button */}
          <button
            onClick={handleStartRoom}
            className="w-full py-3 px-6 rounded-lg font-medium transition-all duration-200 bg-yellow-500 hover:bg-yellow-400 text-black shadow-lg hover:shadow-xl"
          >
            Start Now
          </button>
        </div>
      </div>

      {/* Desktop - Hidden */}
      <div className="hidden md:flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-4">Voice Room</h2>
          <p className="text-gray-500">This feature is only available on mobile devices.</p>
        </div>
      </div>
    </div>
  )
}

export default VoiceRoom
