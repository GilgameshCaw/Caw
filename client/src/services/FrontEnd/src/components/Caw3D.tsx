import { useRef, useEffect, useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'

const DEPTH = 30
const FACE_COLOR_DARK = '#1a1a1a'
const FACE_COLOR_LIGHT = '#c0c0c8'

// SVG path from the single-bird CAW logo
const CROW_SVG_PATH = 'M355.2,118.75l-117.46-9.88s-24.86,1.13-40.66,23.15l14.12,55.91c-26.07,3.29-46.32,2.92-67.39.24l14.31-56.15s-13-24-50.76-22.57c-5.73.21-107.36,9.59-107.36,9.59L57.08,39.04l44-4.17s17.51-2.82,31.62,2.26c8.28,2.92,16.05,7.15,23,12.52L177.62,0l21,49.56c4.05-1.93,7.94-4.2,11.62-6.78,15.58-10.45,42.21-8.28,42.21-8.28l44.75,3.66,58,80.59Z'

function useCrowShape() {
  return useMemo(() => {
    // Parse the SVG path using Three's SVGLoader
    const paths = new SVGLoader().parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 355.2 190.29"><path d="${CROW_SVG_PATH}"/></svg>`
    ).paths

    if (paths.length === 0) return null

    const shapes = SVGLoader.createShapes(paths[0])
    if (shapes.length === 0) return null

    return shapes[0]
  }, [])
}

function useExtrudedCrow() {
  const crowShape = useCrowShape()
  return useMemo(() => {
    if (!crowShape) return null
    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: DEPTH,
      bevelEnabled: true,
      bevelThickness: 0.025,
      bevelSize: 0.03,
      bevelOffset: 0,
      bevelSegments: 6,
    }
    const geo = new THREE.ExtrudeGeometry(crowShape, extrudeSettings)
    geo.center()
    const scale = 3.6 / 355.2
    geo.scale(scale, -scale, scale)
    geo.computeVertexNormals()

    // Build outline for just front and back faces from the shape's points
    const points = crowShape.getPoints(64)
    const s = scale
    const bbox = geo.boundingBox!
    const frontZ = bbox.max.z
    const backZ = bbox.min.z
    // Compute center of shape points to match geo.center() offset
    let cx = 0, cy = 0
    for (const p of points) { cx += p.x; cy += p.y }
    cx /= points.length
    cy /= points.length
    // Actually, since we centered the geometry, derive offset from the original extrude
    const rawGeo = new THREE.ExtrudeGeometry(crowShape, extrudeSettings)
    rawGeo.computeBoundingBox()
    const rawBB = rawGeo.boundingBox!
    const offsetX = (rawBB.min.x + rawBB.max.x) / 2
    const offsetY = (rawBB.min.y + rawBB.max.y) / 2
    rawGeo.dispose()

    // Build closed loop positions for front and back face outlines
    const faceLoopPositions = (z: number) => {
      const pos: number[] = []
      for (let i = 0; i <= points.length; i++) {
        const p = points[i % points.length]
        pos.push((p.x - offsetX) * s, -(p.y - offsetY) * s, z)
      }
      return pos
    }
    const frontLineGeo = new LineGeometry()
    frontLineGeo.setPositions(faceLoopPositions(frontZ))
    const backLineGeo = new LineGeometry()
    backLineGeo.setPositions(faceLoopPositions(backZ))

    // Key landmark points from the SVG path (in SVG coords):
    // Beak tip: (177.62, 0)
    // Right wing tip: (355.2, 118.75)
    // Right wing inner: (297, 39)  — near L57.08 mirror
    // Left wing tip: (0, 119.04)
    // Left wing inner: (57.08, 39.04)
    // Tail bottom-left: (143.81, 187.93)  — approx from curves
    // Tail bottom-right: (211.2, 187.93)  — approx from curves
    const landmarks = [
      { x: 177.62, y: 0 },        // beak
      { x: 355.2, y: 118.75 },    // right wing tip
      { x: 298, y: 39 },          // right wing upper edge
      { x: 0, y: 119.04 },        // left wing tip
      { x: 57.08, y: 39.04 },     // left wing upper edge
      { x: 143.81, y: 187.93 },   // tail left
      { x: 211.2, y: 187.93 },    // tail right
    ]

    // Build connecting lines as individual LineGeometry segments
    const connectGeos: LineGeometry[] = []
    for (const lm of landmarks) {
      const x = (lm.x - offsetX) * s
      const y = -(lm.y - offsetY) * s
      const g = new LineGeometry()
      g.setPositions([x, y, frontZ, x, y, backZ])
      connectGeos.push(g)
    }

    const lineMat = new LineMaterial({
      color: 0xebc046,
      linewidth: 1.2,
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    })

    return { mesh: geo, frontLine: frontLineGeo, backLine: backLineGeo, connectGeos, lineMat }
  }, [crowShape])
}

