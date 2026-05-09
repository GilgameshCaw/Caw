import React, { useEffect, useMemo, useRef, useState } from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

interface CoverCropperModalProps {
  isOpen: boolean
  file: File | null
  onCrop: (cropped: File) => void
  onClose: () => void
}

// Cover photo displays at 570×180 (≈3.17:1). Output 1140×360 (2× retina)
// so the downstream `cover` compressor preset (max 1140 wide, 0.5MB)
// gets a clean 1× downscale to land at the display size without an
// upscale step from a too-small input.
const VIEW_W = 320
const ASPECT = 570 / 180
const VIEW_H = Math.round(VIEW_W / ASPECT)
const OUTPUT_W = 1140
const OUTPUT_H = Math.round(OUTPUT_W / ASPECT)
const MIN_ZOOM = 1
const MAX_ZOOM = 4

const CoverCropperModal: React.FC<CoverCropperModalProps> = ({ isOpen, file, onCrop, onClose }) => {
  const { isDark } = useTheme()
  const t = useT()
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!file) { setImgUrl(null); setImg(null); return }
    const url = URL.createObjectURL(file)
    setImgUrl(url)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (!imgUrl) return
    const el = new Image()
    el.onload = () => setImg(el)
    el.src = imgUrl
  }, [imgUrl])

  // Cover the rect view: scale so the image fills both dimensions, take
  // the larger of the two ratios. Then user-zoom multiplies on top.
  const baseScale = useMemo(() => {
    if (!img) return 1
    return Math.max(VIEW_W / img.naturalWidth, VIEW_H / img.naturalHeight)
  }, [img])

  const renderedW = img ? img.naturalWidth * baseScale * zoom : 0
  const renderedH = img ? img.naturalHeight * baseScale * zoom : 0

  // Clamp pan so the rendered image always covers the rect — no gaps.
  const clampPan = (x: number, y: number) => {
    const maxX = Math.max(0, (renderedW - VIEW_W) / 2)
    const maxY = Math.max(0, (renderedH - VIEW_H) / 2)
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    }
  }

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
    const scale = baseScale * zoom
    const cropSrcW = VIEW_W / scale
    const cropSrcH = VIEW_H / scale
    const cx = img.naturalWidth / 2 - pan.x / scale
    const cy = img.naturalHeight / 2 - pan.y / scale
    const sx = Math.max(0, cx - cropSrcW / 2)
    const sy = Math.max(0, cy - cropSrcH / 2)
    const sW = Math.min(cropSrcW, img.naturalWidth - sx)
    const sH = Math.min(cropSrcH, img.naturalHeight - sy)

    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_W
    canvas.height = OUTPUT_H
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, sx, sy, sW, sH, 0, 0, OUTPUT_W, OUTPUT_H)
    const blob: Blob | null = await new Promise(resolve =>
      canvas.toBlob(resolve, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.95),
    )
    if (!blob) return
    const cropped = new File([blob], file.name, { type: blob.type, lastModified: Date.now() })
    onCrop(cropped)
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-md" closeOnClickOutside={false}>
      <div className="p-5 space-y-4">
        <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-black'}`}>
          {t('cover_cropper.title')}
        </h3>

        <div
          ref={viewRef}
          className={`relative mx-auto overflow-hidden rounded-lg select-none ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}
          style={{ width: VIEW_W, height: VIEW_H, touchAction: 'none', cursor: img ? 'grab' : 'default' }}
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
          <span className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>{t('cover_cropper.zoom')}</span>
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
            {t('cover_cropper.btn.save')}
          </button>
        </div>
      </div>
    </ModalWrapper>
  )
}

export default CoverCropperModal
