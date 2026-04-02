import { useRef, useEffect, useMemo } from 'react'
import { Canvas, useFrame, useThree, useLoader } from '@react-three/fiber'
import * as THREE from 'three'

const COIN_RADIUS = 1.8
const COIN_THICKNESS = 0.18
const RIDGE_COUNT = 120
const RIDGE_DEPTH = 0.025
const EDGE_COLOR = '#7a6520'
const EDGE_HIGHLIGHT = '#a08630'
const BUMP_SCALE = 1.2
const FACE_SEGMENTS = 128

/**
 * Build a ridged cylinder edge (like a US quarter).
 * Uses a standard cylinder but displaces outer vertices radially with a sine wave.
 */
function useRidgedEdge() {
  return useMemo(() => {
    const geo = new THREE.CylinderGeometry(
      COIN_RADIUS, COIN_RADIUS, COIN_THICKNESS,
      RIDGE_COUNT * 2, // radial segments — 2 per ridge for peaks and valleys
      1,               // height segments
      true             // open ended (faces are separate meshes)
    )

    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const angle = Math.atan2(z, x)
      const ridge = Math.sin(angle * RIDGE_COUNT) * RIDGE_DEPTH
      const currentR = Math.sqrt(x * x + z * z)
      const newR = currentR + ridge
      const scale = newR / currentR
      pos.setX(i, x * scale)
      pos.setZ(i, z * scale)
    }
    geo.computeVertexNormals()
    return geo
  }, [])
}

/**
 * Generate a high-contrast bump map from the logo texture.
 */
function useBumpMap(texture: THREE.Texture) {
  return useMemo(() => {
    const img = texture.image as HTMLImageElement
    if (!img || !img.width) return null

    const canvas = document.createElement('canvas')
    const size = 512
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!

    // Fill black background first
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, size, size)

    // Draw the logo centered
    ctx.drawImage(img, 0, 0, size, size)
    const imageData = ctx.getImageData(0, 0, size, size)
    const data = imageData.data

    // Convert to high-contrast grayscale for stronger bump effect
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      // Boost contrast: push darks darker, lights lighter
      const boosted = Math.min(255, Math.max(0, (gray - 128) * 2.0 + 128))
      data[i] = boosted
      data[i + 1] = boosted
      data[i + 2] = boosted
    }
    ctx.putImageData(imageData, 0, 0)

    const bumpTex = new THREE.CanvasTexture(canvas)
    bumpTex.needsUpdate = true
    return bumpTex
  }, [texture.image])
}

/**
 * Create a circle geometry with enough subdivisions for bump mapping to be visible.
 */
function useDetailedCircle() {
  return useMemo(() => {
    // PlaneGeometry with many segments, then warp into a circle
    const segments = FACE_SEGMENTS
    const geo = new THREE.PlaneGeometry(
      COIN_RADIUS * 2, COIN_RADIUS * 2,
      segments, segments
    )
    const pos = geo.attributes.position
    const uv = geo.attributes.uv

    // Mask vertices outside the circle radius
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const dist = Math.sqrt(x * x + y * y)
      if (dist > COIN_RADIUS) {
        // Clamp to edge
        const scale = COIN_RADIUS / dist
        pos.setX(i, x * scale)
        pos.setY(i, y * scale)
        // Update UVs to match
        uv.setX(i, (x * scale / (COIN_RADIUS * 2)) + 0.5)
        uv.setY(i, (y * scale / (COIN_RADIUS * 2)) + 0.5)
      }
    }
    geo.computeVertexNormals()
    return geo
  }, [])
}

function Coin({ logoUrl }: { logoUrl: string }) {
  const meshRef = useRef<THREE.Group>(null)
  const texture = useLoader(THREE.TextureLoader, logoUrl)
  const bumpMap = useBumpMap(texture)
  const ridgedEdge = useRidgedEdge()
  const faceGeo = useDetailedCircle()

  const dragging = useRef(false)
  const velocity = useRef({ x: 0, y: 0.1625 })
  const lastDrag = useRef({ x: 0, y: 0 })
  const rotationRef = useRef({ x: 0, y: 0 })
  const mousePos = useRef({ x: 0, y: 0 })
  const { gl } = useThree()

  useEffect(() => {
    const canvas = gl.domElement

    // Track mouse across the whole page for tilt effect
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
        velocity.current.y += (0.1625 - velocity.current.y) * 0.005
      }
    }

    rotationRef.current.x += velocity.current.x
    rotationRef.current.y += velocity.current.y

    const tiltX = dragging.current ? 0 : mousePos.current.y * 1.5
    const tiltY = dragging.current ? 0 : mousePos.current.x * 1.5

    meshRef.current.rotation.x = rotationRef.current.x + tiltX
    meshRef.current.rotation.y = rotationRef.current.y + tiltY
  })

  return (
    <group ref={meshRef}>
      {/* Front face — high-poly plane for bump visibility */}
      <mesh geometry={faceGeo} position={[0, 0, COIN_THICKNESS / 2 + 0.001]}>
        <meshStandardMaterial
          color="#ebc046"
          map={texture}
          bumpMap={bumpMap}
          bumpScale={BUMP_SCALE}
          metalness={0.4}
          roughness={0.45}
        />
      </mesh>

      {/* Back face */}
      <mesh geometry={faceGeo} position={[0, 0, -(COIN_THICKNESS / 2 + 0.001)]} rotation={[0, Math.PI, 0]}>
        <meshStandardMaterial
          color="#ebc046"
          map={texture}
          bumpMap={bumpMap}
          bumpScale={BUMP_SCALE}
          metalness={0.4}
          roughness={0.45}
        />
      </mesh>

      {/* Ridged coin edge — rotated so cylinder axis aligns with Z */}
      <mesh geometry={ridgedEdge} rotation={[Math.PI / 2, 0, 0]}>
        <meshStandardMaterial
          color={EDGE_COLOR}
          metalness={0.8}
          roughness={0.2}
          emissive={EDGE_HIGHLIGHT}
          emissiveIntensity={0.05}
        />
      </mesh>
    </group>
  )
}

export default function CawCoin3D({ logoUrl, className }: { logoUrl: string; className?: string }) {
  return (
    <div className={className} style={{ cursor: 'grab' }}>
      <Canvas
        camera={{ position: [0, 0, 5], fov: 45 }}
        gl={{ alpha: true, antialias: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[4, 4, 6]} intensity={2.0} />
        <directionalLight position={[-3, -1, -4]} intensity={0.6} />
        <spotLight position={[0, 5, 5]} angle={0.4} penumbra={0.5} intensity={1.5} color="#fff5e0" />
        <pointLight position={[0, 0, 4]} intensity={0.8} color={EDGE_HIGHLIGHT} />
        <directionalLight position={[5, -3, 2]} intensity={0.8} color="#ffe8b0" />
        <pointLight position={[-4, 2, 3]} intensity={0.6} color="#ffffff" />
        <Coin logoUrl={logoUrl} />
      </Canvas>
    </div>
  )
}
