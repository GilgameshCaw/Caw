import { Router } from 'express'
import { randomBytes } from 'crypto'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import multer from 'multer'
import { requireAuth } from '../middleware/auth'

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
    // Generate shorter filename - just 8 random hex chars + extension
    const uniqueId = randomBytes(4).toString('hex')
    const ext = path.extname(file.originalname)
    cb(null, `${uniqueId}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max (for videos)
  },
  fileFilter: (req, file, cb) => {
    // Check file mimetype to determine if it's an image or video
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

    // Generate URLs for uploaded files based on their actual type
    const apiHost = process.env.API_URL || `http://localhost:4000`

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
 * Legacy endpoint: Upload single base64 image
 * Kept for backward compatibility
 */
router.post('/image', async (req, res) => {
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

    // Generate unique filename
    const fileExtension = imageType.split('/')[1] || 'jpg'
    const fileName = `${tokenId}_${Date.now()}_${randomBytes(8).toString('hex')}.${fileExtension}`
    const filePath = path.join(IMAGE_DIR, fileName)

    // Save file
    await writeFile(filePath, buffer)

    // Return the URL pointing to the API server where images are served
    const apiHost = process.env.API_URL || `http://localhost:4000`
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
router.post('/images', async (req, res) => {
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
      const apiHost = process.env.API_URL || `http://localhost:4000`
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