import { Router } from 'express'
import { randomBytes } from 'crypto'
import multer from 'multer'
import { requireAuth } from '../middleware/auth'
import { mediaStorage } from '../util/mediaStorage'

const router = Router()

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv', 'video/ogg': '.ogv',
}

function generateFilename(mimetype: string): string {
  const uniqueId = randomBytes(4).toString('hex')
  const ext = MIME_TO_EXT[mimetype] || '.bin'
  return `${uniqueId}${ext}`
}

// Images come in pre-compressed from the FE (compressImage.ts targets ~1MB
// for the 'feed' preset, ~750KB for 'dm'). 2MB is a 2x backstop for edge
// cases — anything bigger than that is a degenerate input the FE failed
// to shrink.
const IMAGE_MAX_BYTES = 2 * 1024 * 1024
// Videos are passed through unchanged. 25MB ≈ 30s-2min of 1080p H.264;
// long-form video isn't a fit for this product so we cap rather than
// transcode in-browser.
const VIDEO_MAX_BYTES = 25 * 1024 * 1024

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const imageMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    const videoMimes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/ogg']
    if (imageMimes.includes(file.mimetype) || videoMimes.includes(file.mimetype)) cb(null, true)
    else cb(new Error(`Invalid file format: ${file.mimetype}`))
  }
})

router.post('/', upload.array('media', 10), requireAuth({ field: 'tokenId', verifyOwnership: true }), async (req: any, res: any) => {
  try {
    const { tokenId } = req.body
    const files = req.files as Express.Multer.File[]

    if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' })
    if (!tokenId) return res.status(400).json({ error: 'Missing tokenId' })

    // Multer's fileSize limit is set to VIDEO_MAX_BYTES (the larger of the
    // two), so it doesn't reject oversized images on its own. Enforce the
    // tighter image cap here, and re-check the video cap explicitly so the
    // route's contract is "videos ≤25MB, images ≤2MB" regardless of how
    // multer is configured upstream.
    const oversizedImage = files.find(f => f.mimetype.startsWith('image/') && f.size > IMAGE_MAX_BYTES)
    if (oversizedImage) {
      return res.status(413).json({
        error: `Image too large (${(oversizedImage.size / 1024 / 1024).toFixed(1)}MB, max ${IMAGE_MAX_BYTES / 1024 / 1024}MB)`,
      })
    }
    const oversizedVideo = files.find(f => f.mimetype.startsWith('video/') && f.size > VIDEO_MAX_BYTES)
    if (oversizedVideo) {
      return res.status(413).json({
        error: `Video too large (${(oversizedVideo.size / 1024 / 1024).toFixed(1)}MB, max ${VIDEO_MAX_BYTES / 1024 / 1024}MB)`,
      })
    }

    const storage = mediaStorage()
    const urls = await Promise.all(files.map(async file => {
      const isVideo = file.mimetype.startsWith('video/')
      const kind = isVideo ? 'videos' : 'images'
      const filename = generateFilename(file.mimetype)
      return storage.put(kind, filename, file.buffer, file.mimetype)
    }))

    res.json({ success: true, urls, count: files.length })
  } catch (error) {
    console.error('Media upload error:', error)
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to upload media' })
  }
})

const variantUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const imageMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (imageMimes.includes(file.mimetype)) cb(null, true)
    else cb(new Error(`Invalid variant format: ${file.mimetype}`))
  },
})

router.post('/variant', variantUpload.single('media'), requireAuth({ field: 'tokenId', verifyOwnership: true }), async (req: any, res: any) => {
  try {
    const { baseFilename, width } = req.body
    const file = req.file as Express.Multer.File | undefined

    if (!file) return res.status(400).json({ error: 'No file uploaded' })
    if (!baseFilename || typeof baseFilename !== 'string') return res.status(400).json({ error: 'Missing baseFilename' })
    if (!/^\d+$/.test(width)) return res.status(400).json({ error: 'Invalid width' })
    if (!/^[a-z0-9]+\.(webp|jpg|jpeg|png|gif)$/i.test(baseFilename)) return res.status(400).json({ error: 'Invalid baseFilename' })

    const storage = mediaStorage()
    if (!(await storage.baseExists('images', baseFilename))) {
      return res.status(404).json({ error: 'Base image not found' })
    }

    const dot = baseFilename.lastIndexOf('.')
    const stem = baseFilename.slice(0, dot)
    const ext = baseFilename.slice(dot)
    const variantName = `${stem}_${width}${ext}`

    const url = await storage.putVariant(baseFilename, variantName, file.buffer, file.mimetype)
    res.json({ success: true, url })
  } catch (error) {
    console.error('Variant upload error:', error)
    res.status(500).json({ error: 'Failed to upload variant' })
  }
})

