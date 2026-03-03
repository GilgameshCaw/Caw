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
  ON_CHAIN_MAX: 50 * 1024, // 50KB for on-chain storage
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
 * Calculate on-chain storage cost in CAW tokens
 * Based on Base chain gas costs for data storage
 */
export function calculateOnChainCost(sizeInBytes: number): number {
  // Base chain storage costs (2025 data):
  // - Each non-zero calldata byte costs 16 gas (post EIP-2028)
  // - Base64 encoded images are mostly non-zero bytes
  // - Base chain has both L2 execution cost and L1 data posting cost
  // - L1 data fee is the primary cost component (~10 gwei per byte on Base)
  // - Validator needs compensation for gas + operational costs

  const MIN_CAW_COST = 500 // Minimum 500 CAW for any on-chain storage

  // Gas calculation for L1 data posting (primary cost on Base L2)
  const l1GasPerByte = 16 // Gas per non-zero byte for L1 calldata
  const l1DataGas = sizeInBytes * l1GasPerByte

  // L2 execution gas (smaller component but still relevant)
  const l2ExecutionGas = sizeInBytes * 3 // Approximate L2 processing per byte

  // Total gas consumption
  const totalGas = l1DataGas + l2ExecutionGas

  // Cost conversion
  // Base chain typical gas price: 0.036 gwei for L2, ~10 gwei weighted for L1 data
  // Using weighted average since L1 data dominates the cost
  const effectiveGasPrice = 8 // Weighted average in gwei

  // CAW token economics (assumed rates - should be fetched live in production)
  // If 1 ETH = 30,000,000 CAW
  // Then 1 gwei = 0.03 CAW
  const cawPerGwei = 0.03

  // Calculate base cost
  const baseCost = Math.ceil(totalGas * effectiveGasPrice * cawPerGwei)

  // Add 150% markup for validator compensation
  // This covers: gas volatility (can spike 2-3x), operational costs, and profit margin
  // Better to overestimate than have transactions fail - unused CAW is not charged
  const totalCost = Math.ceil(baseCost * 2.5)

  // For small images, ensure minimum viable compensation
  // For a 10KB image: ~2400 CAW
  // For a 50KB image: ~12000 CAW
  return Math.max(MIN_CAW_COST, totalCost)
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

/**
 * Auto-compress image to fit on-chain storage limit
 */
export async function optimizeForOnChain(file: File): Promise<{ success: boolean; file?: File; base64?: string; error?: string }> {
  if (file.size <= SIZE_LIMITS.ON_CHAIN_MAX) {
    const base64 = await fileToBase64(file)
    return { success: true, file, base64 }
  }

  const options = getOptimalCompression(file.size, SIZE_LIMITS.ON_CHAIN_MAX)

  try {
    const compressed = await compressImage(file, options)

    if (compressed.file.size <= SIZE_LIMITS.ON_CHAIN_MAX) {
      return { success: true, file: compressed.file, base64: compressed.base64 }
    } else {
      return {
        success: false,
        error: `Image too large for on-chain storage. Even after compression, size is ${Math.round(compressed.file.size / 1024)}KB (limit: ${SIZE_LIMITS.ON_CHAIN_MAX / 1024}KB)`
      }
    }
  } catch (error) {
    return { success: false, error: 'Failed to compress image' }
  }
}