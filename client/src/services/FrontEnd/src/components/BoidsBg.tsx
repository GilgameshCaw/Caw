import { useRef, useEffect, useCallback } from 'react'

// SVG path from the single-bird CAW logo, scaled to fit a small boid
const BIRD_PATH = new Path2D(
  'M355.2,118.75l-117.46-9.88s-24.86,1.13-40.66,23.15l14.12,55.91c-26.07,3.29-46.32,2.92-67.39.24l14.31-56.15s-13-24-50.76-22.57c-5.73.21-107.36,9.59-107.36,9.59L57.08,39.04l44-4.17s17.51-2.82,31.62,2.26c8.28,2.92,16.05,7.15,23,12.52L177.62,0l21,49.56c4.05-1.93,7.94-4.2,11.62-6.78,15.58-10.45,42.21-8.28,42.21-8.28l44.75,3.66,58,80.59Z'
)
// The SVG viewBox is 355.2 x 190.29
const SVG_W = 355.2
const SVG_H = 190.29

// Wing-flap poses: vertical scale factors applied around the bird's vertical center.
// 0 = wings up, 1 = mid (natural spread), 2 = wings down.
// We apply a non-uniform Y scale around SVG_H/2 to simulate the flap arc.
const FLAP_POSES = [0.55, 1.0, 1.35] // scaleY per pose (3 frames: up, mid, down)
const FLAP_POSES_COUNT = FLAP_POSES.length

// Base flap rate in cycles per second, scales with bird speed
const FLAP_BASE_HZ = 8   // flaps/sec at MIN_SPEED
const FLAP_MAX_HZ  = 13  // flaps/sec at MAX_SPEED

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
  heading: number  // smoothed rotation angle
  sepMult: number  // multiplier for separation radius
  opacity: number  // per-bird opacity variation
  gradFlip: boolean // gradient direction for bright birds
  flapPhase: number // 0..1, position within flap cycle (random init so birds aren't in sync)
  fright: number    // 0..1 panic scalar: spikes near cursor, decays ~1s, boosts flap+speed
}



const OVERFLOW = 80
const MOUSE_RADIUS = 120
const MOUSE_FORCE = 0.8

// Fright constants — panic response when cursor enters FRIGHT_RADIUS
const FRIGHT_RADIUS      = 200   // px, larger detection zone than old MOUSE_RADIUS
const FRIGHT_FORCE       = 2.8   // peak panic burst (quadratic, strongest at center)
const FRIGHT_SPEED_BOOST = 1.8   // max speed multiplier while frightened
const FRIGHT_FLAP_BOOST  = 3.0   // flap rate multiplier while frightened
const FRIGHT_DECAY       = 0.028 // per-frame decay of fright scalar (~1.1s to 0 at 60fps)

// Hero bird constants
const HERO_COUNT   = 4
const HERO_SCALE   = 2.5   // relative to BOID_SCALE
const HERO_FLAP_HZ = 14    // they flap fast during the swoop
const HERO_SPEED   = 0.0015 // t-units per ms (crosses screen in ~650ms)
const HERO_WAIT_MIN = 3000  // ms before respawn
const HERO_WAIT_MAX = 9000

// Cubic Bézier helpers
// Point on curve at t
function bezierPt(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}
// Tangent (derivative) on curve at t — used for heading
function bezierTan(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t
  return 3 * (u * u * (p1 - p0) + 2 * u * t * (p2 - p1) + t * t * (p3 - p2))
}

interface HeroBird {
  // Bézier control points (in canvas coords, including OVERFLOW)
  x0: number; y0: number
  x1: number; y1: number
  x2: number; y2: number
  x3: number; y3: number
  t: number         // 0..1 progress along path
  flapPhase: number
  gradFlip: boolean
  waiting: number   // ms remaining before this hero activates (0 = active)
}