const ENC_RATE_LIMIT_MAX = 50
const ENC_RATE_LIMIT_BYTES = 100 * 1024 * 1024
const ENC_RATE_LIMIT_WINDOW = 24 * 60 * 60 * 1000
const encRateLimitMap = new Map<number, { timestamps: number[]; bytes: number[] }>()

function checkEncRateLimit(tokenId: number, fileSize: number): { allowed: boolean; reason?: string } {
  const now = Date.now()
  const entry = encRateLimitMap.get(tokenId) || { timestamps: [], bytes: [] }
  const cutoff = now - ENC_RATE_LIMIT_WINDOW
  const validIndices = entry.timestamps.reduce<number[]>((acc, t, i) => {
    if (t > cutoff) acc.push(i)
    return acc
  }, [])
  entry.timestamps = validIndices.map(i => entry.timestamps[i])
  entry.bytes = validIndices.map(i => entry.bytes[i])

  if (entry.timestamps.length >= ENC_RATE_LIMIT_MAX) {
    return { allowed: false, reason: `Upload limit reached (${ENC_RATE_LIMIT_MAX} files per day)` }
  }
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
}, verifyOwnership: true }), async (req: any, res: any) => {
  try {
    const tokenId = Number(req.query.tokenId)
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const data = Buffer.concat(chunks)

    if (data.length === 0) return res.status(400).json({ error: 'No data received' })
    if (data.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 5MB)' })

    const rateCheck = checkEncRateLimit(tokenId, data.length)
    if (!rateCheck.allowed) return res.status(429).json({ error: rateCheck.reason })

    const filename = `${randomBytes(8).toString('hex')}.enc`
    const url = await mediaStorage().put('encrypted', filename, data, 'application/octet-stream')

    recordEncUpload(tokenId, data.length)
    res.json({ success: true, url })
  } catch (error) {
    console.error('Encrypted upload error:', error)
    res.status(500).json({ error: 'Failed to upload encrypted file' })
  }
})

router.post('/image', requireAuth({ field: 'tokenId', verifyOwnership: true }), async (req: any, res: any) => {
  try {
    const { image, tokenId } = req.body
    if (!image || !tokenId) return res.status(400).json({ error: 'Missing image or tokenId' })

    const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
    if (!matches || matches.length !== 3) return res.status(400).json({ error: 'Invalid image format' })

    const imageType = matches[1]
    const buffer = Buffer.from(matches[2], 'base64')
    if (buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 10MB)' })

    const SAFE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }
    const fileExtension = SAFE_EXT[imageType] || 'jpg'
    const fileName = `${tokenId}_${Date.now()}_${randomBytes(8).toString('hex')}.${fileExtension}`
    const url = await mediaStorage().put('images', fileName, buffer, imageType)

    res.json({ success: true, url, filename: fileName })
  } catch (error) {
    console.error('Image upload error:', error)
    res.status(500).json({ error: 'Failed to upload image' })
  }
})

router.post('/images', requireAuth({ field: 'tokenId', verifyOwnership: true }), async (req: any, res: any) => {
  try {
    const { images, tokenId } = req.body
    if (!images || !Array.isArray(images) || !tokenId) return res.status(400).json({ error: 'Missing images array or tokenId' })

    const storage = mediaStorage()
    const uploadedUrls: string[] = []
    for (const image of images) {
      const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
      if (!matches || matches.length !== 3) continue
      const imageType = matches[1]
      const buffer = Buffer.from(matches[2], 'base64')
      if (buffer.length > 10 * 1024 * 1024) continue
      const fileExtension = imageType.split('/')[1] || 'jpg'
      const fileName = `${tokenId}_${Date.now()}_${randomBytes(8).toString('hex')}.${fileExtension}`
      uploadedUrls.push(await storage.put('images', fileName, buffer, imageType))
    }

    res.json({ success: true, urls: uploadedUrls })
  } catch (error) {
    console.error('Images upload error:', error)
    res.status(500).json({ error: 'Failed to upload images' })
  }
})

export default router
