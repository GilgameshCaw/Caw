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

// Mouse repulsion / fright — birds panic and dart away from the cursor. Wide
// radius sweeps a big swath of the flock; high peak force + a per-bird fright
// scalar that temporarily lifts the speed cap means nearby birds genuinely
// BOLT (not just nudge), then settle back to cruising over ~1s.
const MOUSE_WORLD_RADIUS = 10.0   // detection zone around the cursor
const MOUSE_FRIGHT_PEAK = 1.4     // force at distance=0 (≫ MAX_SPEED → hard dart)
const MOUSE_PLANE_Z = 0           // project cursor onto z=0 plane
const FRIGHT_SPEED_BOOST = 3.5    // max speed cap multiplier while fully frightened
const FRIGHT_DECAY = 0.02         // per-frame decay of the fright scalar (~0.8s to settle)

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

// ─── Crow geometry — CAW logo silhouette ───────────────────────────────────────
// Hand-built low-poly crow to read like the CAW logo bird:
//   - BODY: a spearhead — sharp pointed head (+x, forward), widens to shoulders,
//     pinches slightly at waist, then FLARES to a wide tail at the back (-x).
//     The tail is wider than the shoulders (per crow-body.svg flared tail).
//   - WINGS: long SHALLOW BLADE per crow-wing.svg — span (z) >> chord (x).
//     Leading edge runs nearly flat from body shoulder out to a sharp outer tip.
//     The tip is out to the SIDE (large ±z) with only a slight -x rearward offset.
//     NOT swept up-and-back. Two tris per wing form the blade.
//   - Wings HINGE at body shoulders. Inner/root verts stay in y≈0 plane.
//     Outer WINGTIP verts animate in Y for the flap.
//
// Axes:  x = forward (beak) / back (tail)   z = wingspan (L/R)   y = up (flap)
//
// 16 vertices (v0..v15):
//
//  BODY (all y=0, body in xz plane):
//   v0  HEAD tip      ( 7.0,  0,    0  )  sharp beak point, forward
//   v1  L shoulder    ( 2.5,  0,   -1.8)  where left wing attaches
//   v2  R shoulder    ( 2.5,  0,    1.8)  where right wing attaches
//   v3  L waist       ( 0.2,  0,   -0.8)  body pinches after shoulders
//   v4  R waist       ( 0.2,  0,    0.8)
//   v5  L tail corner (-4.8,  0,   -2.6)  tail FLARES wider than shoulders
//   v6  R tail corner (-4.8,  0,    2.6)
//   v7  tail notch    (-4.0,  0,    0  )  central notch on the tail's back edge
//
//  LEFT WING (blade, attaches near L shoulder):
//   v8  L inner lead  ( 3.0,  0,   -2.2)  leading edge root, near shoulder (slightly forward)
//   v9  L inner trail ( 0.5,  0,   -2.2)  trailing edge root
//   v10 L wing mid    ( 1.0,  0,   -5.5)  blade midpoint, nearly same x as root
//   v11 L WINGTIP     (-0.2,  0,   -9.5)  outer tip: large -z, only tiny -x  ← FLAP Y
//
//  RIGHT WING (mirror of left):
//   v12 R inner lead  ( 3.0,  0,    2.2)
//   v13 R inner trail ( 0.5,  0,    2.2)
//   v14 R wing mid    ( 1.0,  0,    5.5)
//   v15 R WINGTIP     (-0.2,  0,    9.5)  ← FLAP Y
//
// Body tris (6):  head fan + tail flare
// Wing tris (4):  2 per wing (inner-lead,inner-trail,mid) + (inner-lead,mid,tip)
//
// CROW_SCALE 0.072 brings the ~19-unit raw span into ~0.96 world units — similar
// on-screen size to before.

const CROW_SCALE = 0.072

