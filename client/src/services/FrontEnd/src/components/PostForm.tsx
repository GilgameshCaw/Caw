import React, { useState, useRef } from 'react'
import { useSignAndSubmitAction } from '../api/actions'
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import { useAccount, useChains, useSwitchChain, useConnections } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { ActionParams } from '~/api/actions'
import { baseSepolia } from "wagmi/chains";
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { BsWallet } from 'react-icons/bs'
import MediaUpload from './MediaUpload'
import type { MediaType, StorageType } from './MediaUpload'
import { calculateOnChainCost } from '~/utils/imageUtils'
import { usePendingPostsStore } from '~/store/pendingPostsStore'

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
  const [selectedMedia, setSelectedMedia] = useState<any[]>([])
  const [isDragOverTextarea, setIsDragOverTextarea] = useState(false)
  const [showGifPicker, setShowGifPicker] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showScheduler, setShowScheduler] = useState(false)
  const [showMediaUpload, setShowMediaUpload] = useState(false)
  const [showMediaOverlay, setShowMediaOverlay] = useState(false)
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const activeToken = useActiveToken();
  const signAndSubmit = useSignAndSubmitAction()
  const addPendingPost = usePendingPostsStore((state) => state.addPendingPost)

  const { switchChain } = useSwitchChain();
  const chains = useChains();
  const { address } = useAccount();
  const handleSwitchChain = () => switchChain({ chainId: baseSepolia.id });
  const wrongChain = connections[0]?.chainId != baseSepolia.id;
  console.log("CHAIN:", connections[0]?.chainId);

  // Check if the user owns the selected token
  const isTokenOwner = activeToken && address && activeToken.owner?.toLowerCase() === address.toLowerCase();
  const hasNoToken = !activeTokenId;
  const canPost = !hasNoToken && isTokenOwner && !wrongChain && isConnected;

  const handleMediaSelected = (media: any[]) => {
    setSelectedMedia(media)
  }

  const handleMediaRemoved = (index?: number) => {
    if (typeof index === 'number' && index >= 0 && index < selectedMedia.length) {
      setSelectedMedia(prev => {
        const newMedia = [...prev]
        newMedia.splice(index, 1)
        return newMedia
      })
    } else if (index === undefined) {
      setSelectedMedia([])
    }
  }

  // Helper function to upload media files
  const uploadMedia = async (files: File[], type: 'image' | 'video', tokenId: number) => {
    const formData = new FormData()
    files.forEach(file => formData.append('media', file))
    formData.append('type', type)
    formData.append('tokenId', tokenId.toString())

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Upload failed: ${text}`)
    }

    return response.json()
  }

  // Drag and drop handlers for textarea
  const handleTextareaDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // Check if dragging files
    const hasFiles = Array.from(e.dataTransfer.types).includes('Files')
    if (hasFiles) {
      setIsDragOverTextarea(true)
    }
  }

  const handleTextareaDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOverTextarea(false)
  }

  const handleTextareaDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOverTextarea(false)

    const files = Array.from(e.dataTransfer.files)

    // Process dropped files directly
    if (files.length > 0) {
      // Process files immediately
      const newMedia: any[] = []

      for (const file of files) {
        // Check if it's an image or video
        const isImage = file.type.startsWith('image/')
        const isVideo = file.type.startsWith('video/')

        if (!isImage && !isVideo) continue

        // Check limits
        const currentImages = selectedMedia.filter(m => m.type === 'image').length
        const currentVideos = selectedMedia.filter(m => m.type === 'video').length

        if (isImage && currentImages >= 4) continue
        if (isVideo && currentVideos >= 1) continue

        // Create media object
        const mediaFile = {
          file,
          type: isImage ? 'image' : 'video',
          preview: URL.createObjectURL(file),
          size: file.size,
          storageType: 'off-chain' // default to off-chain
        }

        newMedia.push(mediaFile)
      }

      if (newMedia.length > 0) {
        setSelectedMedia([...selectedMedia, ...newMedia])
      }
    }
  }

  const handleSubmit = async () => {
    let finalText = text
    let totalCawCost = BigInt(0)

    // Separate media by type
    const images = selectedMedia.filter(m => m.type === 'image')
    const videos = selectedMedia.filter(m => m.type === 'video')

    // Separate images by storage type (each image has its own storage type)
    const onChainImages = images.filter(img => img.storageType === 'on-chain')
    const offChainImages = images.filter(img => img.storageType !== 'on-chain')

    // Handle off-chain media (images and videos)
    if ((offChainImages.length > 0 || videos.length > 0) && activeTokenId) {
      try {
        // Upload images
        if (offChainImages.length > 0) {
          const imageFiles = offChainImages.map(img => img.file)
          const uploadResult = await uploadMedia(imageFiles, 'image', activeTokenId)

          if (uploadResult.success && uploadResult.urls) {
            const imageUrls = uploadResult.urls.map(url => `\n${url}`).join('')
            finalText = text + imageUrls
          } else {
            console.error('Failed to upload images:', uploadResult.error)
            return
          }
        }

        // Upload videos
        if (videos.length > 0) {
          const videoFiles = videos.map(vid => vid.file)
          const uploadResult = await uploadMedia(videoFiles, 'video', activeTokenId)

          if (uploadResult.success && uploadResult.urls) {
            const videoUrls = uploadResult.urls.map(url => `\nvideo:${url}`).join('')
            finalText = finalText + videoUrls
          } else {
            console.error('Failed to upload videos:', uploadResult.error)
            return
          }
        }
      } catch (error) {
        console.error('Error uploading media:', error)
        return
      }
    }

    // Handle on-chain images
    if (onChainImages.length > 0) {
      // Convert images to base64 and calculate cost
      const imageDataArray = await Promise.all(onChainImages.map(async img => {
        // Read file as base64
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.readAsDataURL(img.file)
        })

        const imageData = base64.split(',')[1] // Remove data:image/...;base64, prefix
        const cawCost = calculateOnChainCost(img.size)
        totalCawCost += BigInt(cawCost)
        return `image64:${imageData}`
      }))

      // Combine with text
      if (finalText.trim()) {
        finalText = `${imageDataArray.join('\n')}\n\n${finalText}`
      } else {
        finalText = imageDataArray.join('\n')
      }
    }

    const params: ActionParams = {
      actionType: onChainImages.length > 0 ? 'other' : 'caw',
      senderId: activeTokenId!,
      text: finalText,
      ...(replyTo && {
        receiverId: replyTo.user.tokenId,
        receiverCawonce: replyTo.cawonce,
      }),
      ...(totalCawCost > 0 && {
        amounts: [totalCawCost]
      })
    }

    // Add pending post to store (only if not a reply)
    if (!replyTo && activeToken) {
      addPendingPost({
        content: finalText,
        username: activeToken.username,
        tokenId: activeTokenId
      })
    }

    await signAndSubmit(params)

    // Reset form
    setText('')
    setSelectedMedia([])
    setShowMediaUpload(false)
    setShowMediaOverlay(false)
    onSuccess?.()
  }

  // Calculate character count including media URLs
  const calculateCharCount = () => {
    let totalLength = text.length

    // Add estimated URL lengths for off-chain media
    const offChainImages = selectedMedia.filter(m => m.type === 'image' && m.storageType !== 'on-chain')
    const videos = selectedMedia.filter(m => m.type === 'video')

    // Estimate ~80 chars per image URL, ~90 chars per video URL (including newlines and video: prefix)
    totalLength += offChainImages.length * 80
    totalLength += videos.length * 90

    return 420 - totalLength
  }

  const charCount = calculateCharCount()
  const isOverLimit = charCount < 0

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
            <div className="flex-1 relative">
              <textarea
                className={`w-full resize-none transition-all duration-300 border-none outline-none text-base ${
                  isDark
                    ? 'bg-transparent text-white placeholder-gray-500'
                    : 'bg-transparent text-black placeholder-gray-600'
                }`}
                style={{ boxShadow: 'none', padding: '2px 8px 0', marginBottom: '26px' }}
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
                onDragOver={handleTextareaDragOver}
                onDragLeave={handleTextareaDragLeave}
                onDrop={handleTextareaDrop}
              />
              {/* Drag overlay */}
              {isDragOverTextarea && (
                <div className="absolute inset-0 flex items-center justify-center bg-yellow-500/10 border-2 border-dashed border-yellow-500 rounded-lg pointer-events-none">
                  <div className="text-center">
                    <svg className="mx-auto h-8 w-8 text-yellow-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">Drop here</p>
                  </div>
                </div>
              )}
            </div>
            
            {/* Character counter and token ownership status */}
            <div className="flex items-center space-x-2">
              {!isTokenOwner && activeTokenId && isConnected && (
                <span className="text-xs text-red-500 font-medium">
                  Not token owner
                </span>
              )}
              {hasNoToken && (
                <span className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">
                  Select a token
                </span>
              )}
              {(text.length > 0 || selectedMedia.length > 0) && (
                <span className={`text-xs font-medium ${
                  isOverLimit
                    ? 'text-red-500'
                    : charCount <= 20
                      ? 'text-yellow-500'
                      : isDark ? 'text-gray-400' : 'text-gray-500'
                }`}>
                  {charCount}
                </span>
              )}
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
                disabled={(!text && selectedMedia.length === 0) || isOverLimit || !canPost}
                onClick={handleSubmit}
                title={!isTokenOwner && activeTokenId ? 'You do not own this token' : hasNoToken ? 'Please select a token' : ''}
              >
                {!isTokenOwner && activeTokenId ? 'Not Owner' : hasNoToken ? 'No Token' : replyTo ? 'Reply' : selectedMedia.some(m => m.type === 'image' && m.storageType === 'on-chain') ? 'Upload' : 'Post'}
              </button>
            ) }
          </div>
          
          {/* Mobile Icons Row */}
          <div className="flex items-center space-x-4">
            {/* Media Upload */}
            <button
              onClick={() => setShowMediaUpload(!showMediaUpload)}
              className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                selectedMedia.length > 0
                  ? 'text-yellow-500 bg-yellow-400/10'
                  : text.trim()
                    ? (isDark
                        ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                        : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                    : (isDark
                        ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                        : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </button>

            {/* GIF */}
            <button
              onClick={() => setShowGifPicker(!showGifPicker)}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer ${
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
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
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

        {/* Mobile Selected Media Display */}
        {selectedMedia.length > 0 && (
          <div
            className={`mt-4 p-2 rounded-lg border-2 transition-all duration-200 ${
              isDragOverTextarea
                ? 'border-yellow-500 border-dashed bg-yellow-50 dark:bg-yellow-900/20'
                : 'border-transparent'
            }`}
            onDragOver={handleTextareaDragOver}
            onDragLeave={handleTextareaDragLeave}
            onDrop={handleTextareaDrop}
          >
            <MediaUpload
              onMediaSelected={handleMediaSelected}
              onMediaRemoved={handleMediaRemoved}
              selectedMedia={selectedMedia}
              className=""
            />
          </div>
        )}

        {/* Mobile GIF Picker */}
        {showGifPicker && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
          }`}>
            <p className={`text-center text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              GIF picker coming soon...
            </p>
          </div>
        )}

        {/* Mobile Emoji Picker */}
        {showEmojiPicker && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
          }`}>
            <div className="grid grid-cols-6 gap-2 max-h-32 overflow-y-auto">
              {['😀', '😂', '🤣', '😊', '😍', '🤔', '😎', '🔥', '💯', '❤️', '👍', '👎'].map(emoji => (
                <button
                  key={emoji}
                  onClick={() => {
                    setText(prev => prev + emoji)
                    setShowEmojiPicker(false)
                  }}
                  className="p-1 text-xl hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Desktop Layout - Original */}
      <div className="hidden md:block">
        <div className="relative">
          <textarea
            className={`w-full resize-none border-none outline-none text-xl ${
              isDark
                ? 'bg-transparent text-white placeholder-gray-500'
                : 'bg-transparent text-black placeholder-gray-600'
            }`}
            style={{ boxShadow: 'none', padding: '2px 8px 26px 8px' }}
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
            onDragOver={handleTextareaDragOver}
            onDragLeave={handleTextareaDragLeave}
            onDrop={handleTextareaDrop}
          />
          {/* Drag overlay */}
          {isDragOverTextarea && (
            <div className="absolute inset-0 flex items-center justify-center bg-yellow-500/10 border-2 border-dashed border-yellow-500 rounded-lg pointer-events-none">
              <div className="text-center">
                <svg className="mx-auto h-12 w-12 text-yellow-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-lg font-medium text-yellow-600 dark:text-yellow-400">Drop photos or video here</p>
              </div>
            </div>
          )}
        </div>

        {/* Desktop Selected Media Display */}
        {selectedMedia.length > 0 && (
          <div
            className={`mt-4 p-2 rounded-lg border-2 transition-all duration-200 ${
              isDragOverTextarea
                ? 'border-yellow-500 border-dashed bg-yellow-50 dark:bg-yellow-900/20'
                : 'border-transparent'
            }`}
            onDragOver={handleTextareaDragOver}
            onDragLeave={handleTextareaDragLeave}
            onDrop={handleTextareaDrop}
          >
            <MediaUpload
              onMediaSelected={handleMediaSelected}
              onMediaRemoved={handleMediaRemoved}
              selectedMedia={selectedMedia}
              className=""
            />
          </div>
        )}

        {/* GIF Picker */}
        {showGifPicker && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
          }`}>
            <p className={`text-center ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              GIF picker coming soon...
            </p>
          </div>
        )}

        {/* Emoji Picker */}
        {showEmojiPicker && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
          }`}>
            <div className="grid grid-cols-8 gap-2 max-h-48 overflow-y-auto">
              {['😀', '😂', '🤣', '😊', '😍', '🤔', '😎', '🔥', '💯', '❤️', '👍', '👎', '👏', '🙏', '💪', '🚀'].map(emoji => (
                <button
                  key={emoji}
                  onClick={() => {
                    setText(prev => prev + emoji)
                    setShowEmojiPicker(false)
                  }}
                  className="p-2 text-2xl hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Scheduler */}
        {showScheduler && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
          }`}>
            <p className={`text-center ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Post scheduling coming soon...
            </p>
          </div>
        )}

        {/* Functionality Icons */}
        <div className="flex items-center justify-between mt-4">
          <div className="flex items-center space-x-6">
            {/* Media Upload */}
            <button
              onClick={() => setShowMediaUpload(!showMediaUpload)}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                selectedMedia.length > 0
                  ? 'text-yellow-500 bg-yellow-400/10'
                  : text.trim()
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
            <button
              onClick={() => setShowGifPicker(!showGifPicker)}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
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
            
            {/* Emoji Picker */}
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
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
            <button
              onClick={() => setShowScheduler(!showScheduler)}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
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

          {/* Character counter, token status and Post Button */}
          <div className="flex items-center space-x-3">
            {/* Token ownership and character counter */}
            <div className="flex items-center space-x-3">
              {!isTokenOwner && activeTokenId && isConnected && (
                <span className="text-sm text-red-500 font-medium">
                  Not token owner
                </span>
              )}
              {hasNoToken && (
                <span className="text-sm text-yellow-600 dark:text-yellow-400 font-medium">
                  Select a token
                </span>
              )}
              {(text.length > 0 || selectedMedia.length > 0) && (
                <span className={`text-sm font-medium ${
                  isOverLimit
                    ? 'text-red-500'
                    : charCount <= 20
                      ? 'text-yellow-500'
                      : isDark ? 'text-gray-400' : 'text-gray-500'
                }`}>
                  {charCount}
                </span>
              )}
            </div>

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
                disabled={(!text && selectedMedia.length === 0) || isOverLimit || !canPost}
                onClick={handleSubmit}
                title={!isTokenOwner && activeTokenId ? 'You do not own this token' : hasNoToken ? 'Please select a token' : ''}
              >
                {!isTokenOwner && activeTokenId ? 'Not Owner' : hasNoToken ? 'No Token' : replyTo ? 'Reply' : selectedMedia.some(m => m.type === 'image' && m.storageType === 'on-chain') ? 'Upload' : 'Post'}
              </button>
            ) }
          </div>
        </div>
      </div>
    </div>
  )
}

export default PostForm

