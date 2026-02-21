import { Router } from 'express'

const router = Router()

const GIPHY_API_KEY = process.env.GIPHY_API_KEY

/**
 * GET /api/giphy/search
 * Search for GIFs using Giphy API
 */
router.get('/search', async (req, res) => {
  try {
    if (!GIPHY_API_KEY) {
      return res.status(500).json({ error: 'Giphy API key not configured' })
    }

    const { q, limit = 20, offset = 0 } = req.query

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Query parameter "q" is required' })
    }

    const url = new URL('https://api.giphy.com/v1/gifs/search')
    url.searchParams.set('api_key', GIPHY_API_KEY)
    url.searchParams.set('q', q)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('rating', 'pg-13')
    url.searchParams.set('lang', 'en')

    const response = await fetch(url.toString())

    if (!response.ok) {
      console.error('Giphy API error:', response.status, response.statusText)
      return res.status(response.status).json({ error: 'Failed to fetch from Giphy' })
    }

    const data = await response.json()

    // Transform the response to only include what we need
    const gifs = data.data.map((gif: any) => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.original.url,
      preview: gif.images.fixed_height_small.url,
      width: parseInt(gif.images.original.width),
      height: parseInt(gif.images.original.height),
      previewWidth: parseInt(gif.images.fixed_height_small.width),
      previewHeight: parseInt(gif.images.fixed_height_small.height),
    }))

    return res.json({
      gifs,
      pagination: data.pagination,
    })
  } catch (error: any) {
    console.error('GET /api/giphy/search error:', error)
    return res.status(500).json({ error: 'Failed to search GIFs' })
  }
})

/**
 * GET /api/giphy/trending
 * Get trending GIFs
 */
router.get('/trending', async (req, res) => {
  try {
    if (!GIPHY_API_KEY) {
      return res.status(500).json({ error: 'Giphy API key not configured' })
    }

    const { limit = 20, offset = 0 } = req.query

    const url = new URL('https://api.giphy.com/v1/gifs/trending')
    url.searchParams.set('api_key', GIPHY_API_KEY)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('rating', 'pg-13')

    const response = await fetch(url.toString())

    if (!response.ok) {
      console.error('Giphy API error:', response.status, response.statusText)
      return res.status(response.status).json({ error: 'Failed to fetch from Giphy' })
    }

    const data = await response.json()

    const gifs = data.data.map((gif: any) => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.original.url,
      preview: gif.images.fixed_height_small.url,
      width: parseInt(gif.images.original.width),
      height: parseInt(gif.images.original.height),
      previewWidth: parseInt(gif.images.fixed_height_small.width),
      previewHeight: parseInt(gif.images.fixed_height_small.height),
    }))

    return res.json({
      gifs,
      pagination: data.pagination,
    })
  } catch (error: any) {
    console.error('GET /api/giphy/trending error:', error)
    return res.status(500).json({ error: 'Failed to get trending GIFs' })
  }
})

export default router
