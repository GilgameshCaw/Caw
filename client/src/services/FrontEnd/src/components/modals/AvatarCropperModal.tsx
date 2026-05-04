import React, { useEffect, useMemo, useRef, useState } from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

interface AvatarCropperModalProps {
  isOpen: boolean
  /** Source file the user picked. Cropper revokes its own object URL on close. */
  file: File | null
  /** Called with the cropped, square File. Same name + type as source. */
  onCrop: (cropped: File) => void
  onClose: () => void
}

const VIEW_PX = 320
const OUTPUT_PX = 512
const MIN_ZOOM = 1
const MAX_ZOOM = 4

/**
 * Drag-to-pan, slider-to-zoom square cropper. The crop window is the
 * entire 320px view box; the source image moves underneath. On Save,
 * the visible window is rendered to a 512px square canvas and emitted
 * as a File for the existing uploadAvatar pipeline (which will compress
 * to 300px main + 96px thumb).
 *
 * Output size 512 (not 300) so the downstream compressor has headroom
 * to land at 300×300 without an upscale step from a too-small input.
 */
const AvatarCropperModal: React.FC<AvatarCropperModalProps> = ({ isOpen, file, onCrop, onClose }) => {
  const { isDark } = useTheme()
  const t = useT()
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  // Pan in CSS px relative to the centered position. {0,0} = image centered.
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)

  // Build object URL for the source file. Revoke on file change / unmount.
  useEffect(() => {
    if (!file) { setImgUrl(null); setImg(null); return }
    const url = URL.createObjectURL(file)
    setImgUrl(url)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    return () => URL.revokeObjectURL(url)
  }, [file])

  // Decode the image so we know its natural dimensions.
  useEffect(() => {
    if (!imgUrl) return
    const el = new Image()
    el.onload = () => setImg(el)
    el.src = imgUrl
  }, [imgUrl])

  // Base scale: cover the 320 view with the smaller side of the image.
  // Then user-zoom multiplies on top.
  const baseScale = useMemo(() => {
    if (!img) return 1
    return VIEW_PX / Math.min(img.naturalWidth, img.naturalHeight)
  }, [img])

  const renderedW = img ? img.naturalWidth * baseScale * zoom : 0
  const renderedH = img ? img.naturalHeight * baseScale * zoom : 0

  // Clamp pan so the image always covers the crop window — no empty edges.
  const clampPan = (x: number, y: number) => {
    const maxX = Math.max(0, (renderedW - VIEW_PX) / 2)
    const maxY = Math.max(0, (renderedH - VIEW_PX) / 2)
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    }
  }

  // Re-clamp whenever zoom changes (zooming out can leave the image off-edge).
  useEffect(() => {
    setPan(p => clampPan(p.x, p.y))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, renderedW, renderedH])

  const onPointerDown = (e: React.PointerEvent) => {
    if (!img) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setPan(clampPan(dragRef.current.panX + dx, dragRef.current.panY + dy))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
  }

  const handleSave = async () => {
    if (!img || !file) return
    // Inverse map view-box → source pixels. The pixel at view (0,0) is the
    // source pixel at: ((natW/2) - pan.x/baseScale/zoom - VIEW_PX/2/(baseScale*zoom)).
    const scale = baseScale * zoom
    const cropSrcSize = VIEW_PX / scale
    const cx = img.naturalWidth / 2 - pan.x / scale
    const cy = img.naturalHeight / 2 - pan.y / scale
    const sx = Math.max(0, cx - cropSrcSize / 2)
    const sy = Math.max(0, cy - cropSrcSize / 2)
    const sSize = Math.min(cropSrcSize, img.naturalWidth - sx, img.naturalHeight - sy)

    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_PX
    canvas.height = OUTPUT_PX
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT_PX, OUTPUT_PX)
    const blob: Blob | null = await new Promise(resolve =>
      canvas.toBlob(resolve, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.95),
    )
    if (!blob) return
    const cropped = new File([blob], file.name, { type: blob.type, lastModified: Date.now() })
    onCrop(cropped)
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-sm" closeOnClickOutside={false}>
      <div className="p-5 space-y-4">
        <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-black'}`}>
          {t('avatar_cropper.title')}
        </h3>

        <div
          ref={viewRef}
          className={`relative mx-auto overflow-hidden rounded-full select-none ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}
          style={{ width: VIEW_PX, height: VIEW_PX, touchAction: 'none', cursor: img ? 'grab' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {imgUrl && (
            <img
              src={imgUrl}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: renderedW || 'auto',
                height: renderedH || 'auto',
                transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            />
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>{t('avatar_cropper.zoom')}</span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={e => setZoom(parseFloat(e.target.value))}
            className="flex-1 accent-yellow-500"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer ${
              isDark ? 'text-white/80 hover:bg-white/10' : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!img}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-yellow-500 text-black hover:bg-yellow-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {t('avatar_cropper.btn.save')}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default AvatarCropperModal