// Generate a fresh random swooping path for a hero bird.
// Entry/exit edges are randomised; control points create a convincing arc.
function makeHeroPath(w: number, h: number): HeroBird {
  // Pick two different edges (0=top,1=right,2=bottom,3=left)
  const edgeA = Math.floor(Math.random() * 4)
  let edgeB = Math.floor(Math.random() * 3)
  if (edgeB >= edgeA) edgeB++

  function edgePt(edge: number): [number, number] {
    const pad = 60
    switch (edge) {
      case 0: return [pad + Math.random() * (w - 2 * pad), -40]   // top
      case 1: return [w + 40, pad + Math.random() * (h - 2 * pad)] // right
      case 2: return [pad + Math.random() * (w - 2 * pad), h + 40] // bottom
      default: return [-40, pad + Math.random() * (h - 2 * pad)]   // left
    }
  }

  const [x0, y0] = edgePt(edgeA)
  const [x3, y3] = edgePt(edgeB)

  // Control points: offset inward from each endpoint toward the screen center,
  // then perturb for variety so arcs differ each swoop
  const cx = w / 2, cy = h / 2
  const spread = 0.35 + Math.random() * 0.3
  const x1 = x0 + (cx - x0) * spread + (Math.random() - 0.5) * w * 0.4
  const y1 = y0 + (cy - y0) * spread + (Math.random() - 0.5) * h * 0.4
  const x2 = x3 + (cx - x3) * spread + (Math.random() - 0.5) * w * 0.4
  const y2 = y3 + (cy - y3) * spread + (Math.random() - 0.5) * h * 0.4

  return { x0, y0, x1, y1, x2, y2, x3, y3, t: 0, flapPhase: Math.random(), gradFlip: Math.random() < 0.5, waiting: 0 }
}

