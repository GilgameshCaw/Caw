import { useRef, useMemo, useEffect, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

// ─── Constants ────────────────────────────────────────────────────────────────

// World half-extents — birds live roughly inside this box
const WORLD_X = 18
const WORLD_Y = 11
const WORLD_Z = 10

const MIN_SPEED = 0.04
const MAX_SPEED = 0.14

// Wing-flap amplitude (vertex units, matching Mr.doob's original scale factor)
const WING_AMP = 5

// Boids radii (world units)
const SEP_RADIUS = 2.2
const ALI_RADIUS = 4.5
const COH_RADIUS = 4.0

// Boids weights
const SEP_WEIGHT = 0.14
const ALI_WEIGHT = 0.06
const COH_WEIGHT = 0.004

// Soft-boundary turn force
const BOUND_MARGIN_X = 3.5
const BOUND_MARGIN_Y = 2.5
const BOUND_MARGIN_Z = 2.5
const BOUND_TURN = 0.003

// Mouse repulsion
const MOUSE_WORLD_RADIUS = 6.0
const MOUSE_FRIGHT_PEAK = 0.22  // force at distance=0
const MOUSE_PLANE_Z = 0         // project cursor onto z=0 plane

// Fog / depth shading
const FOG_NEAR = 12
const FOG_FAR = 30

// ─── Crow count (scale by device capability) ──────────────────────────────────

function getCrowCount(): number {
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  const dpr = window.devicePixelRatio || 1
  if (isMobile || dpr < 1.5) return 60
  return 100
}

// ─── Crow geometry ────────────────────────────────────────────────────────────
// 8 vertices, 3 triangles — Mr.doob's original layout from thewildernessdowntown.
//
// v0 ( 5, 0, 0)   beak
// v1 (-5,-2, 1)   tail tip A
// v2 (-5, 0, 0)   tail center
// v3 (-5,-2,-1)   tail tip B
// v4 ( 0, 2,-6)   LEFT  wingtip  ← animated
// v5 ( 0, 2, 6)   RIGHT wingtip  ← animated
// v6 ( 2, 0, 0)   body front
// v7 (-3, 0, 0)   body back
//
// Faces: (0,2,1) body/tail   (4,7,6) left wing   (5,6,7) right wing
//
// Scale factor 0.08 brings the 10-unit crow into ~0.8 world units — readable
// at our camera distance of ~22 without dominating the frame.

const CROW_SCALE = 0.08

// Flat positions array for the 9 vertices (v0..v7, index matches above)
const BASE_VERTS: readonly number[] = [
  /* v0 beak      */  5,  0,  0,
  /* v1 tail A    */ -5, -2,  1,
  /* v2 tail ctr  */ -5,  0,  0,
  /* v3 tail B    */ -5, -2, -1,
  /* v4 L wing    */  0,  2, -6,
  /* v5 R wing    */  0,  2,  6,
  /* v6 body fnt  */  2,  0,  0,
  /* v7 body bck  */ -3,  0,  0,
]

// Triangle index triplets: (0,2,1), (4,7,6), (5,6,7)
const CROW_INDICES = new Uint8Array([0, 2, 1,  4, 7, 6,  5, 6, 7])

// Wing vertex indices inside the position flat array (stride 3)
const IDX_V4_Y = 4 * 3 + 1  // 13 — left  wingtip Y
const IDX_V5_Y = 5 * 3 + 1  // 16 — right wingtip Y

function makeCrowGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(BASE_VERTS.length)
  for (let i = 0; i < BASE_VERTS.length; i++) {
    positions[i] = (BASE_VERTS[i] as number) * CROW_SCALE
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setIndex(new THREE.BufferAttribute(CROW_INDICES, 1))
  return geo
}

// ─── Per-crow state ───────────────────────────────────────────────────────────

interface CrowState {
  px: number; py: number; pz: number   // position
  vx: number; vy: number; vz: number   // velocity
  phase: number                          // wing-flap phase (radians)
}

function makeCrowStates(count: number): CrowState[] {
  const states: CrowState[] = []
  for (let i = 0; i < count; i++) {
    const spd = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED)
    // Random unit direction
    const theta = Math.random() * Math.PI * 2
    const phi = (Math.random() - 0.5) * Math.PI
    states.push({
      px: (Math.random() - 0.5) * WORLD_X * 2,
      py: (Math.random() - 0.5) * WORLD_Y * 2,
      pz: (Math.random() - 0.5) * WORLD_Z * 2,
      vx: Math.cos(theta) * Math.cos(phi) * spd,
      vy: Math.sin(phi) * spd,
      vz: Math.sin(theta) * Math.cos(phi) * spd,
      phase: Math.random() * Math.PI * 2,
    })
  }
  return states
}

// ─── Mouse world position ─────────────────────────────────────────────────────

interface MouseWorld {
  x: number; y: number; active: boolean
}

// ─── Inner scene component ────────────────────────────────────────────────────

