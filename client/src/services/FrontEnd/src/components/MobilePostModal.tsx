import React, { useState } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import { useTokenDataStore } from "~/store/tokenDataStore";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { HiOutlineX, HiOutlinePlus } from "react-icons/hi";
import { BsWallet } from 'react-icons/bs';
import { useTheme } from '~/hooks/useTheme'
import type { ActionParams } from '~/api/actions'

interface MobilePostModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const MobilePostModal: React.FC<MobilePostModalProps> = ({ isOpen, onClose }) => {
  const [text, setText] = useState('')
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isDark } = useTheme()
  const activeTokenId = useTokenDataStore(state => state.activeTokenId)
  const signAndSubmit = useSignAndSubmitAction()

  const handlePost = async () => {
    if (!text.trim() || !activeTokenId || !isConnected) return
    
    try {
      const params: ActionParams = {
        actionType: 'caw',
        senderId: activeTokenId,
        text: text.trim()
      }
      await signAndSubmit(params)
      setText('')
      onClose()
    } catch (err) {
      console.error('Post failed', err)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handlePost()
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-30 bg-black flex flex-col" style={{ top: '64px' }}>
      {/* Header */}
      <div className={`flex items-center justify-between p-4 border-b transition-all duration-300 ${
        isDark ? 'border-white/10' : 'border-gray-200'
      }`}>
        <button
          onClick={onClose}
          className={`p-2 rounded-lg transition-colors duration-200 ${
            isDark ? 'text-white hover:bg-white/10' : 'text-black hover:bg-gray-100'
          }`}
        >
          <HiOutlineX className="w-6 h-6" />
        </button>
        
        <h1 className={`text-lg font-semibold transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          New Post
        </h1>
        
        <button
          onClick={isConnected ? handlePost : openConnectModal}
          className="px-5 py-2 bg-yellow-500 text-black font-semibold text-base rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
        >
          {isConnected ? 'Post' : 'Connect'}
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Text Input Area */}
        <div className="flex-1 p-4">
          <textarea
            className={`w-full h-full resize-none border-none outline-none text-xl transition-all duration-300 ${
              isDark 
                ? 'bg-transparent text-white placeholder-gray-500' 
                : 'bg-transparent text-black placeholder-gray-600'
            }`}
            placeholder="What's happening?"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyPress={handleKeyPress}
            autoFocus
          />
        </div>

        {/* Footer with Icons */}
        <div className="p-4 border-t border-white/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-6">
              {/* Image Upload */}
              <button className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim() 
                  ? (isDark 
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' 
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark 
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10' 
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </button>
              
              {/* GIF */}
              <button className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim() 
                  ? (isDark 
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' 
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark 
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10' 
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
                <span className="text-sm font-medium">GIF</span>
              </button>
              
              {/* Video Upload */}
              <button className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim() 
                  ? (isDark 
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' 
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark 
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10' 
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              
              {/* Emoji Picker */}
              <button className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim() 
                  ? (isDark 
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' 
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark 
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10' 
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              
              {/* Schedule Post */}
              <button className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim() 
                  ? (isDark 
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' 
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark 
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10' 
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            </div>

            {/* Character Count */}
            <div className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-500'
            }`}>
              {text.length}/280
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default MobilePostModal