export default function BoidsBg({ isDark, heroBirds = true }: { isDark: boolean; heroBirds?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boidsRef = useRef<Boid[]>([])
  const heroRef = useRef<HeroBird[]>([])
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
        bright: i < 5 ? 'gold' : i < 10 ? 'white' : 'none',
        heading: angle + Math.PI / 2,
        sepMult: 0.5 + Math.random(), // multiplier for separation radius
        opacity: 0.07 + Math.random() * 0.03,
        gradFlip: Math.random() < 0.5,
        flapPhase: Math.random(), // random init so birds aren't synchronized
        fright: 0,
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
      // Init hero birds with staggered start delays
      if (heroBirds && heroRef.current.length === 0) {
        heroRef.current = Array.from({ length: HERO_COUNT }, (_, i) => {
          const h2 = makeHeroPath(w, h)
          h2.waiting = i * (HERO_WAIT_MAX / HERO_COUNT) // stagger entry
          return h2
        })
      }
    }

    resize()
    window.addEventListener('resize', resize)

    // Pre-render bird sprites onto offscreen canvases for performance.
    // Each tier is now an array of per-pose canvases: sprites[pose].
    // Total sprites: 3 poses × (5 dark-buckets + 5 light-buckets + 2 gold-flip + 2 white-flip) = 42 canvases.
    const SPRITE_PAD = 14  // extra pad so wings-up pose (compressed) centers cleanly
    const spriteW = Math.ceil(SVG_W * BOID_SCALE) + SPRITE_PAD * 2
    const spriteH = Math.ceil(SVG_H * BOID_SCALE) + SPRITE_PAD * 2

    // Render one pose of the bird. `wingScaleY` is applied around the bird's
    // vertical center (SVG_H/2) so the body stays approximately anchored while wings arc.
    function renderSprite(
      fillFn: (sctx: CanvasRenderingContext2D) => void,
      wingScaleY: number,
    ): HTMLCanvasElement {
      const c = document.createElement('canvas')
      c.width = spriteW
      c.height = spriteH
      const sctx = c.getContext('2d')!
      sctx.translate(SPRITE_PAD, SPRITE_PAD)
      sctx.scale(BOID_SCALE, BOID_SCALE)
      // Apply non-uniform Y scale around SVG_H/2 to fake wing articulation
      if (wingScaleY !== 1.0) {
        const cy = SVG_H / 2
        sctx.translate(0, cy)
        sctx.scale(1, wingScaleY)
        sctx.translate(0, -cy)
      }
      fillFn(sctx)
      sctx.fill(BIRD_PATH)
      return c
    }

    const DIM_BUCKETS = 5

    // dimSpritesDark[bucket][pose], dimSpritesLight[bucket][pose]
    const dimSpritesDark: HTMLCanvasElement[][] = []
    const dimSpritesLight: HTMLCanvasElement[][] = []
    for (let i = 0; i < DIM_BUCKETS; i++) {
      const opacity = 0.07 + (i / (DIM_BUCKETS - 1)) * 0.03
      const darkPoses: HTMLCanvasElement[] = []
      const lightPoses: HTMLCanvasElement[] = []
      for (let p = 0; p < FLAP_POSES_COUNT; p++) {
        const scaleY = FLAP_POSES[p]
        darkPoses.push(renderSprite(sctx => {
          const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
          const hi = `rgba(255,255,255,${(opacity * 1.3).toFixed(4)})`
          const lo = `rgba(255,255,255,${(opacity * 0.7).toFixed(4)})`
          grad.addColorStop(0, hi)
          grad.addColorStop(0.5, lo)
          grad.addColorStop(1, hi)
          sctx.fillStyle = grad
        }, scaleY))
        lightPoses.push(renderSprite(sctx => {
          const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
          const hi = `rgba(0,0,0,${(opacity * 1.3).toFixed(4)})`
          const lo = `rgba(0,0,0,${(opacity * 0.7).toFixed(4)})`
          grad.addColorStop(0, hi)
          grad.addColorStop(0.5, lo)
          grad.addColorStop(1, hi)
          sctx.fillStyle = grad
        }, scaleY))
      }
      dimSpritesDark.push(darkPoses)
      dimSpritesLight.push(lightPoses)
    }

    // goldSprites[flip][pose], whiteSprites[flip][pose]
    const goldSprites: HTMLCanvasElement[][] = [false, true].map(flip =>
      FLAP_POSES.map(scaleY => renderSprite(sctx => {
        const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
        const edgeHi = 'rgba(255,230,120,0.75)'
        const centerHi = 'rgba(255,230,120,0.50)'
        const lo = 'rgba(200,160,40,0.45)'
        grad.addColorStop(0, flip ? lo : edgeHi)
        grad.addColorStop(0.5, flip ? centerHi : lo)
        grad.addColorStop(1, flip ? lo : edgeHi)
        sctx.fillStyle = grad
      }, scaleY))
    )

    const whiteSprites: HTMLCanvasElement[][] = [false, true].map(flip =>
      FLAP_POSES.map(scaleY => renderSprite(sctx => {
        const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
        const whi = isDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)'
        const wlo = isDark ? 'rgba(200,200,210,0.35)' : 'rgba(30,30,20,0.35)'
        grad.addColorStop(0, flip ? wlo : whi)
        grad.addColorStop(0.5, flip ? whi : wlo)
        grad.addColorStop(1, flip ? wlo : whi)
        sctx.fillStyle = grad
      }, scaleY))
    )

    // Hero sprites: same renderSprite function but at HERO_SCALE.
    // heroGoldSprites[flip][pose], heroWhiteSprites[flip][pose] — 2×3×2 = 12 canvases.
    const heroSpriteW = Math.ceil(SVG_W * BOID_SCALE * HERO_SCALE) + SPRITE_PAD * 2
    const heroSpriteH = Math.ceil(SVG_H * BOID_SCALE * HERO_SCALE) + SPRITE_PAD * 2

    function renderHeroSprite(
      fillFn: (sctx: CanvasRenderingContext2D) => void,
      wingScaleY: number,
    ): HTMLCanvasElement {
      const c = document.createElement('canvas')
      c.width = heroSpriteW
      c.height = heroSpriteH
      const sctx = c.getContext('2d')!
      sctx.translate(SPRITE_PAD, SPRITE_PAD)
      sctx.scale(BOID_SCALE * HERO_SCALE, BOID_SCALE * HERO_SCALE)
      if (wingScaleY !== 1.0) {
        const cy = SVG_H / 2
        sctx.translate(0, cy)
        sctx.scale(1, wingScaleY)
        sctx.translate(0, -cy)
      }
      fillFn(sctx)
      sctx.fill(BIRD_PATH)
      return c
    }

    const heroGoldSprites: HTMLCanvasElement[][] = [false, true].map(flip =>
      FLAP_POSES.map(scaleY => renderHeroSprite(sctx => {
        const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
        grad.addColorStop(0, flip ? 'rgba(200,160,40,0.70)' : 'rgba(255,230,120,0.90)')
        grad.addColorStop(0.5, flip ? 'rgba(255,230,120,0.65)' : 'rgba(200,160,40,0.60)')
        grad.addColorStop(1, flip ? 'rgba(200,160,40,0.70)' : 'rgba(255,230,120,0.90)')
        sctx.fillStyle = grad
      }, scaleY))
    )

    const heroWhiteSprites: HTMLCanvasElement[][] = [false, true].map(flip =>
      FLAP_POSES.map(scaleY => renderHeroSprite(sctx => {
        const grad = sctx.createLinearGradient(0, 0, SVG_W, SVG_H)
        const whi = isDark ? 'rgba(255,255,255,0.80)' : 'rgba(0,0,0,0.80)'
        const wlo = isDark ? 'rgba(200,200,210,0.50)' : 'rgba(30,30,20,0.50)'
        grad.addColorStop(0, flip ? wlo : whi)
        grad.addColorStop(0.5, flip ? whi : wlo)
        grad.addColorStop(1, flip ? wlo : whi)
        sctx.fillStyle = grad
      }, scaleY))
    )

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

    let simHalf = 0 // alternate which half of boids we simulate
    let lastTime = performance.now()

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05) // seconds, capped at 50ms
      lastTime = now

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

        // Mouse fright — quadratic panic burst within FRIGHT_RADIUS; spikes fright scalar.
        // Falls back to the old gentle repulsion in the inner zone for birds that slip through.
        if (mouseRef.current.active) {
          const mdx = b.x - mouseRef.current.x
          const mdy = b.y - mouseRef.current.y
          const mDistSq = mdx * mdx + mdy * mdy
          if (mDistSq < FRIGHT_RADIUS * FRIGHT_RADIUS && mDistSq > 0) {
            const mDist = Math.sqrt(mDistSq)
            const t = 1 - mDist / FRIGHT_RADIUS           // 0..1, 1 = cursor center
            const force = FRIGHT_FORCE * t * t             // quadratic — sharp peak near cursor
            b.vx += (mdx / mDist) * force
            b.vy += (mdy / mDist) * force
            // Spike fright; stays elevated even as cursor passes
            const frightSpike = Math.min(1, t * t * 1.2 + 0.25)
            b.fright = Math.max(b.fright, frightSpike)
          } else if (mDistSq < MOUSE_RADIUS * MOUSE_RADIUS && mDistSq > 0) {
            // Fallback: original gentle repulsion for any gap between old/new radii logic
            const mDist = Math.sqrt(mDistSq)
            const force = MOUSE_FORCE * (1 - mDist / MOUSE_RADIUS)
            b.vx += (mdx / mDist) * force
            b.vy += (mdy / mDist) * force
          }
        }

        // Decay fright scalar each frame
        b.fright = Math.max(0, b.fright - FRIGHT_DECAY)

        // Soft edge avoidance
        if (b.x < EDGE_MARGIN) b.vx += EDGE_TURN
        if (b.x > w - EDGE_MARGIN) b.vx -= EDGE_TURN
        if (b.y < EDGE_MARGIN) b.vy += EDGE_TURN
        if (b.y > h - EDGE_MARGIN) b.vy -= EDGE_TURN

        // Clamp speed — frightened birds temporarily exceed normal cap
        const speedMult = b.bright === 'white' ? 1.2 : 1
        const panicBoost = 1 + b.fright * (FRIGHT_SPEED_BOOST - 1)
        const maxSpd = MAX_SPEED * speedMult * panicBoost
        const minSpd = MIN_SPEED * speedMult
        const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
        if (speed > maxSpd) {
          b.vx = (b.vx / speed) * maxSpd
          b.vy = (b.vy / speed) * maxSpd
        } else if (speed < minSpd) {
          b.vx = (b.vx / speed) * minSpd
          b.vy = (b.vy / speed) * minSpd
        }

        // Advance flap phase — rate scales with speed and panic level
        const currentSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
        const speedFrac = Math.max(0, Math.min(1, (currentSpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)))
        const baseHz = FLAP_BASE_HZ + speedFrac * (FLAP_MAX_HZ - FLAP_BASE_HZ)
        const frightHz = baseHz * (1 + b.fright * (FRIGHT_FLAP_BOOST - 1))
        b.flapPhase = (b.flapPhase + frightHz * dt) % 1.0

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

        // Select flap frame from current phase
        const poseIdx = Math.floor(b.flapPhase * FLAP_POSES_COUNT) % FLAP_POSES_COUNT

        let sprite: HTMLCanvasElement
        if (b.bright === 'gold') {
          sprite = goldSprites[b.gradFlip ? 1 : 0][poseIdx]
        } else if (b.bright === 'white') {
          sprite = whiteSprites[b.gradFlip ? 1 : 0][poseIdx]
        } else {
          const bucket = Math.min(DIM_BUCKETS - 1, Math.max(0, Math.round((b.opacity - 0.04) / 0.02 * (DIM_BUCKETS - 1))))
          sprite = isDark ? dimSpritesDark[bucket][poseIdx] : dimSpritesLight[bucket][poseIdx]
        }

        ctx.save()
        ctx.translate(b.x, b.y)
        ctx.rotate(b.heading)
        ctx.drawImage(sprite, -spriteW / 2, -spriteH / 2)
        ctx.restore()
      }

      // Update and draw hero birds (on top of the flock)
      if (heroBirds) {
        const dtMs = dt * 1000
        for (const hb of heroRef.current) {
          if (hb.waiting > 0) {
            hb.waiting -= dtMs
            continue // not yet visible
          }

          // Advance along Bézier path
          hb.t += HERO_SPEED * dtMs
          hb.flapPhase = (hb.flapPhase + HERO_FLAP_HZ * dt) % 1.0

          if (hb.t >= 1.0) {
            // Respawn with a new path after a random delay
            const fresh = makeHeroPath(w, h)
            fresh.waiting = HERO_WAIT_MIN + Math.random() * (HERO_WAIT_MAX - HERO_WAIT_MIN)
            Object.assign(hb, fresh)
            continue
          }

          const hx = bezierPt(hb.t, hb.x0, hb.x1, hb.x2, hb.x3)
          const hy = bezierPt(hb.t, hb.y0, hb.y1, hb.y2, hb.y3)
          const tx = bezierTan(hb.t, hb.x0, hb.x1, hb.x2, hb.x3)
          const ty = bezierTan(hb.t, hb.y0, hb.y1, hb.y2, hb.y3)
          const heading = Math.atan2(ty, tx) + Math.PI / 2

          const poseIdx = Math.floor(hb.flapPhase * FLAP_POSES_COUNT) % FLAP_POSES_COUNT
          // Alternate hero birds between gold and white for variety
          const heroSprites = heroRef.current.indexOf(hb) % 2 === 0 ? heroGoldSprites : heroWhiteSprites
          const heroSprite = heroSprites[hb.gradFlip ? 1 : 0][poseIdx]

          ctx.save()
          ctx.translate(hx, hy)
          ctx.rotate(heading)
          ctx.drawImage(heroSprite, -heroSpriteW / 2, -heroSpriteH / 2)
          ctx.restore()
        }
      }

      animRef.current = requestAnimationFrame(tick)
    }

    animRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(animRef.current)
      heroRef.current = [] // reset so a re-mount reinits hero paths with fresh w/h
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onMouseLeave)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [isDark, initBoids, heroBirds])

  return (
    <canvas
      ref={canvasRef}
      className="fixed pointer-events-none"
      style={{ zIndex: 0, top: -80, left: -80, right: -80, bottom: -80 }}
    />
  )
}
