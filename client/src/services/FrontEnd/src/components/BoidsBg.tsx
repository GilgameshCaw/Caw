import { useRef, useEffect, useCallback } from 'react'

// SVG path from the single-bird CAW logo, scaled to fit a small boid
const BIRD_PATH = new Path2D(
  'M355.2,118.75l-117.46-9.88s-24.86,1.13-40.66,23.15l14.12,55.91c-26.07,3.29-46.32,2.92-67.39.24l14.31-56.15s-13-24-50.76-22.57c-5.73.21-107.36,9.59-107.36,9.59L57.08,39.04l44-4.17s17.51-2.82,31.62,2.26c8.28,2.92,16.05,7.15,23,12.52L177.62,0l21,49.56c4.05-1.93,7.94-4.2,11.62-6.78,15.58-10.45,42.21-8.28,42.21-8.28l44.75,3.66,58,80.59Z'
)
// The SVG viewBox is 355.2 x 190.29
const SVG_W = 355.2
const SVG_H = 190.29
const SVG_CX = SVG_W / 2
const SVG_CY = SVG_H / 2

const BOID_COUNT = 1000
const BOID_SCALE = 0.06
const MAX_SPEED = 0.35
const MIN_SPEED = 0.1
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



export default function BoidsBg({ isDark }: { isDark: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boidsRef = useRef<Boid[]>([])
  const animRef = useRef<number>(0)

  const initBoids = useCallback((w: number, h: number) => {
    const boids: Boid[] = []
    for (let i = 0; i < BOID_COUNT; i++) {
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
        opacity: 0.04 + Math.random() * 0.02, // 4%–6%, centered on 5%
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

    const OVERFLOW = 80
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      w = canvas.parentElement!.clientWidth + OVERFLOW * 2
      h = canvas.parentElement!.clientHeight + OVERFLOW * 2
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      if (boidsRef.current.length === 0) {
        initBoids(w, h)
      }
    }

    resize()
    window.addEventListener('resize', resize)

    const tick = () => {
      const boids = boidsRef.current
      const { separationRadius, alignmentRadius, cohesionRadius, separationWeight, alignmentWeight, cohesionWeight, wanderStrength } = config
      ctx.clearRect(0, 0, w, h)

      // Spatial grid for O(n) neighbor lookups
      const cellSize = Math.max(separationRadius, alignmentRadius, cohesionRadius)
      const cols = Math.ceil(w / cellSize) + 1
      const rows = Math.ceil(h / cellSize) + 1
      const grid: number[][] = new Array(cols * rows)
      for (let i = 0; i < grid.length; i++) grid[i] = []

      for (let i = 0; i < boids.length; i++) {
        const b = boids[i]
        const col = Math.max(0, Math.min(cols - 1, Math.floor(b.x / cellSize)))
        const row = Math.max(0, Math.min(rows - 1, Math.floor(b.y / cellSize)))
        grid[row * cols + col].push(i)
      }

      // Update boids
      for (let i = 0; i < boids.length; i++) {
        const b = boids[i]
        let sepX = 0, sepY = 0
        let alignX = 0, alignY = 0, alignCount = 0
        let cohX = 0, cohY = 0, cohCount = 0

        const col = Math.max(0, Math.min(cols - 1, Math.floor(b.x / cellSize)))
        const row = Math.max(0, Math.min(rows - 1, Math.floor(b.y / cellSize)))

        // Check neighboring cells
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = row + dr, nc = col + dc
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
            const cell = grid[nr * cols + nc]
            for (let k = 0; k < cell.length; k++) {
              const j = cell[k]
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

      // Draw boids
      for (const b of boids) {
        // Smoothly lerp heading toward velocity direction
        const targetAngle = Math.atan2(b.vy, b.vx) + Math.PI / 2
        let delta = targetAngle - b.heading
        while (delta > Math.PI) delta -= Math.PI * 2
        while (delta < -Math.PI) delta += Math.PI * 2
        b.heading += delta * 0.03

        ctx.save()
        ctx.translate(b.x, b.y)
        ctx.rotate(b.heading)
        ctx.scale(BOID_SCALE, BOID_SCALE)
        ctx.translate(-SVG_CX, -SVG_CY)

        if (b.bright === 'gold') {
          // Symmetric linear gold gradient — edges match, bright center
          const grad = ctx.createLinearGradient(0, 0, SVG_W, SVG_H)
          const edgeHi = 'rgba(255,230,120,0.75)'
          const centerHi = 'rgba(255,230,120,0.50)'
          const lo = 'rgba(200,160,40,0.45)'
          grad.addColorStop(0, b.gradFlip ? lo : edgeHi)
          grad.addColorStop(0.5, b.gradFlip ? centerHi : lo)
          grad.addColorStop(1, b.gradFlip ? lo : edgeHi)
          ctx.fillStyle = grad
        } else if (b.bright === 'white') {
          // Symmetric linear silver gradient — bright edges, dimmer center
          const grad = ctx.createLinearGradient(0, 0, SVG_W, SVG_H)
          const whi = 'rgba(255,255,255,0.65)', wlo = 'rgba(200,200,210,0.35)'
          grad.addColorStop(0, b.gradFlip ? wlo : whi)
          grad.addColorStop(0.5, b.gradFlip ? whi : wlo)
          grad.addColorStop(1, b.gradFlip ? wlo : whi)
          ctx.fillStyle = grad
        } else {
          const c = isDark ? '255,255,255' : '0,0,0'
          ctx.fillStyle = `rgba(${c},${b.opacity})`
        }

        ctx.fill(BIRD_PATH)
        ctx.restore()
      }

      animRef.current = requestAnimationFrame(tick)
    }

    animRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [isDark, initBoids])

  return (
    <canvas
      ref={canvasRef}
      className="absolute pointer-events-none"
      style={{ zIndex: 0, top: -80, left: -80, right: -80, bottom: -80 }}
    />
  )
}
