import { useRef, useMemo, useEffect, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

// ─── Constants ────────────────────────────────────────────────────────────────

// World half-extents — birds live roughly inside this box. Sized slightly LARGER
// than the visible frustum (camera z=22, fov 55° → visible half-height ≈ 11.5 at
// z=0, half-width ≈ that × aspect) so birds drift just a little off the edges
// before the soft boundary turns them back.
const WORLD_X = 24.2  // small overflow past the left/right edges
const WORLD_Y = 13.75 // small overflow past top/bottom
const WORLD_Z = 13    // deeper box so birds can recede farther from the screen

// Wing-flap amplitude (vertex units, matching Mr.doob's original scale factor)
const WING_AMP = 5

// ── Live-tunable flock params ───────────────────────────────────────────────────
// These control how the flock FLOWS. They live in a mutable object so a dev-only
// slider overlay (import.meta.env.DEV) can adjust them live; the sim reads from
// `tune` every frame. Once dialled in, bake the values back as the defaults here.
const tune = {
  minSpeed: 0.01,
  maxSpeed: 0.02,
  // How fast the displayed heading catches up to the velocity direction (0..1).
  // Lower = slower, smoother turns.
  turnRate: 0.05,
  // Boids neighbour radii (world units)
  sepRadius: 2,
  aliRadius: 4.5,
  cohRadius: 4.0,
  // Boids weights — lower = calmer, less constant course-correcting ("freaking out")
  sepWeight: 0.02,
  aliWeight: 0.2,
  cohWeight: 0.0045,
  // Per-frame velocity damping toward smooth gliding (1 = no damping). <1 bleeds off
  // jitter so birds coast in straight-ish lines unless a force acts on them.
  velDamp: 1,
  // Soft world-boundary turn force
  boundTurn: 0.02,
  // Tiny random wander each frame — breaks up dead-straight paths so birds don't
  // ping-pong forever between two walls; they gently meander and pick new routes.
  wander: 0.0016,
  // Per-bird display size multiplier (applied via mesh.scale; 1 = baked CROW_SCALE).
  size: 0.65,
  // Wing-flap speed multiplier (1 = base rate).
  flapSpeed: 1.0,
  // Hard ceiling on per-frame flap phase advance — caps how fast wings can EVER
  // beat (e.g. during panic). Lower = wings never blur.
  maxFlapRate: 0.1,
}

const BOUND_MARGIN_X = 3.5
const BOUND_MARGIN_Y = 2.5
const BOUND_MARGIN_Z = 2.5

// Mouse repulsion / fright — birds panic and dart away from the cursor. Wide
// radius sweeps a big swath of the flock; high peak force + a per-bird fright
// scalar that temporarily lifts the speed cap means nearby birds genuinely
// BOLT (not just nudge), then settle back to cruising over ~1s.
const MOUSE_WORLD_RADIUS = 10.0   // detection zone around the cursor
const MOUSE_FRIGHT_PEAK = 1.4     // force at distance=0 (≫ MAX_SPEED → hard dart)
// Cursor's x,y are projected onto the flock mid-plane (so it lines up with where the
// birds are). Birds flee mostly SIDEWAYS in that plane; only a small fraction of the
// push goes into the screen depth (−z) so they drift back / shrink a little but don't
// punch straight away from the cursor.
const MOUSE_PLANE_Z = 0           // x,y projection plane (flock centre)
const FRIGHT_Z_SCALE = 0.12       // how much of the flee goes into depth (small = sideways)
const FRIGHT_SPEED_BOOST = 3.5    // max speed cap multiplier while fully frightened
const FRIGHT_DECAY = 0.02         // per-frame decay of the fright scalar (~0.8s to settle)

// Fog / depth shading — kept thin: it only lightly fades the very farthest birds.
// Camera z=22, flock z∈[−10,10] → distance-from-camera ≈ 12 (near) to ≈ 32 (far).
// NEAR well past the nearest birds, FAR pushed beyond the farthest so nothing is
// fully swallowed — just a gentle depth cue.
const FOG_NEAR = 20
const FOG_FAR = 44

// ─── Crow count (scale by device capability) ──────────────────────────────────

function getCrowCount(): number {
  // NOTE: the boids neighbour scan is O(n²), so cost ~4× from 100→200. Smooth on
  // desktop; mobile kept lower. If 200 ever stutters, a spatial grid (like the 2D
  // BoidsBg) would drop this back to ~O(n).
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  const dpr = window.devicePixelRatio || 1
  if (isMobile || dpr < 1.5) return 100
  return 200
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

// ── Crow vertices (x forward, y up=flap, z sideways) ────────────────────────────
// Authored in the crow-wing-editor (visualizations/crow-wing-editor.html) to match
// the CAW logo. Body outline = head → shoulder → waist → (mid1,mid2) → tail → notch,
// mirrored L/R. Each wing = 14 points around a blade: leading edge (in-lead, lead1..5,
// out-lead) then trailing edge (WINGTIP, trail1..5, in-trail). All y=0 at rest; the
// wing verts flap in y at runtime weighted by how far out they are (see WING_FLAP_W).
const BASE_VERTS: readonly number[] = [
  /* v0  HEAD        */   7.0,  0.0,    0.0,
  /* v1  L shoulder  */   3.2,  0.0,   -1.5,
  /* v2  R shoulder  */   3.2,  0.0,    1.5,
  /* v3  L waist     */  -1.3,  0.0,   -1.2,
  /* v4  R waist     */  -1.3,  0.0,    1.2,
  /* v5  L body-mid1 */  -2.5,  0.0,   -1.3,  // between waist & tail
  /* v6  R body-mid1 */  -2.5,  0.0,    1.3,
  /* v7  L body-mid2 */  -4.4,  0.0,   -1.7,  // between waist & tail
  /* v8  R body-mid2 */  -4.4,  0.0,    1.7,
  /* v9  L tail      */  -5.6,  0.0,   -2.0,
  /* v10 R tail      */  -5.6,  0.0,    2.0,
  /* v11 tail notch  */  -5.8,  0.0,    0.0,
  // Left wing (v12..v25): leading edge then trailing edge
  /* v12 L in-lead   */   3.5,  0.0,   -0.7,
  /* v13 L lead1     */   4.2,  0.0,   -1.7,
  /* v14 L lead2     */   4.5,  0.0,   -2.4,
  /* v15 L lead3     */   4.8,  0.0,   -3.0,
  /* v16 L lead4     */   4.8,  0.0,   -3.8,
  /* v17 L lead5     */   4.7,  0.0,   -5.0,
  /* v18 L out-lead  */   4.4,  0.0,   -7.0,
  /* v19 L WINGTIP   */  -1.0,  0.0,  -10.6,
  /* v20 L trail1    */  -0.6,  0.0,   -7.6,
  /* v21 L trail2    */  -0.3,  0.0,   -4.7,
  /* v22 L trail3    */  -0.4,  0.0,   -3.6,
  /* v23 L trail4    */  -0.6,  0.0,   -2.5,
  /* v24 L trail5    */  -1.2,  0.0,   -1.6,
  /* v25 L in-trail  */  -2.0,  0.0,   -0.9,
  // Right wing (v26..v39): mirror of left across z
  /* v26 R in-lead   */   3.5,  0.0,    0.7,
  /* v27 R lead1     */   4.2,  0.0,    1.7,
  /* v28 R lead2     */   4.5,  0.0,    2.4,
  /* v29 R lead3     */   4.8,  0.0,    3.0,
  /* v30 R lead4     */   4.8,  0.0,    3.8,
  /* v31 R lead5     */   4.7,  0.0,    5.0,
  /* v32 R out-lead  */   4.4,  0.0,    7.0,
  /* v33 R WINGTIP   */  -1.0,  0.0,   10.6,
  /* v34 R trail1    */  -0.6,  0.0,    7.6,
  /* v35 R trail2    */  -0.3,  0.0,    4.7,
  /* v36 R trail3    */  -0.4,  0.0,    3.6,
  /* v37 R trail4    */  -0.6,  0.0,    2.5,
  /* v38 R trail5    */  -1.2,  0.0,    1.6,
  /* v39 R in-trail  */  -2.0,  0.0,    0.9,
]

const L_WING_BASE = 12   // first left-wing vert (in-lead)
const R_WING_BASE = 26   // first right-wing vert
const WING_PTS = 14      // verts per wing
const WING_BASES = [L_WING_BASE, R_WING_BASE] as const

// Body triangulation. Outline down each side: head → shoulder → waist → mid1 →
// mid2 → tail → (notch). Filled as a fan/strip so all body verts are covered.
const BODY_TRIS = [
  0, 2, 1,    // head cap
  1, 2, 4,    // shoulder band
  1, 4, 3,
  3, 4, 6,    // waist → mid1 band
  3, 6, 5,
  5, 6, 8,    // mid1 → mid2 band
  5, 8, 7,
  7, 8, 10,   // mid2 → tail band
  7, 10, 9,
  9, 10, 11,  // tail → notch (closes the back)
]

// Wing = triangle fan from in-lead around its 14-point outline.
function wingFanTris(base: number): number[] {
  const t: number[] = []
  for (let k = 1; k < WING_PTS - 1; k++) t.push(base, base + k, base + k + 1)
  return t
}

const CROW_INDICES = new Uint16Array([
  ...BODY_TRIS,
  ...wingFanTris(L_WING_BASE),
  ...wingFanTris(R_WING_BASE),
])

// Per-vertex flap weights: 0 for body verts (never move), ramping 0→1 along each
// wing by how far OUT the vertex is (|z| relative to the wingtip). The wingtip
// flaps fullest; roots near the body barely move. Computed once from BASE_VERTS.
const WING_FLAP_W: Float32Array = (() => {
  const w = new Float32Array(BASE_VERTS.length / 3)
  // The WINGTIP is vert (base + 7); use its |z| as the maximum span.
  const maxZ = Math.abs(BASE_VERTS[(L_WING_BASE + 7) * 3 + 2])
  for (const base of [L_WING_BASE, R_WING_BASE]) {
    for (let k = 0; k < WING_PTS; k++) {
      const vi = base + k
      const z = Math.abs(BASE_VERTS[vi * 3 + 2])
      // ease so the bend is gentle near the root and strong toward the tip
      const t = Math.min(1, z / maxZ)
      w[vi] = t * t
    }
  }
  return w
})()

// Resting Y offset per vertex — gives the otherwise-flat bird some THICKNESS:
//  • body verts are domed up along the centre spine (full lift at z≈0, none at the
//    wide edges) so the body has a rounded cross-section instead of a flat sheet;
//  • wing verts get a slight upward dihedral that grows toward the tip (a shallow
//    V), so the wings aren't coplanar with the body even at rest.
// The flap oscillation is ADDED on top of this resting height (see useFrame).
const BODY_DOME = 0.9     // peak spine lift (raw units, pre-scale)
const WING_DIHEDRAL = 1.6 // wingtip resting lift (raw units)
const REST_Y: Float32Array = (() => {
  const ry = new Float32Array(BASE_VERTS.length / 3)
  const tipZ = Math.abs(BASE_VERTS[(L_WING_BASE + 7) * 3 + 2])
  // widest body vert |z| (tail corners) to normalise the dome falloff
  let bodyMaxZ = 0
  for (let v = 0; v < L_WING_BASE; v++) bodyMaxZ = Math.max(bodyMaxZ, Math.abs(BASE_VERTS[v * 3 + 2]))
  for (let v = 0; v < L_WING_BASE; v++) {
    const z = Math.abs(BASE_VERTS[v * 3 + 2])
    ry[v] = BODY_DOME * (1 - z / bodyMaxZ)   // spine high, edges flat
  }
  for (const base of [L_WING_BASE, R_WING_BASE]) {
    for (let k = 0; k < WING_PTS; k++) {
      const vi = base + k
      const t = Math.min(1, Math.abs(BASE_VERTS[vi * 3 + 2]) / tipZ)
      ry[vi] = WING_DIHEDRAL * t            // rises toward the tip
    }
  }
  return ry
})()

// Per-vertex brightness tint baked as vertex colours: 1.0 at the body, fading to
// WINGTIP_DARKEN toward the wingtips so each wing has a subtle darker-at-the-tip
// gradient. Multiplies the material's base colour (so it darkens every tier
// proportionally). Reuses the same outward measure as the flap weights.
const WINGTIP_DARKEN = 0.7   // tips render at 70% brightness of the body
const WING_TINT: Float32Array = (() => {
  const nVerts = BASE_VERTS.length / 3
  const tint = new Float32Array(nVerts).fill(1)   // body verts stay full brightness
  const maxZ = Math.abs(BASE_VERTS[(L_WING_BASE + 7) * 3 + 2])
  for (const base of [L_WING_BASE, R_WING_BASE]) {
    for (let k = 0; k < WING_PTS; k++) {
      const vi = base + k
      const t = Math.min(1, Math.abs(BASE_VERTS[vi * 3 + 2]) / maxZ)  // 0 root → 1 tip
      tint[vi] = 1 - t * (1 - WINGTIP_DARKEN)
    }
  }
  return tint
})()

function makeCrowGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(BASE_VERTS.length)
  for (let i = 0; i < BASE_VERTS.length; i++) {
    positions[i] = (BASE_VERTS[i] as number) * CROW_SCALE
  }
  // Bake the resting Y (body dome + wing dihedral) so even before any flap the
  // bird has thickness instead of being a flat sheet at y=0.
  for (let v = 0; v < REST_Y.length; v++) {
    positions[v * 3 + 1] = REST_Y[v] * CROW_SCALE
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  // Vertex colours = grayscale tint (white body → darker tips). With the material's
  // vertexColors:true this multiplies the base colour for the wingtip gradient.
  const colors = new Float32Array(BASE_VERTS.length)
  for (let v = 0; v < WING_TINT.length; v++) {
    const c = WING_TINT[v]
    colors[v * 3] = c; colors[v * 3 + 1] = c; colors[v * 3 + 2] = c
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(new THREE.BufferAttribute(CROW_INDICES, 1))
  return geo
}

// ─── Color tiers ─────────────────────────────────────────────────────────────
// Three tiers: a few GOLD and SILVER "hero" birds, the rest a dark GREY.
// Fixed counts: 3 gold + 2 silver, everything else grey.
// Gold & silver also BEHAVE differently — they care less about the flock (lower
// flock weights) so they keep flying through rather than bouncing off others, and
// fly a bit faster. Silver is the more extreme of the two; gold milder.

type ColorTier = 'gold' | 'silver' | 'grey'

const GOLD_COUNT = 3
const SILVER_COUNT = 2

function getTier(i: number): ColorTier {
  if (i < GOLD_COUNT) return 'gold'
  if (i < GOLD_COUNT + SILVER_COUNT) return 'silver'
  return 'grey'
}

// Per-tier BEHAVIOUR. flockMul scales the boids forces (sep/ali/coh) — lower means
// the bird ignores its neighbours more and flies through smoothly. speedMul scales
// the bird's min/max cruising speed.
const TIER_BEHAVIOR: Record<ColorTier, { flockMul: number; speedMul: number }> = {
  grey:   { flockMul: 1.0,  speedMul: 1.0 },
  gold:   { flockMul: 0.45, speedMul: 1.25 },  // milder loner, a little faster
  silver: { flockMul: 0.15, speedMul: 1.7 },   // strong loner, noticeably faster
}

// Tier colours (dark-mode values), RGB in 0..1.
const TIER_COLORS = {
  grey:   { r: 0.06, g: 0.06, b: 0.06 },   // near-black
  gold:   { r: 1,    g: 0.42, b: 0 },      // saturated orange-gold
  silver: { r: 0.85, g: 0.87, b: 0.92 },
}

// Materials are created once per isDark change (in useMemo) and shared across all
// birds of a tier. Each bird still owns its geometry for mutable wingtip flap.

function makeTierMaterials(isDark: boolean): Record<ColorTier, THREE.MeshBasicMaterial> {
  // FULLY OPAQUE: the bird is several overlapping triangles (body + 2 wings); with
  // transparency the overlaps stack and darken, so the bird isn't one flat colour.
  const mk = (c: { r: number; g: number; b: number }, light: THREE.Color, fog: boolean) =>
    new THREE.MeshBasicMaterial({
      color: isDark ? new THREE.Color(c.r, c.g, c.b) : light,
      side: THREE.DoubleSide,
      vertexColors: true,   // baked grayscale tint darkens the wingtips
      fog,
    })
  const mats = {
    gold:   mk(TIER_COLORS.gold,   new THREE.Color(0xf5b829),       false),
    silver: mk(TIER_COLORS.silver, new THREE.Color(0.30, 0.30, 0.33), false),
    grey:   mk(TIER_COLORS.grey,   new THREE.Color(0.10, 0.09, 0.09), true),
  }
  return mats
}

// ─── Per-crow state ───────────────────────────────────────────────────────────

// Number of independent flocks. Each bird is permanently assigned to one group
// and only flocks (alignment/cohesion/separation) with its OWN group, so the
// groups stay independent — they drift, cross, and pass through each other but
// never merge into a single blob.
const NUM_GROUPS = 3

interface CrowState {
  px: number; py: number; pz: number   // position
  vx: number; vy: number; vz: number   // velocity
  phase: number                          // wing-flap phase (radians)
  fright: number                         // 0..1 panic scalar: spikes near cursor, decays
  tier: ColorTier                        // assigned at init, immutable
  group: number                          // 0..NUM_GROUPS-1, fixed flock membership
  yaw: number                            // DISPLAYED yaw, damped toward velocity heading
  pitch: number                          // DISPLAYED pitch, damped toward velocity heading
}

function makeCrowStates(count: number): CrowState[] {
  const states: CrowState[] = []
  for (let i = 0; i < count; i++) {
    const tier = getTier(i)
    const beh = TIER_BEHAVIOR[tier]
    const spd = (tune.minSpeed + Math.random() * (tune.maxSpeed - tune.minSpeed)) * beh.speedMul
    // Random unit direction
    const theta = Math.random() * Math.PI * 2
    const phi = (Math.random() - 0.5) * Math.PI
    const vx = Math.cos(theta) * Math.cos(phi) * spd
    const vy = Math.sin(phi) * spd
    const vz = Math.sin(theta) * Math.cos(phi) * spd
    states.push({
      px: (Math.random() - 0.5) * WORLD_X * 2,
      py: (Math.random() - 0.5) * WORLD_Y * 2,
      pz: (Math.random() - 0.5) * WORLD_Z * 2,
      vx, vy, vz,
      phase: Math.random() * Math.PI * 2,
      fright: 0,
      tier,
      group: i % NUM_GROUPS,   // even thirds; spreads gold/silver across groups
      // seed displayed angles from initial velocity so there's no first-frame snap
      yaw: Math.atan2(-vz, vx),
      pitch: Math.asin(Math.max(-1, Math.min(1, vy / (spd || 1)))),
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

  // Dispose the per-crow GPU geometries when this meshes set is replaced or the
  // component unmounts — otherwise each mount/unmount (or count change) leaks
  // ~100–200 BufferGeometries on the GPU. (<Canvas> tears down the GL context,
  // but the geometry buffers are ours to free.)
  useEffect(() => {
    return () => { for (const m of meshes) m.geometry.dispose() }
  }, [meshes])

  // Dispose the tier materials when the theme changes (new set created) or on
  // unmount, so repeated dark/light toggles don't accumulate materials.
  useEffect(() => {
    return () => { for (const mat of Object.values(tierMaterials)) mat.dispose() }
  }, [tierMaterials])

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

        // Separation applies to ALL birds (so crossing groups don't overlap)...
        if (distSq < tune.sepRadius * tune.sepRadius && distSq > 0) {
          const dist = Math.sqrt(distSq)
          _sep.x -= dx / dist
          _sep.y -= dy / dist
          _sep.z -= dz / dist
        }
        // ...but alignment & cohesion only consider SAME-GROUP birds, so the
        // groups fly as independent flocks and never merge into one.
        if (o.group !== b.group) continue
        if (distSq < tune.aliRadius * tune.aliRadius) {
          _ali.x += o.vx; _ali.y += o.vy; _ali.z += o.vz
          aliCount++
        }
        if (distSq < tune.cohRadius * tune.cohRadius) {
          _coh.x += o.px; _coh.y += o.py; _coh.z += o.pz
          cohCount++
        }
      }

      // Apply forces — scaled by this bird's tier flock-multiplier (gold/silver
      // care less about neighbours, so they fly through instead of bouncing off).
      const fm = TIER_BEHAVIOR[b.tier].flockMul
      b.vx += _sep.x * tune.sepWeight * fm
      b.vy += _sep.y * tune.sepWeight * fm
      b.vz += _sep.z * tune.sepWeight * fm

      if (aliCount > 0) {
        b.vx += (_ali.x / aliCount - b.vx) * tune.aliWeight * fm
        b.vy += (_ali.y / aliCount - b.vy) * tune.aliWeight * fm
        b.vz += (_ali.z / aliCount - b.vz) * tune.aliWeight * fm
      }

      if (cohCount > 0) {
        b.vx += (_coh.x / cohCount - b.px) * tune.cohWeight * fm
        b.vy += (_coh.y / cohCount - b.py) * tune.cohWeight * fm
        b.vz += (_coh.z / cohCount - b.pz) * tune.cohWeight * fm
      }

      // Wander — small random steering so birds never settle into a dead-straight
      // line that ping-pongs between two walls forever. Keeps paths varied.
      b.vx += (Math.random() - 0.5) * tune.wander
      b.vy += (Math.random() - 0.5) * tune.wander
      b.vz += (Math.random() - 0.5) * tune.wander

      // Soft world-boundary avoidance — a GENTLE nudge that ramps up with how far
      // past the margin the bird is (not a hard wall). SKIPPED while frightened so a
      // fleeing bird can punch through and fly off-screen rather than pinning to the
      // edge and jittering against an invisible wall next to the cursor.
      if (b.fright < 0.05) {
        const bt = tune.boundTurn
        if (b.px < -WORLD_X + BOUND_MARGIN_X) b.vx += bt * (-WORLD_X + BOUND_MARGIN_X - b.px)
        if (b.px >  WORLD_X - BOUND_MARGIN_X) b.vx -= bt * (b.px - (WORLD_X - BOUND_MARGIN_X))
        if (b.py < -WORLD_Y + BOUND_MARGIN_Y) b.vy += bt * (-WORLD_Y + BOUND_MARGIN_Y - b.py)
        if (b.py >  WORLD_Y - BOUND_MARGIN_Y) b.vy -= bt * (b.py - (WORLD_Y - BOUND_MARGIN_Y))
        if (b.pz < -WORLD_Z + BOUND_MARGIN_Z) b.vz += bt * (-WORLD_Z + BOUND_MARGIN_Z - b.pz)
        if (b.pz >  WORLD_Z - BOUND_MARGIN_Z) b.vz -= bt * (b.pz - (WORLD_Z - BOUND_MARGIN_Z))
      }
      // Hard backstop: birds can roam well off-screen, but never escape to infinity.
      // A wide clamp catches anyone the gentle nudge let slip too far.
      const HARD = 1.4
      if (b.px < -WORLD_X * HARD) { b.px = -WORLD_X * HARD; b.vx = Math.abs(b.vx) * 0.5 }
      if (b.px >  WORLD_X * HARD) { b.px =  WORLD_X * HARD; b.vx = -Math.abs(b.vx) * 0.5 }
      if (b.py < -WORLD_Y * HARD) { b.py = -WORLD_Y * HARD; b.vy = Math.abs(b.vy) * 0.5 }
      if (b.py >  WORLD_Y * HARD) { b.py =  WORLD_Y * HARD; b.vy = -Math.abs(b.vy) * 0.5 }
      if (b.pz < -WORLD_Z * HARD) { b.pz = -WORLD_Z * HARD; b.vz = Math.abs(b.vz) * 0.5 }
      if (b.pz >  WORLD_Z * HARD) { b.pz =  WORLD_Z * HARD; b.vz = -Math.abs(b.vz) * 0.5 }

      // Mouse fright — birds flee MOSTLY SIDEWAYS (across the screen: left/right/up/
      // down) out of the cursor's path, with only a slight backward drift. The flee
      // direction is normalised in the screen plane (x,y); the depth (z) push is
      // scaled way down by FRIGHT_Z_SCALE so they don't just punch straight back.
      if (mw.active) {
        const mdx = b.px - mw.x
        const mdy = b.py - mw.y
        const screenDistSq = mdx * mdx + mdy * mdy
        if (screenDistSq < MOUSE_WORLD_RADIUS * MOUSE_WORLD_RADIUS) {
          const screenDist = Math.sqrt(screenDistSq)
          const t = 1 - screenDist / MOUSE_WORLD_RADIUS   // 0..1, 1 = under cursor
          const force = MOUSE_FRIGHT_PEAK * t * t          // quadratic fall-off
          // Screen-plane escape direction (normalised on x,y only). If the bird is
          // almost exactly under the cursor, nudge it to a random side so it still
          // scatters sideways rather than going purely backward.
          let dx = mdx, dy = mdy
          if (screenDist < 0.001) { const a = i * 2.399963; dx = Math.cos(a); dy = Math.sin(a) }
          const inv = 1 / (Math.hypot(dx, dy) || 1)
          b.vx += dx * inv * force
          b.vy += dy * inv * force
          b.vz += -force * FRIGHT_Z_SCALE                  // small drift into the screen
          // Spike fright (stays elevated as the cursor passes, then decays)
          b.fright = Math.max(b.fright, Math.min(1, t * 1.3 + 0.2))
        }
      }

      // Decay the fright scalar each frame so panic lingers ~1s then settles.
      if (b.fright > 0) b.fright = Math.max(0, b.fright - FRIGHT_DECAY)

      // Velocity damping — bleed off accumulated jitter so birds coast smoothly
      // in straight-ish lines unless a force acts. (Skip while frightened so the
      // panic dart isn't damped away.) This is the main "calm them down" knob.
      if (b.fright < 0.05) {
        b.vx *= tune.velDamp; b.vy *= tune.velDamp; b.vz *= tune.velDamp
      }

      // Speed clamp — per-tier cruising speed (gold/silver fly faster); frightened
      // birds may temporarily exceed it.
      const sm = TIER_BEHAVIOR[b.tier].speedMul
      const maxSpd = tune.maxSpeed * sm * (1 + b.fright * (FRIGHT_SPEED_BOOST - 1))
      const minSpd = tune.minSpeed * sm
      const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz)
      if (spd > maxSpd) {
        const inv = maxSpd / spd
        b.vx *= inv; b.vy *= inv; b.vz *= inv
      } else if (spd < minSpd && spd > 0) {
        const inv = minSpd / spd
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

      // ── Position & size ───────────────────────────────────────────────────
      mesh.position.set(b.px, b.py, b.pz)
      mesh.scale.setScalar(tune.size)   // live size knob (geometry baked at 1×)

      // ── Orientation (the key Wilderness effect), DAMPED ───────────────────
      // yaw:  crow banks/turns left-right following horizontal direction
      // pitch: nose-up when climbing, nose-down when diving
      // The displayed yaw/pitch are LERPed toward the velocity heading so the bird
      // turns over several frames instead of snapping — no jarring rapid flips.
      const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz)
      const targetYaw = Math.atan2(-b.vz, b.vx)
      const targetPitch = Math.asin(spd > 0 ? Math.max(-1, Math.min(1, b.vy / spd)) : 0)
      // yaw wraps at ±π — take the shortest angular path before lerping
      let dYaw = targetYaw - b.yaw
      while (dYaw > Math.PI) dYaw -= Math.PI * 2
      while (dYaw < -Math.PI) dYaw += Math.PI * 2
      b.yaw += dYaw * tune.turnRate
      b.pitch += (targetPitch - b.pitch) * tune.turnRate
      mesh.rotation.y = b.yaw
      mesh.rotation.z = b.pitch
      mesh.rotation.x = 0

      // ── Wing flap ─────────────────────────────────────────────────────────
      // Phase advances faster when climbing steeply (effort coupling) and when
      // frightened (panic flapping) — up to ~3× while fully spooked.
      const pitchAngle = mesh.rotation.z  // positive = nose up
      const flapAdvance = (Math.max(0, pitchAngle - 0.5) + 0.1) * (1 + b.fright * 2) * tune.flapSpeed
      b.phase += Math.min(flapAdvance, tune.maxFlapRate)   // cap so wings never blur

      const wingY = Math.sin(b.phase % (Math.PI * 2)) * WING_AMP * CROW_SCALE

      const posAttr = mesh.geometry.attributes['position'] as THREE.BufferAttribute
      const arr = posAttr.array as Float32Array
      // Flap the whole wing blade: each wing vert's Y = its RESTING height (the
      // dihedral) PLUS the flap oscillation × its outward weight — so the tips
      // travel fullest, the roots barely move, and the resting V is preserved.
      for (const base of WING_BASES) {
        for (let k = 0; k < WING_PTS; k++) {
          const vi = base + k
          arr[vi * 3 + 1] = REST_Y[vi] * CROW_SCALE + wingY * WING_FLAP_W[vi]
        }
      }
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
