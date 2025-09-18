// src/components/MediaUpload.tsx
import React, { useState, useCallback, useRef } from 'react'
import {
  HiOutlinePhotograph,
  HiOutlineVideoCamera,
  HiOutlineX,
  HiOutlineCloudUpload,
  HiOutlineCube,
  HiOutlineExclamationCircle,
  HiOutlinePlay
} from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { calculateOnChainCost } from '~/utils/imageUtils'
import { formatEngagementCount } from '~/utils/numberFormat'

export type MediaType = 'image' | 'video'
export type StorageType = 'off-chain' | 'on-chain'

interface MediaFile {
  file: File
  type: MediaType
  preview: string
  size: number
  duration?: number // for videos
  width?: number
  height?: number
  storageType?: StorageType // per-file storage type (images only)
}

interface MediaUploadProps {
  onMediaSelected: (media: MediaFile[]) => void
  onMediaRemoved?: (index?: number) => void
  selectedMedia?: MediaFile[]
  maxImages?: number
  maxVideos?: number
  className?: string
  isOverlay?: boolean
  onClose?: () => void
}

const SIZE_LIMITS = {
  IMAGE_MAX: 10 * 1024 * 1024, // 10MB for images
  VIDEO_MAX: 100 * 1024 * 1024, // 100MB for videos
  ON_CHAIN_MAX: 50 * 1024 // 50KB for on-chain storage (images only)
}

