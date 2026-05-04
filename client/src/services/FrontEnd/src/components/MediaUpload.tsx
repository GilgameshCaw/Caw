// src/components/MediaUpload.tsx
import React, { useState, useCallback, useRef } from 'react'
import {
  HiOutlinePhotograph,
  HiOutlineVideoCamera,
  HiOutlineX,
  HiOutlineExclamationCircle,
  HiOutlinePlay,
} from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

export type MediaType = 'image' | 'video' | 'gif'
export type StorageType = 'off-chain'

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
}

/** Single media cell with preview, remove button, and drag support */
const MediaCell: React.FC<{
  media: any
  index: number
  className?: string
  isDark: boolean
  draggable: boolean
  draggedIndex: number | null
  dragOverIndex: number | null
  onReorderDragStart: (e: React.DragEvent, i: number) => void
  onReorderDragEnd: (e: React.DragEvent) => void
  onReorderDragOver: (e: React.DragEvent, i: number) => void
  onReorderDragLeave: () => void
  onReorderDrop: (e: React.DragEvent, i: number) => void
  onRemove: (i: number) => void
  formatDuration: (s: number) => string
}> = ({ media, index, className = '', isDark, draggable, draggedIndex, dragOverIndex,
        onReorderDragStart, onReorderDragEnd, onReorderDragOver, onReorderDragLeave,
        onReorderDrop, onRemove, formatDuration }) => (
  <div
    draggable={draggable}
    onDragStart={(e) => onReorderDragStart(e, index)}
    onDragEnd={onReorderDragEnd}
    onDragOver={(e) => onReorderDragOver(e, index)}
    onDragLeave={onReorderDragLeave}
    onDrop={(e) => onReorderDrop(e, index)}
    className={`relative rounded-lg overflow-hidden transition-all ${
      dragOverIndex === index
        ? 'ring-2 ring-yellow-500 scale-[1.02]'
        : draggedIndex === index
          ? 'ring-2 ring-yellow-500/50 opacity-50'
          : isDark ? 'bg-gray-800' : 'bg-gray-50'
    } ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${className}`}
  >
    <div className="relative w-full h-full bg-black">
      {media.type === 'image' || media.type === 'gif' ? (
        <>
          <img
            src={media.preview || media.originalUrl || media.url}
            alt={`Selected ${index + 1}`}
            className="w-full h-full object-cover"
          />
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
          <video src={media.preview} className="w-full h-full object-contain" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-black/60 rounded-full p-2">
              <HiOutlinePlay className="w-4 h-4 text-white" />
            </div>
          </div>
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
    </div>
    <button
      onClick={() => onRemove(index)}
      className="absolute top-1 right-1 p-0.5 rounded-full bg-black/50 hover:bg-black/70 transition-colors"
      title="Remove"
    >
      <HiOutlineX className="h-3 w-3 text-white" />
    </button>
  </div>
)

/**
 * Responsive media grid layout:
 * 1 image: full width
 * 2 images: side by side (50/50)
 * 3 images: first image takes left half, other two stack on the right
 * 4 images: 2x2 grid
 */
const MediaGrid: React.FC<{
  selectedMedia: any[]
  isDark: boolean
  draggedIndex: number | null
  dragOverIndex: number | null
  onReorderDragStart: (e: React.DragEvent, i: number) => void
  onReorderDragEnd: (e: React.DragEvent) => void
  onReorderDragOver: (e: React.DragEvent, i: number) => void
  onReorderDragLeave: () => void
  onReorderDrop: (e: React.DragEvent, i: number) => void
  onRemove: (i: number) => void
  formatDuration: (s: number) => string
}> = (props) => {
  const { selectedMedia, ...cellProps } = props
  const count = selectedMedia.length
  const draggable = count > 1

  const cell = (index: number, className?: string) => (
    <MediaCell
      key={index}
      media={selectedMedia[index]}
      index={index}
      className={className}
      draggable={draggable}
      {...cellProps}
    />
  )

  if (count === 1) {
    return <div className="aspect-video rounded-lg overflow-hidden">{cell(0, 'w-full h-full')}</div>
  }

  if (count === 2) {
    return (
      <div className="grid grid-cols-2 gap-1.5 aspect-video rounded-lg overflow-hidden">
        {cell(0, 'w-full h-full')}
        {cell(1, 'w-full h-full')}
      </div>
    )
  }

  if (count === 3) {
    return (
      <div className="grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden">
        {cell(0, 'row-span-2 w-full h-full')}
        {cell(1, 'w-full h-full')}
        {cell(2, 'w-full h-full')}
      </div>
    )
  }

  if (count === 4) {
    return (
      <div className="grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden">
        {cell(0, 'w-full h-full')}
        {cell(1, 'w-full h-full')}
        {cell(2, 'w-full h-full')}
        {cell(3, 'w-full h-full')}
      </div>
    )
  }

  // 5 items (4 images + 1 video): 2x2 grid with bottom-right cell split vertically
  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden">
      {cell(0, 'w-full h-full')}
      {cell(1, 'w-full h-full')}
      {cell(2, 'w-full h-full')}
      <div className="grid grid-cols-2 gap-1.5 w-full h-full">
        {cell(3, 'w-full h-full')}
        {cell(4, 'w-full h-full')}
      </div>
    </div>
  )
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
  const t = useT()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
          setError(t('media_upload.error.invalid_type'))
          continue
        }

        // Check limits
        if (isImage && existingImages + newMedia.filter(m => m.type === 'image').length >= maxImages) {
          setError(t('media_upload.error.max_images', { count: maxImages }))
          continue
        }

        if (isVideo && existingVideos + newMedia.filter(m => m.type === 'video').length >= maxVideos) {
          setError(t('media_upload.error.max_videos', { count: maxVideos }))
          continue
        }

        // Reject large images
        if (isImage && file.size > SIZE_LIMITS.IMAGE_MAX) {
          setError(t('media_upload.error.image_too_large'))
          continue
        }

        if (isVideo && file.size > SIZE_LIMITS.VIDEO_MAX) {
          setError(t('media_upload.error.video_too_large'))
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
      setError(t('media_upload.error.process_failed'))
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
                  {isProcessing ? t('media_upload.processing') : t('media_upload.drop_here')}
                </p>

                <p className={`text-sm ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  {t('media_upload.or_click')}
                </p>

                <p className={`text-xs mt-3 ${
                  isDark ? 'text-gray-500' : 'text-gray-500'
                }`}>
                  {t('media_upload.limits', { maxImages, maxVideos })}
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
                  {t('media_upload.selected_count', { count: selectedMedia.length })}
                  {selectedMedia.length > 1 && (
                    <span className="ml-2 text-xs font-normal text-yellow-500">{t('media_upload.drag_reorder')}</span>
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
                      className={`relative rounded-lg overflow-hidden transition-all ${
                        dragOverIndex === index
                          ? 'ring-2 ring-yellow-500 scale-105'
                          : draggedIndex === index
                            ? 'ring-2 ring-yellow-500/50 opacity-50'
                            : isDark ? 'bg-gray-800' : 'bg-gray-50'
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

                      {/* File Info */}
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
          {t('media_upload.inline_count', {
            images: selectedMedia.filter(m => m.type === 'image' || m.type === 'gif').length,
            videos: selectedMedia.filter(m => m.type === 'video').length,
          })}
          {selectedMedia.length > 1 && (
            <span className="ml-2 text-yellow-600 dark:text-yellow-400">{t('media_upload.drag_reorder')}</span>
          )}
        </p>
      )}

      {/* Selected Media Display */}
      {selectedMedia.length > 0 && (
        <MediaGrid
          selectedMedia={selectedMedia}
          isDark={isDark}
          draggedIndex={draggedIndex}
          dragOverIndex={dragOverIndex}
          onReorderDragStart={handleReorderDragStart}
          onReorderDragEnd={handleReorderDragEnd}
          onReorderDragOver={handleReorderDragOver}
          onReorderDragLeave={handleReorderDragLeave}
          onReorderDrop={handleReorderDrop}
          onRemove={removeMedia}
          formatDuration={formatDuration}
        />
      )}
    </div>
  )
}

export default MediaUpload
