// StyledQR — a single QR renderer used everywhere in the app (wallet deposit
// address, invite links, profile share card, staking). Replaces the
// per-callsite `qrcode` data-URL generators with one component backed by
// `qr-code-styling`, rendering circular ("dots") modules.
//
// SCANNABILITY INVARIANT: always black-on-white with a quiet-zone margin,
// regardless of app theme. A themed (e.g. low-contrast) QR can fail to scan;
// the modules' shape is cosmetic, the contrast is not.
//
// The library mutates the DOM (appends an <svg>), so it must run client-side
// inside an effect against a ref'd container — there is no SSR path here.

import React from 'react'
import QRCodeStyling from 'qr-code-styling'

export interface StyledQRProps {
  /** The string encoded into the QR (URL, address, invite link, …). */
  value: string
  /** Pixel size of the (square) QR. Default 192. */
  size?: number
  /** Optional className on the wrapper div. */
  className?: string
  /**
   * Optional ref to the underlying QRCodeStyling instance so a parent can call
   * `.download({ name, extension })`. Populated after first render.
   */
  instanceRef?: React.MutableRefObject<QRCodeStyling | null>
}

// Circular-dot modules, with finder-pattern corners that visually agree with
// the dotted body.
function buildOptions(value: string, size: number) {
  return {
    width: size,
    height: size,
    type: 'svg' as const,
    data: value,
    margin: Math.max(4, Math.round(size * 0.04)), // quiet zone (~1 module-ish)
    qrOptions: { errorCorrectionLevel: 'M' as const },
    dotsOptions: { type: 'dots' as const, color: '#000000' },
    cornersSquareOptions: { type: 'extra-rounded' as const, color: '#000000' },
    cornersDotOptions: { type: 'dot' as const, color: '#000000' },
    backgroundOptions: { color: '#FFFFFF' },
  }
}

export default function StyledQR({ value, size = 192, className, instanceRef }: StyledQRProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const qrRef = React.useRef<QRCodeStyling | null>(null)

  // Create the instance once and append it to the container.
  React.useEffect(() => {
    if (!containerRef.current) return
    const qr = new QRCodeStyling(buildOptions(value, size))
    qrRef.current = qr
    if (instanceRef) instanceRef.current = qr
    containerRef.current.innerHTML = '' // guard against double-append in StrictMode
    qr.append(containerRef.current)
    return () => {
      if (instanceRef) instanceRef.current = null
      qrRef.current = null
    }
    // Intentionally create-once; subsequent prop changes go through .update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reactively update on value / size changes (don't recreate).
  React.useEffect(() => {
    qrRef.current?.update(buildOptions(value, size))
  }, [value, size])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: size, height: size, lineHeight: 0 }}
      aria-label="QR code"
    />
  )
}