function CrowMesh({ isDark }: { isDark: boolean }) {
  const meshRef = useRef<THREE.Group>(null)
  const result = useExtrudedCrow()

  const dragging = useRef(false)
  const velocity = useRef({ x: 0, y: 0.025 })
  const lastDrag = useRef({ x: 0, y: 0 })
  const rotationRef = useRef({ x: 0, y: 0 })
  const mousePos = useRef({ x: 0, y: 0 })
  const { gl } = useThree()

  useEffect(() => {
    const canvas = gl.domElement

    const onWindowMouseMove = (e: MouseEvent) => {
      mousePos.current.x = (e.clientX / window.innerWidth - 0.5) * 2
      mousePos.current.y = (e.clientY / window.innerHeight - 0.5) * 2
    }

    const onCanvasMouseMove = (e: MouseEvent) => {
      if (dragging.current) {
        const dx = e.clientX - lastDrag.current.x
        const dy = e.clientY - lastDrag.current.y
        velocity.current = { x: -dy * 0.01, y: dx * 0.01 }
        lastDrag.current = { x: e.clientX, y: e.clientY }
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      dragging.current = true
      lastDrag.current = { x: e.clientX, y: e.clientY }
      velocity.current = { x: 0, y: 0 }
      canvas.style.cursor = 'grabbing'
    }

    const onMouseUp = () => {
      dragging.current = false
      canvas.style.cursor = 'grab'
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      dragging.current = true
      lastDrag.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      velocity.current = { x: 0, y: 0 }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!dragging.current || e.touches.length !== 1) return
      const dx = e.touches[0].clientX - lastDrag.current.x
      const dy = e.touches[0].clientY - lastDrag.current.y
      velocity.current = { x: -dy * 0.01, y: dx * 0.01 }
      lastDrag.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    }

    const onTouchEnd = () => { dragging.current = false }

    window.addEventListener('mousemove', onWindowMouseMove)
    canvas.addEventListener('mousemove', onCanvasMouseMove)
    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', onTouchEnd)

    return () => {
      window.removeEventListener('mousemove', onWindowMouseMove)
      canvas.removeEventListener('mousemove', onCanvasMouseMove)
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [gl])

  useFrame(() => {
    if (!meshRef.current) return

    if (!dragging.current) {
      velocity.current.x *= 0.97
      velocity.current.y *= 0.97

      const speed = Math.abs(velocity.current.x) + Math.abs(velocity.current.y)
      if (speed < 0.01) {
        velocity.current.y += (0.025 - velocity.current.y) * 0.005
      }

      // Slowly re-orient so beak points up (x rotation → nearest multiple of 2π)
      const targetX = Math.round(rotationRef.current.x / (Math.PI * 2)) * Math.PI * 2
      rotationRef.current.x += (targetX - rotationRef.current.x) * 0.003
    }

    rotationRef.current.x += velocity.current.x
    rotationRef.current.y += velocity.current.y

    const tiltX = dragging.current ? 0 : mousePos.current.y * 1.5
    const tiltY = dragging.current ? 0 : mousePos.current.x * 1.5

    meshRef.current.rotation.x = rotationRef.current.x + tiltX
    meshRef.current.rotation.y = rotationRef.current.y + tiltY
  })

  if (!result) return null

  return (
    <group ref={meshRef}>
      {/* Main black shape */}
      <mesh geometry={result.mesh}>
        {isDark ? (
          <meshStandardMaterial
            color={FACE_COLOR_DARK}
            metalness={0.3}
            roughness={0.6}
          />
        ) : (
          <meshPhysicalMaterial
            color="#e8ddd0"
            roughness={1}
            metalness={0}
            sheen={1}
            sheenRoughness={0.8}
            sheenColor="#f5e6d0"
            clearcoat={0}
          />
        )}
      </mesh>
      {/* Gold outline on front and back faces */}
      <primitive object={new Line2(result.frontLine, result.lineMat)} />
      <primitive object={new Line2(result.backLine, result.lineMat)} />
      {/* Connecting lines at key points */}
      {result.connectGeos.map((g, i) => (
        <primitive key={i} object={new Line2(g, result.lineMat)} />
      ))}
    </group>
  )
}

export default function Caw3D({ className, isDark = true }: { className?: string; isDark?: boolean }) {
  return (
    // background:transparent on the wrapper is load-order insurance: the
    // <canvas> element exists in the DOM for a beat before WebGL paints its
    // first frame, and on some browsers it renders its default opaque (white)
    // backdrop in that gap — visible as a brief white square on the splash.
    // Forcing the wrapper AND the canvas transparent means there's nothing
    // white to show through before the first gl.clear().
    <div className={className} style={{ cursor: 'grab', background: 'transparent' }}>
      <Canvas
        camera={{ position: [0, 0, 5], fov: 45 }}
        gl={{ alpha: true, antialias: true, premultipliedAlpha: false, powerPreference: 'low-power' }}
        dpr={[1, 1.5]}
        style={{ background: 'transparent' }}
        onCreated={({ gl }) => {
          // Clear to fully transparent from the very first frame so the
          // canvas never flashes its default opaque backdrop before the
          // crow is drawn.
          gl.setClearColor(0x000000, 0)
          gl.setClearAlpha(0)
        }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[4, 3, 6]} intensity={1.8} color="#ebc046" />
        <directionalLight position={[-4, 2, 5]} intensity={1.2} color="#c0c0c0" />
        <directionalLight position={[0, -3, 5]} intensity={0.8} color="#d4d4d4" />
        <CrowMesh isDark={isDark} />
      </Canvas>
    </div>
  )
}