const BASE_VERTS: readonly number[] = [
  /* v0  HEAD tip       */  7.0,  0.0,   0.0,
  /* v1  L shoulder     */  2.5,  0.0,  -1.8,
  /* v2  R shoulder     */  2.5,  0.0,   1.8,
  /* v3  L waist        */  0.2,  0.0,  -0.8,
  /* v4  R waist        */  0.2,  0.0,   0.8,
  /* v5  L tail corner  */ -4.8,  0.0,  -2.6,
  /* v6  R tail corner  */ -4.8,  0.0,   2.6,
  /* v7  tail notch     */ -4.0,  0.0,   0.0,
  /* v8  L inner lead   */  3.0,  0.0,  -2.2,
  /* v9  L inner trail  */  0.5,  0.0,  -2.2,
  /* v10 L wing mid     */  1.0,  0.0,  -5.5,
  /* v11 L WINGTIP      */ -0.2,  0.0,  -9.5,
  /* v12 R inner lead   */  3.0,  0.0,   2.2,
  /* v13 R inner trail  */  0.5,  0.0,   2.2,
  /* v14 R wing mid     */  1.0,  0.0,   5.5,
  /* v15 R WINGTIP      */ -0.2,  0.0,   9.5,
]

// Faces (DoubleSide material so winding is not critical):
//  Body: 6 tris fully tile the body polygon (head/shoulders/waist/tail)
//  Wings: 2 tris per wing = 4 tris
//  Total: 10 triangles
//
// Body triangulation (outline: v0→v2→v4→v6→v7→v5→v3→v1→v0):
//   Front half: (0,2,1) head; (1,2,4) shoulder band; (1,4,3) waist band
//   Back half:  (3,4,7) center trunk; (3,7,5) L tail flare; (4,6,7) R tail flare
// All 8 body verts covered, no gaps.
const CROW_INDICES = new Uint8Array([
  // Body — front half
  0,  2,  1,   // head → R shoulder → L shoulder  (front cap)
  1,  2,  4,   // L shoulder → R shoulder → R waist  (shoulder band)
  1,  4,  3,   // L shoulder → R waist → L waist  (waist band)
  // Body — back half (tail)
  3,  4,  7,   // L waist → R waist → tail notch  (center trunk)
  3,  7,  5,   // L waist → tail notch → L tail corner  (L flare)
  4,  6,  7,   // R waist → R tail corner → tail notch  (R flare)
  // Left wing blade
  8,  9, 10,   // inner-lead → inner-trail → mid
  8, 10, 11,   // inner-lead → mid → tip
  // Right wing blade
 12, 14, 13,   // inner-lead → mid → inner-trail
 12, 15, 14,   // inner-lead → tip → mid
])

// Stride-3 Y-component indices for the WINGTIP verts that animate during flap.
// v11 = index 11 → flat-array offset 11*3+1 = 34
// v15 = index 15 → flat-array offset 15*3+1 = 46
const IDX_V4_Y = 11 * 3 + 1  // 34 — left  wingtip Y  (v11)
const IDX_V5_Y = 15 * 3 + 1  // 46 — right wingtip Y  (v15)

// Optional: also animate the mid-wing verts at a fraction of the tip for a
// smoother bend. v10 Y = 10*3+1 = 31, v14 Y = 14*3+1 = 43
const IDX_MID_L_Y = 10 * 3 + 1  // 31 — left  mid-wing Y  (v10)
const IDX_MID_R_Y = 14 * 3 + 1  // 43 — right mid-wing Y  (v14)

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

// ─── Color tiers — match the old 2D BoidsBg.tsx tier pattern ─────────────────
// Three tiers assigned at init by bird index (same split as 2D version):
//   i < 5              → GOLD   (~5 birds): CAW gold #ffe678, opacity 0.70 — POPS
//   i < 10             → SILVER (~5 birds): dark=white / light=near-black, opacity 0.65
//   else               → DIM    (~90%): low alpha, recedes against the background

type ColorTier = 'gold' | 'silver' | 'dim'

function getTier(i: number): ColorTier {
  if (i < 5)  return 'gold'
  if (i < 10) return 'silver'
  return 'dim'
}

// Materials are created once per isDark change (in useMemo) and shared across
// all birds of the same tier. Each bird still has its OWN geometry for mutable
// wingtip positions. No allocations in the per-frame loop.

function makeTierMaterials(isDark: boolean): Record<ColorTier, THREE.MeshBasicMaterial> {
  return {
    gold: new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.0, 0.902, 0.471),  // #ffe678 — CAW accent gold
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.70,
    }),
    silver: new THREE.MeshBasicMaterial({
      color: isDark
        ? new THREE.Color(1.0, 1.0, 1.0)          // pure white on dark
        : new THREE.Color(0.08, 0.07, 0.06),       // near-black on light
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.65,
    }),
    dim: new THREE.MeshBasicMaterial({
      color: isDark
        ? new THREE.Color(0.78, 0.82, 0.86)        // light grey-blue on dark
        : new THREE.Color(0.08, 0.07, 0.06),       // near-black on light
      side: THREE.DoubleSide,
      transparent: true,
      opacity: isDark ? 0.15 : 0.12,               // faint / transparent — they recede
    }),
  }
}

