import { useRef, useEffect, useCallback } from 'react'

// SVG path from the single-bird CAW logo, scaled to fit a small boid
const BIRD_PATH = new Path2D(
  'M355.2,118.75l-117.46-9.88s-24.86,1.13-40.66,23.15l14.12,55.91c-26.07,3.29-46.32,2.92-67.39.24l14.31-56.15s-13-24-50.76-22.57c-5.73.21-107.36,9.59-107.36,9.59L57.08,39.04l44-4.17s17.51-2.82,31.62,2.26c8.28,2.92,16.05,7.15,23,12.52L177.62,0l21,49.56c4.05-1.93,7.94-4.2,11.62-6.78,15.58-10.45,42.21-8.28,42.21-8.28l44.75,3.66,58,80.59Z'
)
// The SVG viewBox is 355.2 x 190.29
const SVG_W = 355.2
const SVG_H = 190.29

function getBoidCount(): number {
  const area = window.innerWidth * window.innerHeight
  // ~1000 at 1920x1080, scale linearly with screen area, min 150
  return Math.max(150, Math.round(area / 2073))
}

const BOID_SCALE = 0.06
const MAX_SPEED = 0.7
const MIN_SPEED = 0.25
const EDGE_MARGIN = 60
const EDGE_TURN = 0.15

// Mutable config shared between canvas loop and sliders
const config = {
  separationRadius: 25,
  alignmentRadius: 50,
  cohesionRadius: 40,
  separationWeight: 0.045,
  alignmentWeight: 0.02,
  cohesionWeight: 0.002,
  wanderStrength: 0,
}

interface Boid {
  x: number
  y: number
  vx: number
  vy: number
  bright: 'none' | 'gold' | 'white'
  heading: number // smoothed rotation angle
  sepMult: number // multiplier for separation radius
  opacity: number // per-bird opacity variation
  gradFlip: boolean // gradient direction for bright birds
}



const OVERFLOW = 80
const MOUSE_RADIUS = 120
const MOUSE_FORCE = 0.8

