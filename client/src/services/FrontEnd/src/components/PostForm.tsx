import React, { useState } from 'react'
import { useSignAndSubmitAction } from '../api/actions'
import { useTokenDataStore } from "~/store/tokenDataStore";
import { useAccount, useChains, useSwitchChain, useConnections } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { ActionParams } from '~/api/actions'
import { baseSepolia } from "wagmi/chains";
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
// Removed react-icons imports - using custom SVG icons instead
import { BsWallet } from 'react-icons/bs'

interface PostFormProps {
  /** if provided, we're replying to this caw */
  replyTo?: CawItem;
  quote?: CawItem;
  /** called after a successful sign+submit */
  onSuccess?: () => void;
}

const PostForm: React.FC<PostFormProps> = ({ replyTo, quote, onSuccess }) => {

  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const connections = useConnections();
  const { isDark } = useTheme()

  const [text, setText] = useState('')
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const signAndSubmit = useSignAndSubmitAction()

  const { switchChain } = useSwitchChain();
  const chains = useChains();
  const handleSwitchChain = () => switchChain({ chainId: baseSepolia.id });
  const wrongChain = connections[0]?.chainId != baseSepolia.id;
  console.log("CHAIN:", connections[0]?.chainId);

  return (
    <div className={`p-4 transition-all duration-300 ${isDark ? 'bg-black' : 'bg-white'}`}>
      {/* Mobile Layout - Avatar + Input + Button in one row */}
      <div className="md:hidden flex items-start space-x-3">
        {/* Avatar */}
        <div className="flex-shrink-0">
          <div className="w-10 h-10 rounded-full bg-yellow-500 flex items-center justify-center">
            <span className="text-black font-bold text-sm">U</span>
          </div>
        </div>
        
        {/* Input and Button Container */}
        <div className="flex-1 flex flex-col space-y-2">
          {/* Input and Reply Button Row */}
          <div className="flex items-center space-x-3">
            {/* Input */}
            <div className="flex-1">
              <textarea
                className={`w-full resize-none transition-all duration-300 border-none outline-none text-base ${
                  isDark 
                    ? 'bg-transparent text-white placeholder-gray-500' 
                    : 'bg-transparent text-black placeholder-gray-600'
                }`}
                rows={1}
                placeholder={
                  replyTo
                    ? `Reply to @${replyTo.user.username}`
                    : (
                      quote ? "Add a comment" : "What's happening?"
                    )
                }
                value={text}
                onChange={e => setText(e.target.value)}
              />
            </div>
            
            {/* Reply Button */}
            { !isConnected ? (
              <button 
                className="px-4 py-2 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer flex items-center justify-center gap-1" 
                onClick={openConnectModal}
              >
                <BsWallet className="w-3 h-3" />
                Connect
              </button>
            ) : wrongChain ? (
              <button className="px-4 py-2 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer" onClick={handleSwitchChain}>
                Switch
              </button>
            ) : (
              <button
                className="px-4 py-2 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
                disabled={!text}
                onClick={async () => {
                  const params: ActionParams = {
                    actionType: 'caw',
                    senderId:   activeTokenId!,
                    text,
                    ...(replyTo && {
                      receiverId:      replyTo.user.tokenId,
                      receiverCawonce: replyTo.cawonce,
                    })
                  }
                  await signAndSubmit(params)
                  setText('')
                  onSuccess?.()
                }}
              >
                {replyTo ? 'Reply' : 'Post'}
              </button>
            ) }
          </div>
          
          {/* Mobile Icons Row */}
          <div className="flex items-center space-x-4">
            {/* GIF */}
            <button className={`px-3 py-1 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer ${
              text.trim() 
                ? (isDark 
                    ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' 
                    : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                : (isDark 
                    ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10' 
                    : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
            }`}>
              GIF
            </button>
            
            {/* Emoji Picker */}
            <button className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
              text.trim() 
                ? (isDark 
                    ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10' 
                    : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                : (isDark 
                    ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10' 
                    : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
            }`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Desktop Layout - Original */}
      <div className="hidden md:block">
        <textarea
          className={`w-full resize-none transition-all duration-300 border-none outline-none text-xl ${
            isDark 
              ? 'bg-transparent text-white placeholder-gray-500' 
              : 'bg-transparent text-black placeholder-gray-600'
          }`}
          rows={3}
          placeholder={
            replyTo
              ? `Reply to @${replyTo.user.username}`
              : (
                quote ? "Add a comment" : "What's happening?"
              )
          }
          value={text}
          onChange={e => setText(e.target.value)}
        />
        
        {/* Functionality Icons */}
        <div className="flex items-center justify-between -mt-12">
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
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </div>

          {/* Post Button */}
          { !isConnected ? (
            <button 
              className="px-5 py-2 bg-yellow-500 text-black font-semibold text-base rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer flex items-center justify-center gap-2" 
              onClick={openConnectModal}
            >
              <BsWallet className="w-4 h-4" />
              Connect Wallet
            </button>
          ) : wrongChain ? (
            <button className="px-5 py-2 bg-yellow-500 text-black font-semibold text-base rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer" onClick={handleSwitchChain}>
              Switch Network
            </button>
          ) : (
            <button
              className="px-5 py-2 bg-yellow-500 text-black font-semibold text-base rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
              disabled={!text}
              onClick={async () => {
                const params: ActionParams = {
                  actionType: 'caw',
                  senderId:   activeTokenId!,
                  text,
                  ...(replyTo && {
                    receiverId:      replyTo.user.tokenId,
                    receiverCawonce: replyTo.cawonce,
                  })
                }
                await signAndSubmit(params)
                setText('')
                onSuccess?.()
              }}
            >
              {replyTo ? 'Reply' : 'Post'}
            </button>
          ) }
        </div>
      </div>
    </div>
  )
}

export default PostForm