function FlockScene({ isDark }: { isDark: boolean }) {
  const { gl, camera, size } = useThree()

  // One material per scene (shared across all meshes — THREE reuses it fine)
  const material = useMemo(() => {
    const col = isDark
      ? new THREE.Color(0x0a0a0b)   // near-black for dark mode
      : new THREE.Color(0x3a3028)   // warm dark-grey on light bg
    return new THREE.MeshBasicMaterial({
      color: col,
      side: THREE.DoubleSide,
    })
  }, [isDark])

  // Fog color matches the bg so distant crows recede naturally
  const fogColor = useMemo(
    () => isDark ? new THREE.Color(0x050507) : new THREE.Color(0xf5f0ea),
    [isDark]
  )

  // Inject scene fog (mutate the scene object directly — r3f exposes it via useThree)
  const { scene } = useThree()
  useEffect(() => {
    scene.fog = new THREE.Fog(fogColor, FOG_NEAR, FOG_FAR)
    return () => { scene.fog = null }
  }, [scene, fogColor])

  // Build per-crow meshes + geometry (each crow owns its geometry for mutable wing verts)
  const count = useMemo(() => getCrowCount(), [])

  const meshes = useMemo(() => {
    const arr: THREE.Mesh[] = []
    for (let i = 0; i < count; i++) {
      const geo = makeCrowGeometry()
      const m = new THREE.Mesh(geo, material)
      arr.push(m)
    }
    return arr
  }, [count, material])

  // Group holds all crows — added to the scene as a single node
  const groupRef = useRef<THREE.Group>(null)

  // Boid state array — lives in a ref so useFrame mutates it without re-renders
  const states = useRef<CrowState[]>(makeCrowStates(count))

  // Mouse world position (projected onto z=MOUSE_PLANE_Z)
  const mouseWorld = useRef<MouseWorld>({ x: 0, y: 0, active: false })

  // Temp vectors reused each frame — allocated once to avoid GC churn
  const _sep = useMemo(() => new THREE.Vector3(), [])
  const _ali = useMemo(() => new THREE.Vector3(), [])
  const _coh = useMemo(() => new THREE.Vector3(), [])

  // ── Mouse event listeners ────────────────────────────────────────────────────
  const unproject = useCallback((clientX: number, clientY: number) => {
    // NDC
    const nx = (clientX / size.width) * 2 - 1
    const ny = -(clientY / size.height) * 2 + 1
    // Ray from camera
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera)
    // Intersect z=MOUSE_PLANE_Z plane
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -MOUSE_PLANE_Z)
    const target = new THREE.Vector3()
    raycaster.ray.intersectPlane(plane, target)
    return target
  }, [camera, size])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const p = unproject(e.clientX, e.clientY)
      mouseWorld.current.x = p.x
      mouseWorld.current.y = p.y
      mouseWorld.current.active = true
    }
    const onLeave = () => { mouseWorld.current.active = false }
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const p = unproject(e.touches[0].clientX, e.touches[0].clientY)
      mouseWorld.current.x = p.x
      mouseWorld.current.y = p.y
      mouseWorld.current.active = true
    }
    const onTouchEnd = () => { mouseWorld.current.active = false }

    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    window.addEventListener('touchmove', onTouch, { passive: true })
    window.addEventListener('touchend', onTouchEnd)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('touchmove', onTouch)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [unproject])

  // Ensure gl is transparent (belt-and-suspenders matching Caw3D's onCreated pattern)
  useEffect(() => {
    gl.setClearColor(0x000000, 0)
  }, [gl])

  // ── Main frame loop ──────────────────────────────────────────────────────────
  useFrame(() => {
    const cs = states.current
    const n = cs.length
    const mw = mouseWorld.current

    // ── Boids simulation ────────────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const b = cs[i]

      _sep.set(0, 0, 0)
      _ali.set(0, 0, 0)
      _coh.set(0, 0, 0)
      let aliCount = 0
      let cohCount = 0

      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const o = cs[j]
        const dx = o.px - b.px
        const dy = o.py - b.py
        const dz = o.pz - b.pz
        const distSq = dx * dx + dy * dy + dz * dz

        if (distSq < SEP_RADIUS * SEP_RADIUS && distSq > 0) {
          const dist = Math.sqrt(distSq)
          _sep.x -= dx / dist
          _sep.y -= dy / dist
          _sep.z -= dz / dist
        }
        if (distSq < ALI_RADIUS * ALI_RADIUS) {
          _ali.x += o.vx; _ali.y += o.vy; _ali.z += o.vz
          aliCount++
        }
        if (distSq < COH_RADIUS * COH_RADIUS) {
          _coh.x += o.px; _coh.y += o.py; _coh.z += o.pz
          cohCount++
        }
      }

      // Apply forces
      b.vx += _sep.x * SEP_WEIGHT
      b.vy += _sep.y * SEP_WEIGHT
      b.vz += _sep.z * SEP_WEIGHT

      if (aliCount > 0) {
        b.vx += (_ali.x / aliCount - b.vx) * ALI_WEIGHT
        b.vy += (_ali.y / aliCount - b.vy) * ALI_WEIGHT
        b.vz += (_ali.z / aliCount - b.vz) * ALI_WEIGHT
      }

      if (cohCount > 0) {
        b.vx += (_coh.x / cohCount - b.px) * COH_WEIGHT
        b.vy += (_coh.y / cohCount - b.py) * COH_WEIGHT
        b.vz += (_coh.z / cohCount - b.pz) * COH_WEIGHT
      }

      // Soft world-boundary avoidance
      if (b.px < -WORLD_X + BOUND_MARGIN_X) b.vx += BOUND_TURN * (WORLD_X * 2)
      if (b.px >  WORLD_X - BOUND_MARGIN_X) b.vx -= BOUND_TURN * (WORLD_X * 2)
      if (b.py < -WORLD_Y + BOUND_MARGIN_Y) b.vy += BOUND_TURN * (WORLD_Y * 2)
      if (b.py >  WORLD_Y - BOUND_MARGIN_Y) b.vy -= BOUND_TURN * (WORLD_Y * 2)
      if (b.pz < -WORLD_Z + BOUND_MARGIN_Z) b.vz += BOUND_TURN * (WORLD_Z * 2)
      if (b.pz >  WORLD_Z - BOUND_MARGIN_Z) b.vz -= BOUND_TURN * (WORLD_Z * 2)

      // Mouse fright — repulsion from projected cursor point
      if (mw.active) {
        const mdx = b.px - mw.x
        const mdy = b.py - mw.y
        const mdz = b.pz - MOUSE_PLANE_Z
        const mDistSq = mdx * mdx + mdy * mdy + mdz * mdz
        if (mDistSq < MOUSE_WORLD_RADIUS * MOUSE_WORLD_RADIUS && mDistSq > 0) {
          const mDist = Math.sqrt(mDistSq)
          // Quadratic fall-off: strongest at origin, zero at radius edge
          const t = 1 - mDist / MOUSE_WORLD_RADIUS
          const force = MOUSE_FRIGHT_PEAK * t * t
          b.vx += (mdx / mDist) * force
          b.vy += (mdy / mDist) * force
          b.vz += (mdz / mDist) * force
        }
      }

      // Speed clamp
      const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz)
      if (spd > MAX_SPEED) {
        const inv = MAX_SPEED / spd
        b.vx *= inv; b.vy *= inv; b.vz *= inv
      } else if (spd < MIN_SPEED && spd > 0) {
        const inv = MIN_SPEED / spd
        b.vx *= inv; b.vy *= inv; b.vz *= inv
      }

      // Advance position
      b.px += b.vx
      b.py += b.vy
      b.pz += b.vz
    }

    // ── Apply state to meshes ───────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const b = cs[i]
      const mesh = meshes[i]

      // ── Position ──────────────────────────────────────────────────────────
      mesh.position.set(b.px, b.py, b.pz)

      // ── Orientation (the key Wilderness effect) ───────────────────────────
      // yaw:  crow banks/turns left-right following horizontal direction
      // pitch: nose-up when climbing, nose-down when diving
      const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz)
      mesh.rotation.y = Math.atan2(-b.vz, b.vx)
      // Clamp arg to avoid NaN from floating-point edge cases
      const pitchArg = spd > 0 ? Math.max(-1, Math.min(1, b.vy / spd)) : 0
      mesh.rotation.z = Math.asin(pitchArg)
      mesh.rotation.x = 0

      // ── Wing flap ─────────────────────────────────────────────────────────
      // Phase advances faster when climbing steeply — effort coupling
      const pitchAngle = mesh.rotation.z  // positive = nose up
      b.phase += Math.max(0, pitchAngle - 0.5) + 0.1

      const wingY = Math.sin(b.phase % (Math.PI * 2)) * WING_AMP * CROW_SCALE

      const posAttr = mesh.geometry.attributes['position'] as THREE.BufferAttribute
      const arr = posAttr.array as Float32Array
      arr[IDX_V4_Y] = wingY   // left  wingtip Y
      arr[IDX_V5_Y] = wingY   // right wingtip Y (symmetric flap)
      posAttr.needsUpdate = true
    }
  })

  return (
    <group ref={groupRef}>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </group>
  )
}

// ─── Public component ─────────────────────────────────────────────────────────

export default function BoidsBg3D({
  isDark = true,
  className,
}: {
  isDark?: boolean
  className?: string
}) {
  // Camera pulled back enough to see the full world box; slight downward tilt
  // puts the horizon through the middle of the frame.
  return (
    <div
      className={className}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    >
      <Canvas
        camera={{ position: [0, 2, 22], fov: 55 }}
        gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
        dpr={[1, 1.5]}
        style={{ background: 'transparent' }}
        onCreated={({ gl }) => {
          // Belt-and-suspenders: ensure no white flash on Safari
          gl.setClearColor(0x000000, 0)
        }}
      >
        <FlockScene isDark={isDark} />
      </Canvas>
    </div>
  )
}