export default function BoidsBg({ isDark }: { isDark: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boidsRef = useRef<Boid[]>([])
  const animRef = useRef<number>(0)
  const mouseRef = useRef<{ x: number, y: number, active: boolean }>({ x: 0, y: 0, active: false })

  const initBoids = useCallback((w: number, h: number) => {
    const count = getBoidCount()
    const boids: Boid[] = []
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED)
      boids.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        bright: Math.random() < 0.01 ? (Math.random() < 0.5 ? 'gold' : 'white') : 'none',
        heading: angle + Math.PI / 2,
        sepMult: 0.5 + Math.random(), // multiplier for separation radius
        opacity: 0.07 + Math.random() * 0.03,
        gradFlip: Math.random() < 0.5,
      })
    }
    boidsRef.current = boids
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')!
    let w = 0, h = 0

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      w = window.innerWidth + OVERFLOW * 2
      h = window.innerHeight + OVERFLOW * 2
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const targetCount = getBoidCount()
      if (boidsRef.current.length === 0 || Math.abs(boidsRef.current.length - targetCount) > targetCount * 0.3) {
        initBoids(w, h)
      }
    }

    resize()
    window.addEventListener('resize', resize)

    // Pre-render bird sprites onto offscreen canvases for performance
    const SPRITE_PAD = 10
    const spriteW = Math.ceil(SVG_W * BOID_SCALE) + SPRITE_PAD * 2
    const spriteH = Math.ceil(SVG_H * BOID_SCALE) + SPRITE_PAD * 2

    function renderSprite(fillFn: (sctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
      const c = document.createElement('canvas')
      c.width = spriteW
      c.height = spriteH
      const sctx = c.getContext('2d')!
      sctx.translate(SPRITE_PAD, SPRITE_PAD)
      sctx.scale(BOID_SCALE, BOID_SCALE)
      fillFn(sctx)
      sctx.fill(BIRD_PATH)
      return c
    }

    // Dim bird sprites (one per unique opacity — batch into a few buckets)
    const DIM_BUCKETS = 5
    const dimSpritesDark: HTMLCanvasElement[] = []
    const dimSpritesLight: HTMLCanvasElement[] = []
    for (let i = 0; i < DIM_BUCKETS; i++) {
      const opacity = 0.07 + (i / (DIM_BUCKETS - 1)) * 0.03
      dimSpritesDark.push(renderSprite(sctx => {
        const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
        const hi = `rgba(255,255,255,${(opacity * 1.3).toFixed(4)})`
        const lo = `rgba(255,255,255,${(opacity * 0.7).toFixed(4)})`
        grad.addColorStop(0, hi)
        grad.addColorStop(0.5, lo)
        grad.addColorStop(1, hi)
        sctx.fillStyle = grad
      }))
      dimSpritesLight.push(renderSprite(sctx => {
        const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
        const hi = `rgba(0,0,0,${(opacity * 1.3).toFixed(4)})`
        const lo = `rgba(0,0,0,${(opacity * 0.7).toFixed(4)})`
        grad.addColorStop(0, hi)
        grad.addColorStop(0.5, lo)
        grad.addColorStop(1, hi)
        sctx.fillStyle = grad
      }))
    }

    // Gold sprites (two variants for gradFlip)
    const goldSprites = [false, true].map(flip => renderSprite(sctx => {
      const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
      const edgeHi = 'rgba(255,230,120,0.75)'
      const centerHi = 'rgba(255,230,120,0.50)'
      const lo = 'rgba(200,160,40,0.45)'
      grad.addColorStop(0, flip ? lo : edgeHi)
      grad.addColorStop(0.5, flip ? centerHi : lo)
      grad.addColorStop(1, flip ? lo : edgeHi)
      sctx.fillStyle = grad
    }))

    // White sprites (two variants for gradFlip)
    const whiteSprites = [false, true].map(flip => renderSprite(sctx => {
      const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
      const whi = 'rgba(255,255,255,0.65)', wlo = 'rgba(200,200,210,0.35)'
      grad.addColorStop(0, flip ? wlo : whi)
      grad.addColorStop(0.5, flip ? whi : wlo)
      grad.addColorStop(1, flip ? wlo : whi)
      sctx.fillStyle = grad
    }))

    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX + OVERFLOW
      mouseRef.current.y = e.clientY + OVERFLOW
      mouseRef.current.active = true
    }
    const onMouseLeave = () => { mouseRef.current.active = false }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      mouseRef.current.x = e.touches[0].clientX + OVERFLOW
      mouseRef.current.y = e.touches[0].clientY + OVERFLOW
      mouseRef.current.active = true
    }
    const onTouchEnd = () => { mouseRef.current.active = false }

    window.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseleave', onMouseLeave)
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', onTouchEnd)

    // FPS counter (temporary)
    let frameCount = 0
    let lastFpsTime = performance.now()
    let currentFps = 0
    let simHalf = 0 // alternate which half of boids we simulate

    const tick = () => {
      // FPS tracking
      frameCount++
      const now = performance.now()
      if (now - lastFpsTime >= 1000) {
        currentFps = frameCount
        frameCount = 0
        lastFpsTime = now
      }

      const boids = boidsRef.current
      const { separationRadius, alignmentRadius, cohesionRadius, separationWeight, alignmentWeight, cohesionWeight, wanderStrength } = config
      ctx.clearRect(0, 0, w, h)

      // Spatial grid for O(n) neighbor lookups — flat array with counts to avoid allocations
      const cellSize = Math.max(separationRadius, alignmentRadius, cohesionRadius)
      const cols = Math.ceil(w / cellSize) + 1
      const rows = Math.ceil(h / cellSize) + 1
      const totalCells = cols * rows
      // Bucket sort: first pass counts, second pass fills
      const cellCounts = new Int32Array(totalCells)
      const cellStarts = new Int32Array(totalCells)
      const sortedIndices = new Int32Array(boids.length)

      for (let i = 0; i < boids.length; i++) {
        const b = boids[i]
        const col = Math.max(0, Math.min(cols - 1, (b.x / cellSize) | 0))
        const row = Math.max(0, Math.min(rows - 1, (b.y / cellSize) | 0))
        cellCounts[row * cols + col]++
      }
      // Prefix sum for start offsets
      let offset = 0
      for (let i = 0; i < totalCells; i++) {
        cellStarts[i] = offset
        offset += cellCounts[i]
        cellCounts[i] = 0 // reset for second pass
      }
      // Fill sorted indices
      for (let i = 0; i < boids.length; i++) {
        const b = boids[i]
        const col = Math.max(0, Math.min(cols - 1, (b.x / cellSize) | 0))
        const row = Math.max(0, Math.min(rows - 1, (b.y / cellSize) | 0))
        const cell = row * cols + col
        sortedIndices[cellStarts[cell] + cellCounts[cell]] = i
        cellCounts[cell]++
      }

      // Update boids — alternate halves each frame to stay under 16ms
      const simStart = simHalf * Math.ceil(boids.length / 2)
      const simEnd = Math.min(simStart + Math.ceil(boids.length / 2), boids.length)
      simHalf = 1 - simHalf

      for (let i = simStart; i < simEnd; i++) {
        const b = boids[i]
        let sepX = 0, sepY = 0
        let alignX = 0, alignY = 0, alignCount = 0
        let cohX = 0, cohY = 0, cohCount = 0

        const col = Math.max(0, Math.min(cols - 1, (b.x / cellSize) | 0))
        const row = Math.max(0, Math.min(rows - 1, (b.y / cellSize) | 0))

        // Check neighboring cells
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = row + dr, nc = col + dc
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
            const cellIdx = nr * cols + nc
            const start = cellStarts[cellIdx]
            const count = cellCounts[cellIdx]
            for (let k = 0; k < count; k++) {
              const j = sortedIndices[start + k]
              if (j === i) continue
              const o = boids[j]
              const dx = o.x - b.x
              const dy = o.y - b.y
              const distSq = dx * dx + dy * dy

              const bSepR = separationRadius * b.sepMult
              if (distSq < bSepR * bSepR && distSq > 0) {
                const dist = Math.sqrt(distSq)
                sepX -= dx / dist
                sepY -= dy / dist
              }
              if (distSq < alignmentRadius * alignmentRadius) {
                alignX += o.vx
                alignY += o.vy
                alignCount++
              }
              if (distSq < cohesionRadius * cohesionRadius) {
                cohX += o.x
                cohY += o.y
                cohCount++
              }
            }
          }
        }

        // Gold birds are less influenced by the flock
        const influence = b.bright === 'white' ? 0 : b.bright === 'gold' ? 0.05 : 0.5

        b.vx += sepX * separationWeight * influence
        b.vy += sepY * separationWeight * influence

        if (alignCount > 0) {
          b.vx += (alignX / alignCount - b.vx) * alignmentWeight * influence
          b.vy += (alignY / alignCount - b.vy) * alignmentWeight * influence
        }

        if (cohCount > 0) {
          b.vx += (cohX / cohCount - b.x) * cohesionWeight * influence
          b.vy += (cohY / cohCount - b.y) * cohesionWeight * influence
        }

        // Random wander to prevent clumping
        b.vx += (Math.random() - 0.5) * wanderStrength
        b.vy += (Math.random() - 0.5) * wanderStrength

        // Mouse repulsion
        if (mouseRef.current.active) {
          const mdx = b.x - mouseRef.current.x
          const mdy = b.y - mouseRef.current.y
          const mDistSq = mdx * mdx + mdy * mdy
          if (mDistSq < MOUSE_RADIUS * MOUSE_RADIUS && mDistSq > 0) {
            const mDist = Math.sqrt(mDistSq)
            const force = MOUSE_FORCE * (1 - mDist / MOUSE_RADIUS)
            b.vx += (mdx / mDist) * force
            b.vy += (mdy / mDist) * force
          }
        }

        // Soft edge avoidance
        if (b.x < EDGE_MARGIN) b.vx += EDGE_TURN
        if (b.x > w - EDGE_MARGIN) b.vx -= EDGE_TURN
        if (b.y < EDGE_MARGIN) b.vy += EDGE_TURN
        if (b.y > h - EDGE_MARGIN) b.vy -= EDGE_TURN

        // Clamp speed (white birds fly 20% faster)
        const speedMult = b.bright === 'white' ? 1.2 : 1
        const maxSpd = MAX_SPEED * speedMult
        const minSpd = MIN_SPEED * speedMult
        const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
        if (speed > maxSpd) {
          b.vx = (b.vx / speed) * maxSpd
          b.vy = (b.vy / speed) * maxSpd
        } else if (speed < minSpd) {
          b.vx = (b.vx / speed) * minSpd
          b.vy = (b.vy / speed) * minSpd
        }

        b.x += b.vx
        b.y += b.vy
      }

      // Draw boids using pre-rendered sprites
      for (const b of boids) {
        // Smoothly lerp heading toward velocity direction
        const targetAngle = Math.atan2(b.vy, b.vx) + Math.PI / 2
        let delta = targetAngle - b.heading
        while (delta > Math.PI) delta -= Math.PI * 2
        while (delta < -Math.PI) delta += Math.PI * 2
        b.heading += delta * 0.03

        let sprite: HTMLCanvasElement
        if (b.bright === 'gold') {
          sprite = goldSprites[b.gradFlip ? 1 : 0]
        } else if (b.bright === 'white') {
          sprite = whiteSprites[b.gradFlip ? 1 : 0]
        } else {
          const bucket = Math.min(DIM_BUCKETS - 1, Math.max(0, Math.round((b.opacity - 0.04) / 0.02 * (DIM_BUCKETS - 1))))
          sprite = isDark ? dimSpritesDark[bucket] : dimSpritesLight[bucket]
        }

        ctx.save()
        ctx.translate(b.x, b.y)
        ctx.rotate(b.heading)
        ctx.drawImage(sprite, -spriteW / 2, -spriteH / 2)
        ctx.restore()
      }

      // FPS display (temporary)
      ctx.fillStyle = 'rgba(255,255,0,0.8)'
      ctx.font = '14px monospace'
      ctx.fillText(`${currentFps} fps / ${boids.length} boids`, OVERFLOW + 10, OVERFLOW + 20)

      animRef.current = requestAnimationFrame(tick)
    }

    animRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onMouseLeave)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [isDark, initBoids])

  return (
    <canvas
      ref={canvasRef}
      className="fixed pointer-events-none"
      style={{ zIndex: 0, top: -80, left: -80, right: -80, bottom: -80 }}
    />
  )
}
