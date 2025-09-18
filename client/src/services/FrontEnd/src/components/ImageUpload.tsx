// src/components/ImageUpload.tsx
import React, { useState, useCallback, useRef } from 'react'
import {
  HiOutlinePhotograph,
  HiOutlineX,
  HiOutlineCloudUpload,
  HiOutlineCube,
  HiOutlineExclamationCircle,
  HiOutlineInformationCircle
} from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import {
  ImageFile,
  validateImageFile,
  createImageFile,
  calculateOnChainCost,
  optimizeForOnChain,
  SIZE_LIMITS
} from '~/utils/imageUtils'

export type StorageType = 'off-chain' | 'on-chain'

interface ImageUploadProps {
  onImageSelected: (image: ImageFile, storageType: StorageType) => void
  onImageRemoved: (index?: number) => void
  selectedImages?: ImageFile[]
  maxImages?: number
  className?: string
}

interface UploadState {
  isDragOver: boolean
  isProcessing: boolean
  selectedImage: ImageFile | null
  storageType: StorageType
  showStorageOptions: boolean
  onChainOptimized?: { file: File; base64: string } | null
  error?: string
  wasOptimized?: boolean
}

const ImageUpload: React.FC<ImageUploadProps> = ({
  onImageSelected,
  onImageRemoved,
  selectedImages = [],
  maxImages = 4,
  className = ''
}) => {
  const { isDark } = useTheme()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [state, setState] = useState<UploadState>({
    isDragOver: false,
    isProcessing: false,
    selectedImage: null,
    storageType: 'off-chain',
    showStorageOptions: false
  })

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setState(prev => ({ ...prev, isDragOver: true }))
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setState(prev => ({ ...prev, isDragOver: false }))
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setState(prev => ({ ...prev, isDragOver: false }))

    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      await processFile(files[0])
    }
  }, [])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      await processFile(files[0])
    }
  }, [])

  const processFile = async (file: File) => {
    setState(prev => ({ ...prev, isProcessing: true, error: undefined }))

    try {
      // Check file size and optimize if needed
      let processedFile = file
      let wasOptimized = false

      if (file.size > SIZE_LIMITS.OFF_CHAIN_MAX) {
        // Auto-optimize large images
        const optimized = await optimizeForOnChain(file)
        if (optimized.success && optimized.file) {
          processedFile = optimized.file
          wasOptimized = true
        } else {
          setState(prev => ({
            ...prev,
            error: 'Image too large. Please choose a smaller image.',
            isProcessing: false
          }))
          return
        }
      }

      // Validate file
      const validation = validateImageFile(processedFile)
      if (!validation.valid) {
        setState(prev => ({ ...prev, error: validation.error, isProcessing: false }))
        return
      }

      // Create image file
      const imageFile = await createImageFile(processedFile)

      // Check if it can fit on-chain and pre-optimize
      let onChainOptimized = null
      if (processedFile.size > SIZE_LIMITS.ON_CHAIN_MAX) {
        const optimized = await optimizeForOnChain(processedFile)
        if (optimized.success && optimized.file && optimized.base64) {
          onChainOptimized = { file: optimized.file, base64: optimized.base64 }
        }
      } else {
        onChainOptimized = { file: processedFile, base64: imageFile.base64! }
      }

      // Show notification if image was auto-optimized
      if (wasOptimized) {
        setState(prev => ({
          ...prev,
          error: undefined,
          isProcessing: false,
          selectedImage: imageFile,
          showStorageOptions: true,
          onChainOptimized,
          wasOptimized: true
        }))

        setTimeout(() => {
          setState(prev => ({ ...prev, wasOptimized: false }))
        }, 5000)
      } else {
        setState(prev => ({
          ...prev,
          isProcessing: false,
          selectedImage: imageFile,
          showStorageOptions: true,
          onChainOptimized
        }))
      }

    } catch (error) {
      setState(prev => ({
        ...prev,
        error: 'Failed to process image',
        isProcessing: false
      }))
    }
  }

  const handleStorageSelect = (storageType: StorageType) => {
    if (!state.selectedImage) return

    let finalImage = state.selectedImage

    // If on-chain selected and we have optimized version, use it
    if (storageType === 'on-chain' && state.onChainOptimized) {
      finalImage = {
        ...state.selectedImage,
        file: state.onChainOptimized.file,
        base64: state.onChainOptimized.base64,
        size: state.onChainOptimized.file.size
      }
    }

    setState(prev => ({
      ...prev,
      storageType,
      showStorageOptions: false
    }))

    onImageSelected(finalImage, storageType)
  }

  const handleRemove = () => {
    setState({
      isDragOver: false,
      isProcessing: false,
      selectedImage: null,
      storageType: 'off-chain',
      showStorageOptions: false,
      onChainOptimized: null
    })
    onImageRemoved()
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const canUseOnChain = state.selectedImage && (
    state.selectedImage.size <= SIZE_LIMITS.ON_CHAIN_MAX ||
    state.onChainOptimized
  )

  const onChainCost = canUseOnChain
    ? calculateOnChainCost(state.onChainOptimized?.file.size || state.selectedImage?.size || 0)
    : 0

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Upload Area */}
      {!state.selectedImage && selectedImages.length < maxImages && (
        <div
          className={`
            border-2 border-dashed rounded-lg p-[66px] text-center cursor-pointer transition-colors duration-200
            outline-none focus:outline-none ring-0 focus:ring-0 shadow-none focus:shadow-none hover:shadow-none
            drop-shadow-none filter-none
            ${state.isDragOver
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : 'border-gray-300 dark:border-gray-600 hover:border-blue-400 dark:hover:border-blue-500'
            }
            ${state.isProcessing ? 'opacity-50 pointer-events-none' : ''}
          `}
          style={{
            boxShadow: 'none !important',
            outline: 'none !important',
            borderStyle: 'dashed',
            WebkitBoxShadow: 'none !important',
            MozBoxShadow: 'none !important'
          }}
          tabIndex={-1}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />

          <HiOutlinePhotograph className={`mx-auto h-12 w-12 mb-4 ${
            isDark ? 'text-gray-400' : 'text-gray-500'
          }`} />

          <p className={`text-lg font-medium mb-2 ${
            isDark ? 'text-white' : 'text-gray-900'
          }`}>
            {state.isProcessing ? 'Processing image...' : 'Upload an image'}
          </p>

          <p className={`text-sm ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            Drag and drop or click to select
          </p>

          <p className={`text-xs mt-3 ${
            isDark ? 'text-gray-500' : 'text-gray-500'
          }`}>
            PNG, JPG, GIF, WebP up to 10MB
          </p>
        </div>
      )}

      {/* Error Display */}
      {state.error && (
        <div className="flex items-center p-3 bg-red-100 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <HiOutlineExclamationCircle className="h-5 w-5 text-red-500 mr-2 flex-shrink-0" />
          <span className="text-sm text-red-700 dark:text-red-400">{state.error}</span>
        </div>
      )}

      {/* Auto-optimization Notification */}
      {state.wasOptimized && (
        <div className="flex items-center p-3 bg-blue-100 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <HiOutlineInformationCircle className="h-5 w-5 text-blue-500 mr-2 flex-shrink-0" />
          <span className="text-sm text-blue-700 dark:text-blue-400">
            Image was automatically optimized to reduce file size
          </span>
        </div>
      )}

      {/* Storage Options */}
      {state.showStorageOptions && state.selectedImage && (
        <div className={`border rounded-lg p-6 ${
          isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
        }`}>
          <h3 className={`text-lg font-medium mb-4 ${
            isDark ? 'text-white' : 'text-gray-900'
          }`}>
            Choose storage option
          </h3>

          {/* Image Preview */}
          <div className="mb-6">
            <img
              src={state.selectedImage.preview}
              alt="Preview"
              className="max-w-xs max-h-48 rounded-lg mx-auto"
            />
            <div className={`text-center mt-2 text-sm ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              {state.selectedImage.width}×{state.selectedImage.height} • {Math.round(state.selectedImage.size / 1024)}KB
            </div>
          </div>

          {/* Storage Options */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Off-chain Storage */}
            <button
              onClick={() => handleStorageSelect('off-chain')}
              className={`p-4 rounded-lg border-2 text-left transition-all duration-200 ${
                isDark
                  ? 'border-gray-600 bg-gray-700 hover:border-blue-500 hover:bg-gray-600'
                  : 'border-gray-200 bg-white hover:border-blue-500 hover:bg-blue-50'
              }`}
            >
              <div className="flex items-center mb-2">
                <HiOutlineCloudUpload className="h-6 w-6 text-blue-500 mr-2" />
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Standard Storage
                </span>
              </div>
              <p className={`text-sm mb-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                Fast, reliable cloud storage
              </p>
              <div className="text-xs text-green-600 dark:text-green-400 font-medium">
                FREE
              </div>
            </button>

            {/* On-chain Storage */}
            <button
              onClick={() => canUseOnChain && handleStorageSelect('on-chain')}
              disabled={!canUseOnChain}
              className={`p-4 rounded-lg border-2 text-left transition-all duration-200 ${
                canUseOnChain
                  ? isDark
                    ? 'border-gray-600 bg-gray-700 hover:border-yellow-500 hover:bg-gray-600'
                    : 'border-gray-200 bg-white hover:border-yellow-500 hover:bg-yellow-50'
                  : 'opacity-50 cursor-not-allowed border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800'
              }`}
            >
              <div className="flex items-center mb-2">
                <HiOutlineCube className="h-6 w-6 text-yellow-500 mr-2" />
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Store on Blockchain
                </span>
              </div>
              <p className={`text-sm mb-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                Permanent, decentralized storage
              </p>
              {canUseOnChain ? (
                <div>
                  <div className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">
                    {onChainCost} CAW tokens
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    (incl. gas + validator fee)
                  </div>
                </div>
              ) : (
                <div className="text-xs text-red-500">
                  Image too large (max 50KB)
                </div>
              )}
            </button>
          </div>

          {/* Info about on-chain optimization */}
          {state.onChainOptimized && state.selectedImage.size > SIZE_LIMITS.ON_CHAIN_MAX && (
            <div className={`mt-4 p-3 rounded-lg border ${
              isDark ? 'border-blue-700 bg-blue-900/20' : 'border-blue-200 bg-blue-50'
            }`}>
              <div className="flex items-start">
                <HiOutlineInformationCircle className="h-5 w-5 text-blue-500 mt-0.5 mr-2 flex-shrink-0" />
                <div className="text-sm">
                  <p className="text-blue-700 dark:text-blue-300 font-medium mb-1">
                    Image optimized for on-chain storage
                  </p>
                  <p className="text-blue-600 dark:text-blue-400">
                    Original: {Math.round(state.selectedImage.size / 1024)}KB →
                    Compressed: {Math.round(state.onChainOptimized.file.size / 1024)}KB
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Selected Image Display */}
      {state.selectedImage && !state.showStorageOptions && (
        <div className={`border rounded-lg p-4 ${
          isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <img
                src={state.selectedImage.preview}
                alt="Selected"
                className="w-12 h-12 rounded-lg object-cover"
              />
              <div>
                <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {state.selectedImage.file.name}
                </p>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {Math.round(state.selectedImage.size / 1024)}KB • {state.storageType}
                </p>
              </div>
            </div>
            <button
              onClick={handleRemove}
              className={`p-2 rounded-lg transition-colors ${
                isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-200'
              }`}
              title="Remove image"
            >
              <HiOutlineX className="h-5 w-5 text-gray-500" />
            </button>
          </div>
        </div>
      )}

    </div>
  )
}

export default ImageUpload