import React, { useState, useRef, useEffect } from 'react'
import { useSignAndSubmitAction, buildTypedData, TYPES, DOMAIN } from '../api/actions'
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import { useAccount, useChains, useSwitchChain, useConnections, useSignTypedData } from "wagmi";
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
import { apiFetch } from '~/api/client'
import { HiCalendar, HiClock } from 'react-icons/hi'
import InsufficientStakeModal from './modals/InsufficientStakeModal'
import { hasMinimumStake, getRequiredStake } from '~/constants/stakingRequirements'
import MentionAutocomplete from './MentionAutocomplete'
import GifPicker from './GifPicker'

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

  // Auto-focus the textarea when component mounts (e.g., when modal opens)
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  const [text, setText] = useState('')
  const [cursorPosition, setCursorPosition] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedMedia, setSelectedMedia] = useState<any[]>([])
  const [isDragOverTextarea, setIsDragOverTextarea] = useState(false)
  const [showGifPicker, setShowGifPicker] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showScheduler, setShowScheduler] = useState(false)
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [isScheduling, setIsScheduling] = useState(false)
  const [showMediaUpload, setShowMediaUpload] = useState(false)
  const [showMediaOverlay, setShowMediaOverlay] = useState(false)
  const [showInsufficientStakeModal, setShowInsufficientStakeModal] = useState(false)
  const [showScheduledSuccessModal, setShowScheduledSuccessModal] = useState(false)
  const [scheduledSuccessTime, setScheduledSuccessTime] = useState<Date | null>(null)
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const activeToken = useActiveToken();
  const signAndSubmit = useSignAndSubmitAction()
  const { signTypedDataAsync } = useSignTypedData()
  const bumpCawonce = useTokenDataStore(s => s.bumpCawonce)
  const addPendingPost = usePendingPostsStore((state) => state.addPendingPost)
  const updatePostWithTxQueueId = usePendingPostsStore((state) => state.updatePostWithTxQueueId)

  const { switchChain } = useSwitchChain();
  const chains = useChains();
  const { address } = useAccount();
  const handleSwitchChain = () => switchChain({ chainId: baseSepolia.id });
  const wrongChain = connections[0]?.chainId != baseSepolia.id;
  console.log("CHAIN:", connections[0]?.chainId);

  // Check if the user owns the selected token
  const isTokenOwner = activeToken && address && activeToken.owner?.toLowerCase() === address.toLowerCase();
  const hasNoToken = !activeToken?.tokenId;
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

  // Handle GIF selection from picker
  const handleGifSelected = (gif: { id: string; url: string; title: string; preview: string; width: number; height: number }) => {
    // Add GIF as a media item (treated as off-chain image URL)
    const gifMedia = {
      type: 'gif' as const,
      url: gif.url,
      preview: gif.preview,
      title: gif.title,
      width: gif.width,
      height: gif.height,
      storageType: 'off-chain'
    }
    setSelectedMedia(prev => [...prev, gifMedia])
    setShowGifPicker(false)
  }

  // Handle file input selection
  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const newMedia: any[] = []

    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')

      if (!isImage && !isVideo) continue

      // Check limits
      const currentImages = selectedMedia.filter(m => m.type === 'image').length
      const currentVideos = selectedMedia.filter(m => m.type === 'video').length

      if (isImage && currentImages + newMedia.filter(m => m.type === 'image').length >= 4) continue
      if (isVideo && currentVideos + newMedia.filter(m => m.type === 'video').length >= 1) continue

      const mediaFile = {
        file,
        type: isImage ? 'image' : 'video',
        preview: URL.createObjectURL(file),
        size: file.size,
        storageType: 'off-chain'
      }

      newMedia.push(mediaFile)
    }

    if (newMedia.length > 0) {
      setSelectedMedia(prev => [...prev, ...newMedia])
    }

    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Handle text change and cursor position for mention autocomplete
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    setCursorPosition(e.target.selectionStart)
  }

  const handleTextClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    setCursorPosition((e.target as HTMLTextAreaElement).selectionStart)
  }

  const handleTextKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    setCursorPosition((e.target as HTMLTextAreaElement).selectionStart)
  }

  // Handle mention selection from autocomplete
  const handleMentionSelect = (username: string, startPos: number, endPos: number) => {
    const beforeMention = text.substring(0, startPos)
    const afterMention = text.substring(endPos)
    const newText = `${beforeMention}@${username} ${afterMention}`

    setText(newText)

    // Set cursor position after the inserted mention
    setTimeout(() => {
      if (textareaRef.current) {
        const newCursorPos = startPos + username.length + 2 // +2 for @ and space
        textareaRef.current.selectionStart = newCursorPos
        textareaRef.current.selectionEnd = newCursorPos
        setCursorPosition(newCursorPos)
        textareaRef.current.focus()
      }
    }, 0)
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
    // Get effective token ID with fallback
    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId) {
      console.error('No active token ID - user may not be connected or data not loaded')
      return
    }

    // Check for minimum stake first
    const requiredStakeType = replyTo ? 'MIN_STAKE_COMMENT' : quote ? 'MIN_STAKE_QUOTE' : 'MIN_STAKE_POST'
    if (!hasMinimumStake(activeToken?.stakedAmount, requiredStakeType)) {
      setShowInsufficientStakeModal(true)
      return
    }

    // Check if this is a scheduled post
    if (showScheduler && scheduledDate && scheduledTime) {

      setIsScheduling(true)
      try {
        const scheduledAt = new Date(`${scheduledDate}T${scheduledTime}`)

        // Prepare image data if any
        let imageData = null
        const images = selectedMedia.filter(m => m.type === 'image')
        if (images.length > 0) {
          // For scheduled posts, only support on-chain images
          const onChainImages = images.filter(img => img.storageType === 'on-chain')
          if (onChainImages.length > 0) {
            imageData = onChainImages.map(img => img.content).join('|||')
          }
        }

        // Build the post content (same as regular posts)
        let finalText = text
        if (imageData) {
          finalText = text + '\n' + imageData.split('|||').map((img: string) => `image64:${img}`).join('\n')
        }

        // Handle GIFs (already have URLs from Giphy)
        const gifs = selectedMedia.filter(m => m.type === 'gif')
        if (gifs.length > 0) {
          const gifUrls = gifs.map(gif => `\n${gif.url}`).join('')
          finalText = finalText + gifUrls
        }

        // Get current cawonce
        const currentCawonce = activeToken?.cawonce ?? 0

        // Build EIP-712 typed data (same as regular post)
        const { domain, types, primaryType, message } = buildTypedData({
          actionType: 'caw',
          senderId: effectiveTokenId,
          text: finalText,
          cawonce: currentCawonce
        })

        // Sign the action (user will see the signature request)
        const signature = await signTypedDataAsync({
          domain,
          types: { ActionData: TYPES.ActionData },
          primaryType,
          message
        })

        // Bump cawonce after successful signature
        bumpCawonce(effectiveTokenId)

        // Send to scheduled API with the signed data
        await apiFetch('/api/scheduled', {
          method: 'POST',
          body: JSON.stringify({
            content: text,
            scheduledAt: scheduledAt.toISOString(),
            imageData,
            // Include signed action data for later processing
            signedAction: {
              data: message,
              domain,
              types,
              signature
            }
          }),
          headers: { 'x-user-id': effectiveTokenId.toString() }
        })

        // Clear form
        setText('')
        setSelectedMedia([])
        setShowScheduler(false)
        setScheduledDate('')
        setScheduledTime('')

        // Show success modal
        setScheduledSuccessTime(scheduledAt)
        setShowScheduledSuccessModal(true)
        if (onSuccess) onSuccess()
      } catch (error: any) {
        // Don't show error if user rejected signature
        if (error?.message?.includes('User rejected') || error?.code === 4001) {
          console.log('User cancelled signature')
        } else {
          console.error('Failed to schedule post:', error)
        }
      } finally {
        setIsScheduling(false)
      }
      return
    }

    // Regular post submission
    let finalText = text
    let totalCawCost = BigInt(0)

    // Separate media by type
    const images = selectedMedia.filter(m => m.type === 'image')
    const videos = selectedMedia.filter(m => m.type === 'video')
    const gifs = selectedMedia.filter(m => m.type === 'gif')

    // Separate images by storage type (each image has its own storage type)
    const onChainImages = images.filter(img => img.storageType === 'on-chain')
    const offChainImages = images.filter(img => img.storageType !== 'on-chain')

    // Handle off-chain media (images and videos)
    if (offChainImages.length > 0 || videos.length > 0) {
      try {
        // Upload images
        if (offChainImages.length > 0) {
          const imageFiles = offChainImages.map(img => img.file)
          const uploadResult = await uploadMedia(imageFiles, 'image', effectiveTokenId)

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
          const uploadResult = await uploadMedia(videoFiles, 'video', effectiveTokenId)

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

    // Handle GIFs (already have URLs from Giphy)
    if (gifs.length > 0) {
      const gifUrls = gifs.map(gif => `\n${gif.url}`).join('')
      finalText = finalText + gifUrls
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

    // effectiveTokenId is already defined at the start of handleSubmit

    // For replies and quotes, include the original post's info
    const parentCaw = replyTo || quote

    const params: ActionParams = {
      actionType: onChainImages.length > 0 ? 'other' : 'caw',
      senderId: effectiveTokenId,
      text: finalText,
      ...(parentCaw && {
        receiverId: parentCaw.user.tokenId,
        receiverCawonce: parentCaw.cawonce,
      }),
      ...(totalCawCost > 0 && {
        amounts: [totalCawCost]
      })
    }

    // Add pending post to store (only if not a reply)
    let tempId: string | undefined
    if (!replyTo && activeToken) {
      tempId = addPendingPost({
        content: finalText,
        username: activeToken.username,
        tokenId: effectiveTokenId
      })
    }

    const response = await signAndSubmit(params)

    // Update pending post with txQueue ID if we have both
    if (tempId && response?.txQueueId) {
      updatePostWithTxQueueId(tempId, response.txQueueId)
    }

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
    const gifs = selectedMedia.filter(m => m.type === 'gif')

    // Estimate ~80 chars per image URL, ~90 chars per video URL, ~100 chars per GIF URL
    totalLength += offChainImages.length * 80
    totalLength += videos.length * 90
    totalLength += gifs.length * 100

    return 420 - totalLength
  }

  const charCount = calculateCharCount()
  const isOverLimit = charCount < 0

  return (
    <div className={`p-4 transition-all duration-300 ${isDark ? 'bg-black' : 'bg-white'}`}>
      {/* Hidden file input for media selection */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={handleFileInputChange}
        className="hidden"
      />

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
                ref={textareaRef}
                onChange={handleTextChange}
                onClick={handleTextClick}
                onKeyUp={handleTextKeyUp}
                onDragOver={handleTextareaDragOver}
                onDragLeave={handleTextareaDragLeave}
                onDrop={handleTextareaDrop}
              />
              <MentionAutocomplete
                text={text}
                cursorPosition={cursorPosition}
                onSelect={handleMentionSelect}
                textareaRef={textareaRef}
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
                {!isTokenOwner && activeTokenId ? 'Wrong Address' : hasNoToken ? 'No Token' : replyTo ? 'Reply' : selectedMedia.some(m => m.type === 'image' && m.storageType === 'on-chain') ? 'Upload' : 'Post'}
              </button>
            ) }
          </div>
          
          {/* Mobile Icons Row */}
          <div className="flex items-center space-x-4">
            {/* Media Upload */}
            <button
              onClick={() => fileInputRef.current?.click()}
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
        {selectedMedia.filter(m => m.type !== 'gif').length > 0 && (
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
              selectedMedia={selectedMedia.filter(m => m.type !== 'gif')}
              className=""
            />
          </div>
        )}

        {/* Mobile Selected GIF Preview */}
        {selectedMedia.filter(m => m.type === 'gif').length > 0 && (
          <div className="mt-4">
            {selectedMedia.filter(m => m.type === 'gif').map((gif, index) => (
              <div key={gif.url} className="relative inline-block">
                <img
                  src={gif.preview}
                  alt={gif.title || 'Selected GIF'}
                  className="max-h-32 rounded-lg"
                />
                <button
                  onClick={() => {
                    const gifIndex = selectedMedia.findIndex(m => m.type === 'gif' && m.url === gif.url)
                    handleMediaRemoved(gifIndex)
                  }}
                  className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <span className={`absolute bottom-1 left-1 px-1.5 py-0.5 text-xs font-medium rounded ${
                  isDark ? 'bg-black/70 text-white' : 'bg-white/70 text-black'
                }`}>
                  GIF
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Mobile GIF Picker */}
        {showGifPicker && (
          <div className="mt-4">
            <GifPicker
              initialQuery={text.trim()}
              onSelect={handleGifSelected}
              onClose={() => setShowGifPicker(false)}
            />
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
            ref={textareaRef}
            onChange={handleTextChange}
            onClick={handleTextClick}
            onKeyUp={handleTextKeyUp}
            onDragOver={handleTextareaDragOver}
            onDragLeave={handleTextareaDragLeave}
            onDrop={handleTextareaDrop}
          />
          <MentionAutocomplete
            text={text}
            cursorPosition={cursorPosition}
            onSelect={handleMentionSelect}
            textareaRef={textareaRef}
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
        {selectedMedia.filter(m => m.type !== 'gif').length > 0 && (
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
              selectedMedia={selectedMedia.filter(m => m.type !== 'gif')}
              className=""
            />
          </div>
        )}

        {/* Desktop Selected GIF Preview */}
        {selectedMedia.filter(m => m.type === 'gif').length > 0 && (
          <div className="mt-4">
            {selectedMedia.filter(m => m.type === 'gif').map((gif, index) => (
              <div key={gif.url} className="relative inline-block">
                <img
                  src={gif.preview}
                  alt={gif.title || 'Selected GIF'}
                  className="max-h-48 rounded-lg"
                />
                <button
                  onClick={() => {
                    const gifIndex = selectedMedia.findIndex(m => m.type === 'gif' && m.url === gif.url)
                    handleMediaRemoved(gifIndex)
                  }}
                  className="absolute -top-2 -right-2 p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <span className={`absolute bottom-2 left-2 px-2 py-1 text-xs font-semibold rounded ${
                  isDark ? 'bg-black/70 text-white' : 'bg-white/70 text-black'
                }`}>
                  GIF
                </span>
              </div>
            ))}
          </div>
        )}

        {/* GIF Picker */}
        {showGifPicker && (
          <div className="mt-4">
            <GifPicker
              initialQuery={text.trim()}
              onSelect={handleGifSelected}
              onClose={() => setShowGifPicker(false)}
            />
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
            <div className="flex items-center space-x-2 mb-3">
              <HiCalendar className={`w-5 h-5 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
              <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Schedule Post
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`block text-sm mb-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Date
                </label>
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className={`w-full px-3 py-2 rounded-lg border transition-colors ${
                    isDark
                      ? 'bg-gray-700 border-gray-600 text-white focus:border-yellow-400'
                      : 'bg-white border-gray-300 text-gray-900 focus:border-yellow-500'
                  } focus:outline-none`}
                />
              </div>
              <div>
                <label className={`block text-sm mb-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Time
                </label>
                <input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className={`w-full px-3 py-2 rounded-lg border transition-colors ${
                    isDark
                      ? 'bg-gray-700 border-gray-600 text-white focus:border-yellow-400'
                      : 'bg-white border-gray-300 text-gray-900 focus:border-yellow-500'
                  } focus:outline-none`}
                />
              </div>
            </div>
            {scheduledDate && scheduledTime && (
              <p className={`mt-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                <HiClock className="inline-block w-4 h-4 mr-1" />
                Scheduled for {new Date(`${scheduledDate}T${scheduledTime}`).toLocaleString()}
              </p>
            )}
          </div>
        )}

        {/* Functionality Icons */}
        <div className="flex items-center justify-between mt-4">
          <div className="flex items-center space-x-6">
            {/* Media Upload */}
            <button
              onClick={() => fileInputRef.current?.click()}
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
                {!isTokenOwner && activeTokenId ? 'Wrong Address' : hasNoToken ? 'No Token' : replyTo ? 'Reply' : selectedMedia.some(m => m.type === 'image' && m.storageType === 'on-chain') ? 'Upload' : 'Post'}
              </button>
            ) }
          </div>
        </div>
      </div>

      {/* Insufficient Stake Modal */}
      <InsufficientStakeModal
        isOpen={showInsufficientStakeModal}
        onClose={() => setShowInsufficientStakeModal(false)}
        actionType={replyTo ? 'post' : quote ? 'post' : 'post'}
        currentAmount={activeToken?.stakedAmount}
        requiredAmount={getRequiredStake(
          replyTo ? 'MIN_STAKE_COMMENT' : quote ? 'MIN_STAKE_QUOTE' : 'MIN_STAKE_POST'
        )}
      />

      {/* Scheduled Post Success Modal */}
      {showScheduledSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowScheduledSuccessModal(false)}
          />
          <div className={`relative z-10 w-full max-w-sm mx-4 p-6 rounded-2xl shadow-xl ${
            isDark ? 'bg-gray-900 border border-white/10' : 'bg-white border border-gray-200'
          }`}>
            <div className="text-center">
              <div className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center ${
                isDark ? 'bg-green-500/20' : 'bg-green-100'
              }`}>
                <HiCalendar className="w-8 h-8 text-green-500" />
              </div>
              <h3 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Post Scheduled!
              </h3>
              <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                Your post will be published on
              </p>
              <p className={`text-base font-medium mb-6 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>
                {scheduledSuccessTime?.toLocaleString()}
              </p>
              <button
                onClick={() => setShowScheduledSuccessModal(false)}
                className="w-full py-3 px-4 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default PostForm

