import { Router } from 'express'
import { randomBytes } from 'crypto'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import multer from 'multer'
import { requireAuth } from '../middleware/auth'
import { publicUrl } from '../util/publicUrl'

const router = Router()

// Ensure upload directories exist
const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads')
const IMAGE_DIR = path.join(UPLOAD_DIR, 'images')
const VIDEO_DIR = path.join(UPLOAD_DIR, 'videos')

// Create directories
Promise.all([
  mkdir(IMAGE_DIR, { recursive: true }),
  mkdir(VIDEO_DIR, { recursive: true })
]).catch(console.error)

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // Determine type based on file mimetype
    const isVideo = file.mimetype.startsWith('video/')
    const dir = isVideo ? VIDEO_DIR : IMAGE_DIR
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    // Generate shorter filename - just 8 random hex chars + safe extension
    const uniqueId = randomBytes(4).toString('hex')
    // Derive extension from validated MIME type, not user-supplied filename
    const MIME_TO_EXT: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
      'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
      'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv', 'video/ogg': '.ogv',
    }
    const ext = MIME_TO_EXT[file.mimetype] || '.bin'
    cb(null, `${uniqueId}${ext}`)
  }
})

// Per-file caps. Multer's fileSize limit is global, so we set it to the
// LARGER ceiling (videos) and then enforce the tighter image cap inside
// the route handler. Images come in pre-compressed from the client
// (compressImage.ts ~1MB target), so 5MB leaves plenty of headroom for
// edge cases. Videos are pass-through up to 25MB.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const VIDEO_MAX_BYTES = 25 * 1024 * 1024

const upload = multer({
  storage,
  limits: {
    fileSize: VIDEO_MAX_BYTES,
  },
  fileFilter: (req, file, cb) => {
    const imageMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    const videoMimes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/ogg']

    if (imageMimes.includes(file.mimetype)) {
      cb(null, true)
    } else if (videoMimes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`Invalid file format: ${file.mimetype}`))
    }
  }
})

/**
 * Upload media files (images or videos)
 * Accepts multipart/form-data with files
 */
router.post('/', upload.array('media', 10), requireAuth({ field: 'tokenId' }), async (req, res) => {
  try {
    const { tokenId } = req.body
    const files = req.files as Express.Multer.File[]

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' })
    }

    if (!tokenId) {
      return res.status(400).json({ error: 'Missing tokenId' })
    }

    // Per-file cap: images must be ≤5MB (clients compress before upload).
    // Videos already capped by multer's global 25MB limit.
    const oversized = files.find(f => f.mimetype.startsWith('image/') && f.size > IMAGE_MAX_BYTES)
    if (oversized) {
      return res.status(413).json({
        error: `Image too large (${(oversized.size / 1024 / 1024).toFixed(1)}MB, max ${IMAGE_MAX_BYTES / 1024 / 1024}MB)`,
      })
    }

    // Generate URLs for uploaded files based on their actual type
    const apiHost = publicUrl()

    const urls = files.map(file => {
      const isVideo = file.mimetype.startsWith('video/')
      const subDir = isVideo ? 'videos' : 'images'
      return `${apiHost}/uploads/${subDir}/${file.filename}`
    })

    res.json({
      success: true,
      urls,
      count: files.length
    })
  } catch (error) {
    console.error('Media upload error:', error)
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload media'
    })
  }
})

/**
 * Upload encrypted DM attachment.
 * Accepts raw encrypted binary (application/octet-stream).
 * Stores as .enc file, returns URL for retrieval.
 */
const ENC_DIR = path.join(UPLOAD_DIR, 'encrypted')
mkdir(ENC_DIR, { recursive: true }).catch(console.error)

// Rate limiting for encrypted uploads: max uploads per user per day, max bytes per user per day
const ENC_RATE_LIMIT_MAX = 50                      // 50 files per day
const ENC_RATE_LIMIT_BYTES = 100 * 1024 * 1024     // 100MB per day
const ENC_RATE_LIMIT_WINDOW = 24 * 60 * 60 * 1000  // 24 hours
const encRateLimitMap = new Map<number, { timestamps: number[]; bytes: number[] }>()

function checkEncRateLimit(tokenId: number, fileSize: number): { allowed: boolean; reason?: string } {
  const now = Date.now()
  const entry = encRateLimitMap.get(tokenId) || { timestamps: [], bytes: [] }

  // Clean old entries
  const cutoff = now - ENC_RATE_LIMIT_WINDOW
  const validIndices = entry.timestamps.reduce<number[]>((acc, t, i) => {
    if (t > cutoff) acc.push(i)
    return acc
  }, [])
  entry.timestamps = validIndices.map(i => entry.timestamps[i])
  entry.bytes = validIndices.map(i => entry.bytes[i])

  // Check file count
  if (entry.timestamps.length >= ENC_RATE_LIMIT_MAX) {
    return { allowed: false, reason: `Upload limit reached (${ENC_RATE_LIMIT_MAX} files per day)` }
  }

  // Check total bytes
  const totalBytes = entry.bytes.reduce((sum, b) => sum + b, 0)
  if (totalBytes + fileSize > ENC_RATE_LIMIT_BYTES) {
    return { allowed: false, reason: `Daily upload size limit reached (${ENC_RATE_LIMIT_BYTES / 1024 / 1024}MB per day)` }
  }

  return { allowed: true }
}