// ─── Per-crow state ───────────────────────────────────────────────────────────

interface CrowState {
  px: number; py: number; pz: number   // position
  vx: number; vy: number; vz: number   // velocity
  phase: number                          // wing-flap phase (radians)
  fright: number                         // 0..1 panic scalar: spikes near cursor, decays
  tier: ColorTier                        // assigned at init, immutable
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
      fright: 0,
      tier: getTier(i),
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

  // Fog fades distant crows toward the background for depth. It must match the
  // page bg (black in dark mode, white in light) so birds dissolve into the
  // "sky" rather than into a mismatched grey haze.
  const fogColor = useMemo(
    () => isDark ? new THREE.Color(0x000000) : new THREE.Color(0xffffff),
    [isDark]
  )

  // Inject scene fog (mutate the scene object directly — r3f exposes it via useThree)
  const { scene } = useThree()
  useEffect(() => {
    scene.fog = new THREE.Fog(fogColor, FOG_NEAR, FOG_FAR)
    return () => { scene.fog = null }
  }, [scene, fogColor])

  // Per-tier materials — recreated only when isDark changes, shared across birds
  const tierMaterials = useMemo(() => makeTierMaterials(isDark), [isDark])

  // Build per-crow meshes + geometry (each crow owns its geometry for mutable wing verts)
  const count = useMemo(() => getCrowCount(), [])

  const meshes = useMemo(() => {
    const arr: THREE.Mesh[] = []
    for (let i = 0; i < count; i++) {
      const geo = makeCrowGeometry()
      const tier = getTier(i)
      const m = new THREE.Mesh(geo, tierMaterials[tier])
      arr.push(m)
    }
    return arr
  }, [count, tierMaterials])

  // When tierMaterials change (isDark toggle), update all mesh materials in-place
  // so we don't rebuild the geometry array.
  useEffect(() => {
    for (let i = 0; i < meshes.length; i++) {
      const tier = getTier(i)
      meshes[i].material = tierMaterials[tier]
    }
  }, [meshes, tierMaterials])

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

      // Mouse fright — repulsion from projected cursor point. Birds within the
      // (wide) radius get a hard outward shove AND spike their `fright` scalar,
      // which temporarily lifts their speed cap so the dart actually lands.
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
          // Spike fright (stays elevated as the cursor passes, then decays)
          b.fright = Math.max(b.fright, Math.min(1, t * 1.3 + 0.2))
        }
      }

      // Decay the fright scalar each frame so panic lingers ~1s then settles.
      if (b.fright > 0) b.fright = Math.max(0, b.fright - FRIGHT_DECAY)

      // Speed clamp — frightened birds may temporarily exceed normal MAX_SPEED.
      const maxSpd = MAX_SPEED * (1 + b.fright * (FRIGHT_SPEED_BOOST - 1))
      const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz)
      if (spd > maxSpd) {
        const inv = maxSpd / spd
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
      // Phase advances faster when climbing steeply (effort coupling) and when
      // frightened (panic flapping) — up to ~3× while fully spooked.
      const pitchAngle = mesh.rotation.z  // positive = nose up
      b.phase += (Math.max(0, pitchAngle - 0.5) + 0.1) * (1 + b.fright * 2)

      const wingY = Math.sin(b.phase % (Math.PI * 2)) * WING_AMP * CROW_SCALE

      const posAttr = mesh.geometry.attributes['position'] as THREE.BufferAttribute
      const arr = posAttr.array as Float32Array
      // Animate outer wingtips (v11 left, v15 right) — symmetric flap
      arr[IDX_V4_Y] = wingY   // left  wingtip Y  (v11)
      arr[IDX_V5_Y] = wingY   // right wingtip Y  (v15)
      // Also lift the mid-wing verts at 55% of tip travel for a smooth blade bend
      arr[IDX_MID_L_Y] = wingY * 0.55   // v10 left  mid-wing
      arr[IDX_MID_R_Y] = wingY * 0.55   // v14 right mid-wing
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
