import React from 'react'
import { useTheme } from '~/hooks/useTheme'
import Avatar from '~/components/Avatar'
import cawLogo from '~/assets/images/caw-logo.png'
import { FlipCard } from './FlipCard'

export type ShareProfileCardProps = {
  username: string
  displayName?: string
  avatarSrc: string
  profilePath: string
}

export const ShareProfileCard: React.FC<ShareProfileCardProps> = ({ username, displayName, avatarSrc, profilePath }) => {
  const { isDark } = useTheme()
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null)
  const profileUrl = `${window.location.origin}${profilePath}`

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const mod = await import('qrcode')
        const toDataURL = (mod as any).toDataURL as ((text: string, opts: any) => Promise<string>) | undefined
        if (!toDataURL) throw new Error('qrcode.toDataURL missing (bad import shape)')

        const url = await toDataURL(profileUrl, {
          margin: 1,
          errorCorrectionLevel: 'M',
          color: {
            // Always black-on-white for scan reliability
            dark: '#000000',
            light: '#FFFFFF'
          }
        })
        if (!cancelled) setQrDataUrl(url)
      } catch (err) {
        console.error('QR generation failed:', err)
        if (!cancelled) setQrDataUrl(null)
      }
    })()
    return () => { cancelled = true }
  }, [profileUrl, isDark])

  return (
    <FlipCard
      className="select-none"
      front={
        <div
          className={[
            'h-full w-full rounded-2xl border shadow-[0_8px_14px_0_rgba(0,0,0,0.20)]',
            'flex flex-col items-center justify-center px-6',
            isDark
              ? 'border-[#2a2a2a] bg-gradient-to-br from-[#0b0b0b] via-[#111] to-[#0b0b0b] text-white'
              : 'border-[#e5e7eb] bg-gradient-to-br from-white via-[#fafafa] to-[#f5f5f5] text-gray-900'
          ].join(' ')}
        >
          <div className="flex flex-col items-center">
            <img
              src={cawLogo}
              alt="CAW Logo"
              width={88}
              height={88}
              decoding="sync"
              loading="eager"
              fetchPriority="high"
              className={['w-[88px] h-[88px] object-contain', isDark ? '' : 'drop-shadow-[1px_1px_1px_rgba(0,0,0,0.8)]'].join(' ')}
            />
            <span
              className="mt-1 text-[2.5rem]"
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 800,
                color: '#ebc046',
                letterSpacing: '3px',
                textShadow: isDark
                  ? '0 1px 2px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3)'
                  : 'rgba(0,0,0,1) 0.5px 0.5px 1px, rgba(0,0,0,0.3) 1.5px 1.5px 1px, rgba(240,177,0,1) 0px 0px 3px'
              }}
            >
              CAW
            </span>
          </div>

          <p className={['mt-2 text-center text-sm font-semibold', isDark ? 'text-white/90' : 'text-gray-800'].join(' ')}>
            Decentralized Social Clearing House
          </p>
        </div>
      }
      back={
        <div
          className={[
            'h-full w-full rounded-2xl border shadow-[0_8px_14px_0_rgba(0,0,0,0.20)]',
            'relative flex flex-col items-center justify-center px-6',
            isDark
              ? 'border-[#2a2a2a] bg-gradient-to-br from-[#ebc046] via-black to-[#ebc046] text-white'
              : 'border-[#e5e7eb] bg-gradient-to-br from-[#ffe9a5] via-white to-[#ffe3a0] text-gray-900'
          ].join(' ')}
        >
          {/* NFT preview corner mark */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="20 20 70 70"
            className="absolute top-4 left-4 w-14 h-14"
            aria-hidden="true"
          >
            <path
              d="M30.36,35.15l15.28,1.29a7.47,7.47,0,0,0,5.29-3l-1.84-7.27a33,33,0,0,1,8.77,0L56,33.42s1.69,3.13,6.6,2.94c.75,0,14-1.25,14-1.25L69.15,45.52l-5.73.54a9.57,9.57,0,0,1-4.11-.29,10.59,10.59,0,0,1-3-1.63L53.47,50.6l-2.73-6.45a10.13,10.13,0,0,0-1.52.88c-2,1.36-5.49,1.08-5.49,1.08l-5.82-.48Z"
              fill="#000000"
            />
            <path
              d="M48.32,84.39,41.8,70.51a7.45,7.45,0,0,0-5.25-3.07l-5.39,5.22a33.26,33.26,0,0,1-4.4-7.58L34,63s1.86-3-.75-7.18c-.4-.63-8.06-11.48-8.06-11.48l12.72,1.23,3.33,4.69A9.54,9.54,0,0,1,43.05,54a10.71,10.71,0,0,1,.09,3.41l7-.76-4.22,5.59a10.44,10.44,0,0,0,1.52.86c2.19,1.08,3.67,4.22,3.67,4.22l2.5,5.28Z"
              fill="#000000"
            />
            <path
              d="M82,44.21,73.25,56.8a7.46,7.46,0,0,0,0,6.09l7.22,2a32.65,32.65,0,0,1-4.36,7.6l-5.39-5.26s-3.55-.1-5.85,4.25c-.35.66-5.9,12.72-5.9,12.72l-5.3-11.64L56,67.39A9.69,9.69,0,0,1,58.34,64a10.82,10.82,0,0,1,2.9-1.78L57.07,56.5l6.95.86a11.11,11.11,0,0,0,0-1.76c-.17-2.43,1.81-5.29,1.81-5.29l3.32-4.8Z"
              fill="#000000"
            />
          </svg>

          <div className="flex flex-col items-center">
            <div className="w-20 h-20 rounded-full overflow-hidden">
              <Avatar src={avatarSrc} alt={displayName ?? username} className="w-full h-full" size="small" />
            </div>
            <p className={['mt-4 text-3xl font-black tracking-tight text-center', isDark ? 'text-white' : 'text-gray-900'].join(' ')}>
              {displayName ?? `@${username}`}
            </p>

            <div className="mt-4 rounded-lg overflow-hidden bg-transparent">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Profile QR"
                  className="w-[168px] h-[168px] block"
                />
              ) : (
                <div className={['w-[168px] h-[168px] flex items-center justify-center text-sm font-medium', isDark ? 'text-white' : 'text-gray-800'].join(' ')}>
                  Generating QR…
                </div>
              )}
            </div>
          </div>
        </div>
      }
    />
  )
}