const MediaUpload: React.FC<MediaUploadProps> = ({
  onMediaSelected,
  onMediaRemoved,
  selectedMedia = [],
  maxImages = 4,
  maxVideos = 1,
  className = '',
  isOverlay = false,
  onClose
}) => {
  const { isDark } = useTheme()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentImages = selectedMedia.filter(m => m.type === 'image').length
  const currentVideos = selectedMedia.filter(m => m.type === 'video').length
  const canAddImage = currentImages < maxImages
  const canAddVideo = currentVideos < maxVideos

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    await processFiles(files)
  }, [selectedMedia])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      await processFiles(Array.from(files))
    }
  }, [selectedMedia])

  const processFiles = async (files: File[]) => {
    setIsProcessing(true)
    setError(null)

    try {
      const newMedia: MediaFile[] = []
      const existingImages = selectedMedia.filter(m => m.type === 'image').length
      const existingVideos = selectedMedia.filter(m => m.type === 'video').length

      for (let file of files) {
        // Determine file type
        const isImage = file.type.startsWith('image/')
        const isVideo = file.type.startsWith('video/')

        if (!isImage && !isVideo) {
          setError('Please select only image or video files')
          continue
        }

        // Check limits
        if (isImage && existingImages + newMedia.filter(m => m.type === 'image').length >= maxImages) {
          setError(`Maximum ${maxImages} images allowed`)
          continue
        }

        if (isVideo && existingVideos + newMedia.filter(m => m.type === 'video').length >= maxVideos) {
          setError(`Maximum ${maxVideos} video allowed`)
          continue
        }

        // Auto-compress large images
        if (isImage && file.size > SIZE_LIMITS.IMAGE_MAX) {
          try {
            const compressed = await compressImage(file)
            if (compressed) {
              file = compressed
              setError(`Image was compressed from ${formatFileSize(file.size)} to ${formatFileSize(compressed.size)}`)
            } else {
              setError('Image file too large and could not be compressed (max 10MB)')
              continue
            }
          } catch (err) {
            setError('Failed to compress large image')
            continue
          }
        }

        if (isVideo && file.size > SIZE_LIMITS.VIDEO_MAX) {
          setError('Video file too large (max 100MB)')
          continue
        }

        // Create media file object
        const mediaFile: MediaFile = {
          file,
          type: isImage ? 'image' : 'video',
          preview: URL.createObjectURL(file),
          size: file.size,
          storageType: 'off-chain' // default to off-chain
        }

        // Get dimensions for images
        if (isImage) {
          const img = new Image()
          img.src = mediaFile.preview
          await new Promise(resolve => {
            img.onload = () => {
              mediaFile.width = img.width
              mediaFile.height = img.height
              resolve(null)
            }
          })
        }

        // Get duration for videos
        if (isVideo) {
          const video = document.createElement('video')
          video.src = mediaFile.preview
          await new Promise(resolve => {
            video.onloadedmetadata = () => {
              mediaFile.duration = video.duration
              mediaFile.width = video.videoWidth
              mediaFile.height = video.videoHeight
              resolve(null)
            }
          })
        }

        newMedia.push(mediaFile)
      }

      if (newMedia.length > 0) {
        onMediaSelected([...selectedMedia, ...newMedia])
      }

    } catch (err) {
      setError('Failed to process files')
    } finally {
      setIsProcessing(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const removeMedia = (index: number) => {
    // Only call onMediaRemoved if it's provided, otherwise handle internally
    if (onMediaRemoved) {
      onMediaRemoved(index)
    } else {
      const newMedia = selectedMedia.filter((_, i) => i !== index)
      onMediaSelected(newMedia)
    }
  }

  const toggleStorageType = (index: number) => {
    const media = selectedMedia[index]
    if (media.type !== 'image') return // Only images can be on-chain

    const newStorageType = media.storageType === 'on-chain' ? 'off-chain' : 'on-chain'

    // Check size limit for on-chain storage
    if (newStorageType === 'on-chain' && media.size > SIZE_LIMITS.ON_CHAIN_MAX) {
      setError('Image too large for on-chain storage (max 50KB)')
      return
    }

    const updatedMedia = [...selectedMedia]
    updatedMedia[index] = {
      ...media,
      storageType: newStorageType
    }
    onMediaSelected(updatedMedia)
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  const compressImage = async (file: File): Promise<File | null> => {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        // Start with original dimensions
        let width = img.width
        let height = img.height

        // Scale down if needed
        const maxDimension = 2048
        if (width > maxDimension || height > maxDimension) {
          const scale = maxDimension / Math.max(width, height)
          width = width * scale
          height = height * scale
        }

        canvas.width = width
        canvas.height = height
        ctx?.drawImage(img, 0, 0, width, height)

        canvas.toBlob((blob) => {
          if (blob && blob.size < file.size) {
            const compressedFile = new File([blob], file.name, {
              type: 'image/jpeg',
              lastModified: Date.now()
            })
            resolve(compressedFile)
          } else {
            resolve(null)
          }
        }, 'image/jpeg', 0.85)
      }

      img.onerror = () => resolve(null)
      img.src = URL.createObjectURL(file)
    })
  }

  const handleCompressImage = async (index: number) => {
    const media = selectedMedia[index]
    if (media.type !== 'image') return

    setIsProcessing(true)
    const compressed = await compressImage(media.file)

    if (compressed) {
      const updatedMedia = [...selectedMedia]
      updatedMedia[index] = {
        ...media,
        file: compressed,
        size: compressed.size,
        preview: URL.createObjectURL(compressed)
      }
      onMediaSelected(updatedMedia)
      setError(`Image compressed from ${formatFileSize(media.size)} to ${formatFileSize(compressed.size)}`)
    } else {
      setError('Could not compress image further')
    }
    setIsProcessing(false)
  }

  if (isOverlay) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90" onClick={onClose}>
        <div
          className={`relative max-w-2xl w-full p-6 rounded-lg ${
            isDark ? 'bg-gray-900' : 'bg-white'
          }`}
          onClick={e => e.stopPropagation()}
        >
          {/* Close button */}
          {onClose && (
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <HiOutlineX className="w-5 h-5" />
            </button>
          )}

          <div className={`space-y-4 ${className}`}>
            {/* Upload Area */}
            {(canAddImage || canAddVideo) && (
              <div
                className={`
                  border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all duration-200
                  ${isDragOver
                    ? 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                    : 'border-gray-300 dark:border-gray-600 hover:border-yellow-400 dark:hover:border-yellow-500'
                  }
                  ${isProcessing ? 'opacity-50 pointer-events-none' : ''}
                `}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                />

                <div className="flex justify-center space-x-4 mb-4">
                  <HiOutlinePhotograph className={`h-12 w-12 ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`} />
                  <HiOutlineVideoCamera className={`h-12 w-12 ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`} />
                </div>

                <p className={`text-lg font-medium mb-2 ${
                  isDark ? 'text-white' : 'text-gray-900'
                }`}>
                  {isProcessing ? 'Processing...' : 'Drop photos or video here'}
                </p>

                <p className={`text-sm ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  or click to select
                </p>

                <p className={`text-xs mt-3 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  Images: up to {maxImages} files, 10MB each • Video: {maxVideos} file, 100MB max
                </p>
              </div>
            )}

            {/* Error Display */}
            {error && (
              <div className="flex items-center p-3 bg-red-100 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <HiOutlineExclamationCircle className="h-5 w-5 text-red-500 mr-2 flex-shrink-0" />
                <span className="text-sm text-red-700 dark:text-red-400">{error}</span>
              </div>
            )}

            {/* Selected Media Display */}
            {selectedMedia.length > 0 && (
              <div className="space-y-3">
                <h4 className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Selected Media ({selectedMedia.length})
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  {selectedMedia.map((media, index) => (
                    <div
                      key={index}
                      className={`relative rounded-lg overflow-hidden border ${
                        isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
                      }`}
                    >
                      {/* Media Preview */}
                      {media.type === 'image' ? (
                        <img
                          src={media.preview}
                          alt={`Selected ${index + 1}`}
                          className="w-full h-32 object-cover"
                        />
                      ) : (
                        <div className="relative w-full h-32 bg-black flex items-center justify-center">
                          <video
                            src={media.preview}
                            className="w-full h-full object-contain"
                          />
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="bg-black/60 rounded-full p-3">
                              <HiOutlinePlay className="w-6 h-6 text-white" />
                            </div>
                          </div>
                          {media.duration && (
                            <span className="absolute bottom-2 right-2 text-xs text-white bg-black/60 px-2 py-1 rounded">
                              {formatDuration(media.duration)}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Remove Button */}
                      <button
                        onClick={() => removeMedia(index)}
                        className="absolute top-2 right-2 p-1 rounded-full bg-black/50 hover:bg-black/70 transition-colors"
                        title="Remove"
                      >
                        <HiOutlineX className="h-4 w-4 text-white" />
                      </button>

                      {/* File Info and Storage Toggle */}
                      <div className={`p-2 ${
                        isDark ? 'bg-gray-800' : 'bg-gray-50'
                      }`}>
                        <div className={`text-xs ${
                          isDark ? 'text-gray-400' : 'text-gray-600'
                        }`}>
                          {formatFileSize(media.size)}
                          {media.width && media.height && (
                            <span className="ml-1">• {media.width}×{media.height}</span>
                          )}
                        </div>

                        {/* Storage toggle for images only */}
                        {media.type === 'image' && (
                          <div className="mt-2">
                            <label className="flex items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={media.storageType === 'on-chain'}
                                onChange={() => toggleStorageType(index)}
                                className="sr-only"
                              />
                              <div className="relative w-10 h-5 flex items-center">
                                <div className={`absolute w-full h-5 rounded-full transition-colors duration-200 ${
                                  media.storageType === 'on-chain'
                                    ? 'bg-yellow-500'
                                    : 'bg-gray-300 dark:bg-gray-600'
                                }`} />
                                <div className={`absolute w-4 h-4 bg-white rounded-full shadow-md transform transition-all duration-200 ${
                                  media.storageType === 'on-chain'
                                    ? 'translate-x-6'
                                    : 'translate-x-0.5'
                                }`} />
                              </div>
                              <div className="ml-2">
                                <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                  {media.storageType === 'on-chain' ? 'On-chain' : 'Standard'}
                                </span>
                                {media.storageType === 'on-chain' && (
                                  <div className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">
                                    Cost: {calculateOnChainCost(media.size)} CAW
                                  </div>
                                )}
                              </div>
                            </label>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Non-overlay mode (inline display)
  return (
    <div
      className={`space-y-4 ${className}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Media limit info */}
      {selectedMedia.length > 0 && (
        <p className={`text-xs ${
          isDark ? 'text-gray-500' : 'text-gray-500'
        }`}>
          {selectedMedia.filter(m => m.type === 'image').length}/4 images •
          {selectedMedia.filter(m => m.type === 'video').length}/1 video
        </p>
      )}

      {/* Selected Media Display */}
      {selectedMedia.length > 0 && (
        <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
          {selectedMedia.map((media, index) => (
            <div
              key={index}
              className={`relative rounded-lg overflow-hidden border ${
                isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
              }`}
            >
              {/* Media Preview - 1:1 aspect ratio */}
              <div className="relative aspect-square bg-black">
                {media.type === 'image' ? (
                  <img
                    src={media.preview}
                    alt={`Selected ${index + 1}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <>
                    <video
                      src={media.preview}
                      className="w-full h-full object-contain"
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="bg-black/60 rounded-full p-2">
                        <HiOutlinePlay className="w-4 h-4 text-white" />
                      </div>
                    </div>
                    {media.duration && (
                      <span className="absolute bottom-1 right-1 text-xs text-white bg-black/60 px-1 py-0.5 rounded">
                        {formatDuration(media.duration)}
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* Remove Button */}
              <button
                onClick={() => removeMedia(index)}
                className="absolute top-1 right-1 p-0.5 rounded-full bg-black/50 hover:bg-black/70 transition-colors"
                title="Remove"
              >
                <HiOutlineX className="h-3 w-3 text-white" />
              </button>

              {/* Compress Button for large images */}
              {media.type === 'image' && media.size > SIZE_LIMITS.ON_CHAIN_MAX && (
                <button
                  onClick={() => handleCompressImage(index)}
                  className="absolute bottom-1 right-1 px-2 py-0.5 text-xs bg-black/70 hover:bg-black/90 text-white rounded transition-colors"
                  title="Compress for on-chain storage"
                  disabled={isProcessing}
                >
                  Compress
                </button>
              )}

              {/* Storage toggle for images - full width banner at bottom */}
              {media.type === 'image' && (
                <div className={`absolute bottom-0 left-0 right-0 ${
                  media.storageType === 'on-chain'
                    ? 'bg-yellow-500/95'
                    : isDark ? 'bg-gray-900/95' : 'bg-white/95'
                } backdrop-blur-sm p-2 transition-colors`}>
                  <label className="flex items-center justify-between cursor-pointer">
                    <div className="flex flex-col">
                      <span className={`text-xs font-medium ${
                        media.storageType === 'on-chain'
                          ? 'text-black'
                          : isDark ? 'text-gray-300' : 'text-gray-700'
                      }`}>
                        On-chain
                      </span>
                      {media.storageType === 'on-chain' && (
                        <span className="text-xs text-black/80">
                          {formatEngagementCount(calculateOnChainCost(media.size))} CAW
                        </span>
                      )}
                    </div>
                    <div className="relative flex items-center">
                      <input
                        type="checkbox"
                        checked={media.storageType === 'on-chain'}
                        onChange={() => toggleStorageType(index)}
                        className="sr-only"
                      />
                      <div className={`w-9 h-5 rounded-full transition-colors flex items-center ${
                        media.storageType === 'on-chain' ? 'bg-black/30' : 'bg-gray-300 dark:bg-gray-600'
                      }`}>
                        <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ml-0.5 ${
                          media.storageType === 'on-chain' ? 'translate-x-4' : 'translate-x-0'
                        }`} />
                      </div>
                    </div>
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default MediaUpload