function recordEncUpload(tokenId: number, fileSize: number) {
  const entry = encRateLimitMap.get(tokenId) || { timestamps: [], bytes: [] }
  entry.timestamps.push(Date.now())
  entry.bytes.push(fileSize)
  encRateLimitMap.set(tokenId, entry)
}

router.post('/encrypted', requireAuth({ lookup: async (req) => {
  const tokenId = req.query.tokenId
  return tokenId ? Number(tokenId) : undefined
}}), async (req: any, res: any) => {
  try {
    const tokenId = Number(req.query.tokenId)
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const data = Buffer.concat(chunks)

    if (data.length === 0) {
      return res.status(400).json({ error: 'No data received' })
    }

    // 5MB limit per encrypted blob. Cleartext is compressed client-side
    // via the 'dm' preset (~750KB target), so encrypted should be well
    // under this cap with room for AES-GCM overhead and the occasional GIF.
    if (data.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 5MB)' })
    }

    // Rate limit
    const rateCheck = checkEncRateLimit(tokenId, data.length)
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: rateCheck.reason })
    }

    const uniqueId = randomBytes(8).toString('hex')
    const filename = `${uniqueId}.enc`
    await writeFile(path.join(ENC_DIR, filename), data)

    recordEncUpload(tokenId, data.length)

    const apiHost = publicUrl()
    const url = `${apiHost}/uploads/encrypted/${filename}`

    res.json({ success: true, url })
  } catch (error) {
    console.error('Encrypted upload error:', error)
    res.status(500).json({ error: 'Failed to upload encrypted file' })
  }
})

/**
 * Legacy endpoint: Upload single base64 image
 * Kept for backward compatibility
 */
router.post('/image', requireAuth({ field: 'tokenId' }), async (req, res) => {
  try {
    const { image, tokenId } = req.body

    if (!image || !tokenId) {
      return res.status(400).json({ error: 'Missing image or tokenId' })
    }

    // Extract base64 data
    const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: 'Invalid image format' })
    }

    const imageType = matches[1]
    const imageData = matches[2]
    const buffer = Buffer.from(imageData, 'base64')

    // Validate image size (max 10MB for off-chain)
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 10MB)' })
    }

    // Generate unique filename with safe extension from allowlist
    const SAFE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }
    const fileExtension = SAFE_EXT[imageType] || 'jpg'
    const fileName = `${tokenId}_${Date.now()}_${randomBytes(8).toString('hex')}.${fileExtension}`
    const filePath = path.join(IMAGE_DIR, fileName)

    // Save file
    await writeFile(filePath, buffer)

    // Return the URL pointing to the API server where images are served
    const apiHost = publicUrl()
    const imageUrl = `${apiHost}/uploads/images/${fileName}`

    res.json({
      success: true,
      url: imageUrl,
      filename: fileName
    })
  } catch (error) {
    console.error('Image upload error:', error)
    res.status(500).json({ error: 'Failed to upload image' })
  }
})

/**
 * Legacy endpoint: Upload multiple base64 images
 * Kept for backward compatibility
 */
router.post('/images', requireAuth({ field: 'tokenId' }), async (req, res) => {
  try {
    const { images, tokenId } = req.body

    if (!images || !Array.isArray(images) || !tokenId) {
      return res.status(400).json({ error: 'Missing images array or tokenId' })
    }

    const uploadedUrls: string[] = []

    for (const image of images) {
      // Extract base64 data
      const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
      if (!matches || matches.length !== 3) {
        continue // Skip invalid images
      }

      const imageType = matches[1]
      const imageData = matches[2]
      const buffer = Buffer.from(imageData, 'base64')

      // Validate image size (max 10MB for off-chain)
      if (buffer.length > 10 * 1024 * 1024) {
        continue // Skip oversized images
      }

      // Generate unique filename
      const fileExtension = imageType.split('/')[1] || 'jpg'
      const fileName = `${tokenId}_${Date.now()}_${randomBytes(8).toString('hex')}.${fileExtension}`
      const filePath = path.join(IMAGE_DIR, fileName)

      // Save file
      await writeFile(filePath, buffer)

      // Add URL to array - pointing to API server
      const apiHost = publicUrl()
      const imageUrl = `${apiHost}/uploads/images/${fileName}`
      uploadedUrls.push(imageUrl)
    }

    res.json({
      success: true,
      urls: uploadedUrls
    })
  } catch (error) {
    console.error('Images upload error:', error)
    res.status(500).json({ error: 'Failed to upload images' })
  }
})

export default router