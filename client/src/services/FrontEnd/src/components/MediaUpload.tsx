// src/components/MediaUpload.tsx
import React, { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  HiOutlinePhotograph,
  HiOutlineVideoCamera,
  HiOutlineX,
  HiOutlineCloudUpload,
  HiOutlineCube,
  HiOutlineExclamationCircle,
  HiOutlinePlay,
  HiX
} from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { calculateOnChainCost } from '~/utils/imageUtils'
import { formatEngagementCount } from '~/utils/numberFormat'

export type MediaType = 'image' | 'video' | 'gif'
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
  isProcessingOnChain?: boolean
}

const SIZE_LIMITS = {
  IMAGE_MAX: 10 * 1024 * 1024, // 10MB for images
  VIDEO_MAX: 100 * 1024 * 1024, // 100MB for videos
  ON_CHAIN_MAX: 90 * 1024 // 90KB for on-chain storage (images only)
}

const MediaUpload: React.FC<MediaUploadProps> = ({
  onMediaSelected,
  onMediaRemoved,
  selectedMedia = [],
  maxImages = 4,
  maxVideos = 1,
  className = '',
  isProcessingOnChain = false,
  isOverlay = false,
  onClose
}) => {
  const { isDark } = useTheme()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCompressModal, setShowCompressModal] = useState(false)
  const [compressModalIndex, setCompressModalIndex] = useState<number | null>(null)
  const [compressPreviews, setCompressPreviews] = useState<Array<{ url: string; size: number; file: File; label: string }>>([])
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false)
  const [selectedPreviewIndex, setSelectedPreviewIndex] = useState<number | null>(null)

  // Drag-and-drop reordering state
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const currentImages = selectedMedia.filter(m => m.type === 'image' || m.type === 'gif').length
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

  // Drag-and-drop reordering handlers
  const handleReorderDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    // Add a slight delay to allow the drag image to be captured
    setTimeout(() => {
      const target = e.target as HTMLElement
      target.style.opacity = '0.5'
    }, 0)
  }

  const handleReorderDragEnd = (e: React.DragEvent) => {
    const target = e.target as HTMLElement
    target.style.opacity = '1'
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const handleReorderDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index)
    }
  }

  const handleReorderDragLeave = () => {
    setDragOverIndex(null)
  }

  const handleReorderDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDraggedIndex(null)
      setDragOverIndex(null)
      return
    }

    // Reorder the media array
    const newMedia = [...selectedMedia]
    const [draggedItem] = newMedia.splice(draggedIndex, 1)
    newMedia.splice(dropIndex, 0, draggedItem)
    onMediaSelected(newMedia)

    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const toggleStorageType = (index: number) => {
    const media = selectedMedia[index]
    if (media.type !== 'image') return // Only images can be on-chain

    const newStorageType = media.storageType === 'on-chain' ? 'off-chain' : 'on-chain'

    // If toggling OFF and there's an original file stored, restore it
    if (newStorageType === 'off-chain' && (media as any).originalFile) {
      const updatedMedia = [...selectedMedia]
      updatedMedia[index] = {
        ...media,
        file: (media as any).originalFile,
        size: (media as any).originalSize,
        preview: (media as any).originalPreview,
        storageType: 'off-chain',
        // Clear the stored originals since we're back to original
        originalFile: undefined,
        originalPreview: undefined,
        originalSize: undefined
      }
      onMediaSelected(updatedMedia)
      return
    }

    // Check size limit for on-chain storage (use original size if available)
    const sizeToCheck = (media as any).originalSize || media.size
    if (newStorageType === 'on-chain' && sizeToCheck > SIZE_LIMITS.ON_CHAIN_MAX) {
      // Show compression modal instead of browser confirm
      setCompressModalIndex(index)
      setShowCompressModal(true)
      return
    }

    const updatedMedia = [...selectedMedia]
    updatedMedia[index] = {
      ...media,
      storageType: newStorageType
    }
    onMediaSelected(updatedMedia)
  }

  const handleCompressConfirm = async () => {
    if (compressModalIndex !== null && selectedPreviewIndex !== null && compressPreviews[selectedPreviewIndex]) {
      const selectedPreview = compressPreviews[selectedPreviewIndex]
      const media = selectedMedia[compressModalIndex]

      const updatedMedia = [...selectedMedia]
      updatedMedia[compressModalIndex] = {
        ...media,
        file: selectedPreview.file,
        size: selectedPreview.size,
        preview: selectedPreview.url,
        storageType: 'on-chain',
        // Store original file/preview so user can reset by toggling off on-chain
        originalFile: (media as any).originalFile || media.file,
        originalPreview: (media as any).originalPreview || media.preview,
        originalSize: (media as any).originalSize || media.size
      }
      onMediaSelected(updatedMedia)
    }
    setShowCompressModal(false)
    setCompressModalIndex(null)
    setCompressPreviews([])
    setSelectedPreviewIndex(null)
  }

  const handleCompressCancel = () => {
    // Clean up preview URLs
    compressPreviews.forEach(p => URL.revokeObjectURL(p.url))
    setShowCompressModal(false)
    setCompressModalIndex(null)
    setCompressPreviews([])
    setSelectedPreviewIndex(null)
  }

  const handleGeneratePreview = async () => {
    if (compressModalIndex === null) return
    const media = selectedMedia[compressModalIndex]
    if (!media?.file) return

    setIsGeneratingPreview(true)
    try {
      const targets = [
        { size: 30 * 1024, label: 'Small (30KB)' },
        { size: 60 * 1024, label: 'Medium (60KB)' },
        { size: 90 * 1024, label: 'Large (90KB)' }
      ]

      const previews = await Promise.all(
        targets.map(async (target) => {
          const compressed = await compressImageToSize(media.file, target.size)
          if (compressed) {
            return {
              url: URL.createObjectURL(compressed),
              size: compressed.size,
              file: compressed,
              label: target.label
            }
          }
          return null
        })
      )

      const validPreviews = previews.filter((p): p is NonNullable<typeof p> => p !== null)
      setCompressPreviews(validPreviews)

      // Auto-select the first one that's under 90KB
      const defaultIndex = validPreviews.findIndex(p => p.size <= 90 * 1024)
      setSelectedPreviewIndex(defaultIndex >= 0 ? defaultIndex : 0)
    } catch (err) {
      console.error('Preview generation failed:', err)
      setError('Could not generate previews')
    } finally {
      setIsGeneratingPreview(false)
    }
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
    return compressImageToSize(file, 50 * 1024) // Default to 50KB target
  }

  // Compress image to target a specific size (in bytes)
  const compressImageToSize = async (file: File, targetSize: number): Promise<File | null> => {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = async () => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        // Start with original dimensions
        let width = img.width
        let height = img.height

        // Calculate initial scale based on target size
        // Rough estimate: smaller target = more scaling needed
        const originalArea = width * height
        const bytesPerPixel = file.size / originalArea
        const targetArea = targetSize / bytesPerPixel / 0.5 // 0.5 accounts for JPEG compression
        const initialScale = Math.min(1, Math.sqrt(targetArea / originalArea))

        // Also cap max dimension
        const maxDimension = targetSize <= 30 * 1024 ? 800 : targetSize <= 60 * 1024 ? 1200 : 1600
        const dimScale = Math.min(width, height) > maxDimension
          ? maxDimension / Math.max(width, height)
          : 1

        const scale = Math.min(initialScale, dimScale, 1)
        width = Math.round(width * scale)
        height = Math.round(height * scale)

        canvas.width = width
        canvas.height = height
        ctx?.drawImage(img, 0, 0, width, height)

        // Try different quality levels to hit target size
        const tryQuality = async (quality: number): Promise<Blob | null> => {
          return new Promise((res) => {
            canvas.toBlob((blob) => res(blob), 'image/jpeg', quality)
          })
        }

        // Binary search for the right quality
        let minQ = 0.1
        let maxQ = 0.95
        let bestBlob: Blob | null = null

        for (let i = 0; i < 8; i++) {
          const midQ = (minQ + maxQ) / 2
          const blob = await tryQuality(midQ)
          if (blob) {
            if (blob.size <= targetSize) {
              bestBlob = blob
              minQ = midQ // Try higher quality
            } else {
              maxQ = midQ // Need lower quality
            }
          }
        }

        // If we couldn't get under target, use lowest quality result
        if (!bestBlob) {
          bestBlob = await tryQuality(0.1)
        }

        if (bestBlob) {
          const compressedFile = new File([bestBlob], file.name, {
            type: 'image/jpeg',
            lastModified: Date.now()
          })
          resolve(compressedFile)
        } else {
          resolve(null)
        }
      }

      img.onerror = () => resolve(null)
      img.src = URL.createObjectURL(file)
    })
  }

  const handleCompressImage = async (index: number, setOnChainAfter: boolean = false) => {
    const media = selectedMedia[index]
    if (media.type !== 'image') return

    setIsProcessing(true)
    const compressed = await compressImage(media.file)

    if (compressed) {
      const updatedMedia = [...selectedMedia]
      const canSetOnChain = setOnChainAfter && compressed.size <= SIZE_LIMITS.ON_CHAIN_MAX
      updatedMedia[index] = {
        ...media,
        file: compressed,
        size: compressed.size,
        preview: URL.createObjectURL(compressed),
        ...(canSetOnChain ? { storageType: 'on-chain' } : {})
      }
      onMediaSelected(updatedMedia)
      if (canSetOnChain) {
        setError(`Compressed to ${formatFileSize(compressed.size)} and set to on-chain`)
      } else if (setOnChainAfter) {
        setError(`Compressed to ${formatFileSize(compressed.size)} - still too large for on-chain (max 50KB)`)
      } else {
        setError(`Image compressed from ${formatFileSize(media.size)} to ${formatFileSize(compressed.size)}`)
      }
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
                  {selectedMedia.length > 1 && (
                    <span className="ml-2 text-xs font-normal text-yellow-500">• Drag to reorder</span>
                  )}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  {selectedMedia.map((media, index) => (
                    <div
                      key={index}
                      draggable={selectedMedia.length > 1}
                      onDragStart={(e) => handleReorderDragStart(e, index)}
                      onDragEnd={handleReorderDragEnd}
                      onDragOver={(e) => handleReorderDragOver(e, index)}
                      onDragLeave={handleReorderDragLeave}
                      onDrop={(e) => handleReorderDrop(e, index)}
                      className={`relative rounded-lg overflow-hidden border-2 transition-all ${
                        dragOverIndex === index
                          ? 'border-yellow-500 scale-105'
                          : draggedIndex === index
                            ? 'border-yellow-500/50 opacity-50'
                            : isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
                      } ${selectedMedia.length > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
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
                          {/* VIDEO label */}
                          <span className={`absolute bottom-2 left-2 px-1.5 py-0.5 text-xs font-semibold rounded ${
                            isDark ? 'bg-black/70 text-white' : 'bg-white/70 text-black'
                          }`}>
                            VIDEO
                          </span>
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
          {selectedMedia.filter(m => m.type === 'image' || m.type === 'gif').length}/4 images •
          {selectedMedia.filter(m => m.type === 'video').length}/1 video
          {selectedMedia.length > 1 && (
            <span className="ml-2 text-yellow-600 dark:text-yellow-400">• Drag to reorder</span>
          )}
        </p>
      )}

      {/* Selected Media Display */}
      {selectedMedia.length > 0 && (
        <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
          {selectedMedia.map((media, index) => (
            <div
              key={index}
              draggable={selectedMedia.length > 1}
              onDragStart={(e) => handleReorderDragStart(e, index)}
              onDragEnd={handleReorderDragEnd}
              onDragOver={(e) => handleReorderDragOver(e, index)}
              onDragLeave={handleReorderDragLeave}
              onDrop={(e) => handleReorderDrop(e, index)}
              className={`relative rounded-lg overflow-hidden border-2 transition-all ${
                dragOverIndex === index
                  ? 'border-yellow-500 scale-105'
                  : draggedIndex === index
                    ? 'border-yellow-500/50 opacity-50'
                    : isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
              } ${selectedMedia.length > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
            >
              {/* Media Preview - 1:1 aspect ratio */}
              <div className="relative aspect-square bg-black">
                {media.type === 'image' || media.type === 'gif' ? (
                  <>
                    <img
                      src={(media as any).preview || (media as any).originalUrl || (media as any).url}
                      alt={`Selected ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                    {/* GIPHY label for GIFs */}
                    {media.type === 'gif' && (
                      <span className={`absolute bottom-1 left-1 px-1 py-0.5 text-xs font-semibold rounded ${
                        isDark ? 'bg-black/70 text-white' : 'bg-white/70 text-black'
                      }`}>
                        GIPHY
                      </span>
                    )}
                  </>
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
                    {/* VIDEO label */}
                    <span className={`absolute bottom-1 left-1 px-1 py-0.5 text-xs font-semibold rounded ${
                      isDark ? 'bg-black/70 text-white' : 'bg-white/70 text-black'
                    }`}>
                      VIDEO
                    </span>
                    {media.duration && (
                      <span className="absolute bottom-1 right-1 text-xs text-white bg-black/60 px-1 py-0.5 rounded">
                        {formatDuration(media.duration)}
                      </span>
                    )}
                  </>
                )}

                {/* Processing overlay for on-chain images during initial upload */}
                {isProcessingOnChain && media.type === 'image' && media.storageType === 'on-chain' && !(media as any).uploadStatus && (
                  <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center z-50">
                    <div className="animate-spin rounded-full h-8 w-8 border-2 border-yellow-500 border-t-transparent mb-2"></div>
                    <span className="text-white text-xs font-medium">Signing...</span>
                  </div>
                )}

                {/* Pending indicator - tx submitted but not confirmed */}
                {media.type === 'image' && (media as any).uploadStatus === 'pending' && (
                  <div className="absolute top-1 left-1 bg-yellow-500 rounded-full p-1 z-10">
                    <svg className="w-3.5 h-3.5 text-white animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                )}

                {/* Success checkmark - tx confirmed */}
                {media.type === 'image' && (media as any).uploadStatus === 'success' && (
                  <div className="absolute top-1 left-1 bg-green-500 rounded-full p-1 z-10">
                    <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}

                {/* Failed indicator - tx failed */}
                {media.type === 'image' && (media as any).uploadStatus === 'failed' && (
                  <div className="absolute top-1 left-1 bg-red-500 rounded-full p-1 z-10">
                    <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
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

              {/* Storage toggle for images only (not GIFs or videos) - full width banner at bottom */}
              {media.type === 'image' && (
                <div className={`absolute bottom-0 left-0 right-0 ${
                  (media as any).uploadStatus === 'success'
                    ? 'bg-green-500/95'
                    : (media as any).uploadStatus === 'pending'
                      ? 'bg-yellow-500/95'
                      : (media as any).uploadStatus === 'failed'
                        ? 'bg-red-500/95'
                        : media.storageType === 'on-chain'
                          ? 'bg-yellow-500/95'
                          : isDark ? 'bg-gray-900/95' : 'bg-white/95'
                } backdrop-blur-sm p-2 transition-colors`}>
                  {(media as any).uploadStatus === 'success' ? (
                    // Successfully uploaded or from library
                    <div className="flex flex-col">
                      <span className="text-xs font-medium text-white">
                        {(media as any).isFromLibrary ? 'From Library' : 'Uploaded'}
                      </span>
                      <span className="text-xs text-white/80">
                        On-Chain
                      </span>
                    </div>
                  ) : (media as any).uploadStatus === 'pending' ? (
                    // Pending - tx submitted but not confirmed
                    <div className="flex flex-col">
                      <span className="text-xs font-medium text-black">
                        Pending...
                      </span>
                      <span className="text-xs text-black/70">
                        Confirming tx
                      </span>
                    </div>
                  ) : (media as any).uploadStatus === 'failed' ? (
                    // Failed upload
                    <div className="flex flex-col">
                      <span className="text-xs font-medium text-white">
                        Failed
                      </span>
                      <span className="text-xs text-white/80">
                        Tap to retry
                      </span>
                    </div>
                  ) : (
                    // Not uploaded yet - show toggle
                    <div className="flex flex-col gap-1">
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className={`text-xs font-medium ${
                          media.storageType === 'on-chain'
                            ? 'text-black'
                            : isDark ? 'text-gray-300' : 'text-gray-700'
                        }`}>
                          On-chain
                        </span>
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
                      {media.storageType === 'on-chain' && (
                        <span className="text-xs text-black/80">
                          {formatEngagementCount(
                            (media as any).processedCost || calculateOnChainCost(media.size)
                          )} CAW
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Compression Confirmation Modal */}
      {showCompressModal && compressModalIndex !== null && createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 z-[80]"
            onClick={handleCompressCancel}
          />

          {/* Modal */}
          <div className="fixed z-[90] top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-2xl rounded-xl shadow-2xl border bg-black border-yellow-500/30">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-yellow-500/20">
                  <HiOutlineCube className="w-5 h-5 text-yellow-500" />
                </div>
                <h3 className="text-lg font-semibold text-white">
                  Image Too Large
                </h3>
              </div>
              <button
                onClick={handleCompressCancel}
                className="p-1 rounded-full transition-colors text-white/60 hover:text-white hover:bg-white/10"
              >
                <HiX className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="px-4 pb-4">
              <p className="text-sm mb-2 text-white/70">
                This image is <span className="font-semibold text-white">{Math.round(selectedMedia[compressModalIndex]?.size / 1024)}KB</span>. Choose a compression level for on-chain storage:
              </p>

              <p className="text-sm mb-4 text-yellow-500/80">
                <span className="font-medium">On-chain images live forever</span> — stored permanently on the blockchain, not on any server.
              </p>

              {/* Preview options grid */}
              {compressPreviews.length > 0 ? (
                <div className="mb-4">
                  <div className="grid grid-cols-3 gap-2 sm:gap-3">
                    {compressPreviews.map((preview, index) => (
                      <button
                        key={index}
                        onClick={() => setSelectedPreviewIndex(index)}
                        className={`relative rounded-lg overflow-hidden border-2 transition-all ${
                          selectedPreviewIndex === index
                            ? 'border-yellow-500 ring-2 ring-yellow-500/30'
                            : 'border-white/20 hover:border-white/40'
                        }`}
                      >
                        <div className="aspect-square bg-black/50">
                          <img
                            src={preview.url}
                            alt={preview.label}
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className={`absolute bottom-0 left-0 right-0 px-1 sm:px-2 py-1 sm:py-1.5 ${
                          selectedPreviewIndex === index ? 'bg-yellow-500' : 'bg-black/80'
                        }`}>
                          <p className={`text-[10px] sm:text-xs font-medium truncate ${
                            selectedPreviewIndex === index ? 'text-black' : 'text-white'
                          }`}>
                            {preview.label}
                          </p>
                          <p className={`text-[10px] sm:text-xs ${
                            selectedPreviewIndex === index ? 'text-black/70' : 'text-white/60'
                          }`}>
                            {Math.round(preview.size / 1024)}KB · {formatEngagementCount(calculateOnChainCost(preview.size))} CAW
                          </p>
                        </div>
                        {selectedPreviewIndex === index && (
                          <div className="absolute top-1 right-1 sm:top-2 sm:right-2 w-4 h-4 sm:w-5 sm:h-5 bg-yellow-500 rounded-full flex items-center justify-center">
                            <svg className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>

                  {/* Selected preview larger view */}
                  {selectedPreviewIndex !== null && compressPreviews[selectedPreviewIndex] && (
                    <div className="mt-4">
                      <p className="text-xs text-white/50 mb-2">Selected preview:</p>
                      <div className="rounded-lg overflow-hidden border border-white/20 bg-black/50">
                        <img
                          src={compressPreviews[selectedPreviewIndex].url}
                          alt="Selected preview"
                          className="max-w-full max-h-64 mx-auto"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm mb-4 text-white/50">
                  Generate previews to see how your image will look at different compression levels.
                </p>
              )}

              {/* Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={handleCompressCancel}
                  className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium border border-white/20 text-white hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                {compressPreviews.length > 0 ? (
                  <button
                    onClick={handleCompressConfirm}
                    disabled={selectedPreviewIndex === null}
                    className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors disabled:opacity-50"
                  >
                    Use Selected
                  </button>
                ) : (
                  <button
                    onClick={handleGeneratePreview}
                    disabled={isGeneratingPreview}
                    className="flex-1 py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors disabled:opacity-50"
                  >
                    {isGeneratingPreview ? 'Generating...' : 'Show Options'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

export default MediaUpload