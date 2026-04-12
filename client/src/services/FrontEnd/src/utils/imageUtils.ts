// src/utils/imageUtils.ts
export interface ImageFile {
  file: File
  preview: string
  base64?: string
  size: number
  width?: number
  height?: number
}

export interface ImageUploadOptions {
  maxSize: number
  maxWidth?: number
  maxHeight?: number
  quality: number
  format: 'jpeg' | 'png' | 'webp'
}

// Supported image formats
export const SUPPORTED_FORMATS = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']

// Size limits
export const SIZE_LIMITS = {
  OFF_CHAIN_MAX: 10 * 1024 * 1024, // 10MB for off-chain storage
}

/**
 * Validate image file
 */
export function validateImageFile(file: File): { valid: boolean; error?: string } {
  if (!SUPPORTED_FORMATS.includes(file.type)) {
    return {
      valid: false,
      error: `Unsupported format. Please use: ${SUPPORTED_FORMATS.map(f => f.split('/')[1]).join(', ')}`
    }
  }

  if (file.size > SIZE_LIMITS.OFF_CHAIN_MAX) {
    return {
      valid: false,
      error: `File too large. Maximum size is ${SIZE_LIMITS.OFF_CHAIN_MAX / (1024 * 1024)}MB`
    }
  }

  return { valid: true }
}

/**
 * Get image dimensions
 */
export function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.width, height: img.height })
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }

    img.src = url
  })
}

/**
 * Compress image to specified options
 */
export function compressImage(file: File, options: ImageUploadOptions): Promise<{ file: File; base64: string }> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new Image()
    const url = URL.createObjectURL(file)

    if (!ctx) {
      reject(new Error('Canvas not supported'))
      return
    }

    img.onload = () => {
      URL.revokeObjectURL(url)

      // Calculate new dimensions
      let { width, height } = img
      if (options.maxWidth && width > options.maxWidth) {
        height = (height * options.maxWidth) / width
        width = options.maxWidth
      }
      if (options.maxHeight && height > options.maxHeight) {
        width = (width * options.maxHeight) / height
        height = options.maxHeight
      }

      // Set canvas dimensions
      canvas.width = width
      canvas.height = height

      // Draw and compress
      ctx.drawImage(img, 0, 0, width, height)

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Failed to compress image'))
            return
          }

          const compressedFile = new File([blob], file.name, {
            type: `image/${options.format}`,
            lastModified: Date.now()
          })

          // Convert to base64
          const reader = new FileReader()
          reader.onload = () => {
            const base64 = reader.result as string
            resolve({ file: compressedFile, base64 })
          }
          reader.onerror = () => reject(new Error('Failed to convert to base64'))
          reader.readAsDataURL(blob)
        },
        `image/${options.format}`,
        options.quality
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }

    img.src = url
  })
}

/**
 * Convert file to base64
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * Create image preview
 */
export async function createImageFile(file: File): Promise<ImageFile> {
  const preview = URL.createObjectURL(file)
  const dimensions = await getImageDimensions(file)
  const base64 = await fileToBase64(file)

  return {
    file,
    preview,
    base64,
    size: file.size,
    width: dimensions.width,
    height: dimensions.height
  }
}

/**
 * Get optimal compression settings for target size
 */
export function getOptimalCompression(currentSize: number, targetSize: number): ImageUploadOptions {
  const ratio = targetSize / currentSize

  if (ratio >= 0.8) {
    return { maxSize: targetSize, quality: 0.9, format: 'jpeg' }
  } else if (ratio >= 0.5) {
    return { maxSize: targetSize, quality: 0.7, format: 'jpeg', maxWidth: 1200 }
  } else if (ratio >= 0.3) {
    return { maxSize: targetSize, quality: 0.5, format: 'jpeg', maxWidth: 800 }
  } else {
    return { maxSize: targetSize, quality: 0.3, format: 'jpeg', maxWidth: 600 }
  }
}

