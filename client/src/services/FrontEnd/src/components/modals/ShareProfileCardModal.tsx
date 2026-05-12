import React, { useEffect, useState } from 'react'
import { ShareProfileCard } from '~/components/share/ShareProfileCard'
import { useTheme } from '~/hooks/useTheme'
import { ShareModal } from '~/components/ShareModal'
import { HiShare } from 'react-icons/hi'
import { useLayoutStore } from '~/store/layoutStore'
import { acquireScrollLock, releaseScrollLock } from '~/utils/scrollLock'

type ShareProfileCardModalProps = {
  isOpen: boolean
  onClose: () => void
  username: string
  displayName?: string
  avatarSrc: string
  /** Pass the user's deterministic default avatar URL so the share
   *  card never surfaces the broken-image silhouette. */
  avatarFallbackSrc?: string
  profilePath: string
}

export const ShareProfileCardModal: React.FC<ShareProfileCardModalProps> = ({
  isOpen,
  onClose,
  username,
  displayName,
  avatarSrc,
  avatarFallbackSrc,
  profilePath
}) => {
  const { isDark } = useTheme()
  const [showShareModal, setShowShareModal] = useState(false)
  const setHideMobileNavOverride = useLayoutStore(s => s.setHideMobileNavOverride)
  // Keep a stable string around (future: can be used for copy/share text)
  const _profileUrl = `${window.location.origin}${profilePath}`

  useEffect(() => {
    if (!isOpen) return
    setShowShareModal(false)

    // Mobile-only: hide bottom nav + FAB while overlay is open.
    const isMobile = window.matchMedia('(max-width: 767px)').matches
    if (isMobile) setHideMobileNavOverride(true)

    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    acquireScrollLock()
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      releaseScrollLock()
      if (isMobile) setHideMobileNavOverride(false)
    }
  }, [isOpen, onClose, setHideMobileNavOverride])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 transition-opacity"
        onMouseDown={onClose}
      />

      {/* Card + action container */}
      <div
        className="fixed inset-0 z-50 px-4 flex items-center justify-center"
        onMouseDown={onClose}
        onTouchStart={onClose}
      >
        {/* Desktop: stack card + button together. Mobile: keep card centered, button fixed bottom. */}
        <div
          className="w-full max-w-[420px] flex flex-col items-center md:gap-4"
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <div className="flex justify-center -translate-y-[3vh] md:-translate-y-[6vh]">
            <ShareProfileCard
              username={username}
              displayName={displayName}
              avatarSrc={avatarSrc}
              avatarFallbackSrc={avatarFallbackSrc}
              profilePath={profilePath}
            />
          </div>

          <div className="hidden md:flex justify-center -translate-y-[6vh]">
            <button
              type="button"
              onClick={() => setShowShareModal(true)}
              className={[
                'share-profile-btn px-7 py-3 rounded-full font-semibold border text-sm transition-colors duration-200',
                'bg-yellow-500 text-black border-yellow-500'
              ].join(' ')}
            >
              <span className="inline-flex items-center gap-2">
                <HiShare className="w-5 h-5" />
                Share profile
              </span>
            </button>
          </div>
        </div>

        {/* Mobile fixed bottom action */}
        <div
          className="md:hidden fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+7.5rem)] z-[60] flex justify-center px-4"
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setShowShareModal(true)}
            className={[
              'w-auto max-w-[260px] px-4 py-2.5 rounded-full font-semibold border text-sm',
              'bg-yellow-500 text-black border-yellow-500'
            ].join(' ')}
          >
            <span className="inline-flex items-center justify-center gap-2">
              <HiShare className="w-5 h-5" />
              Share profile
            </span>
          </button>
        </div>

        <style>{`
          @media (hover: hover) and (pointer: fine) {
            .share-profile-btn { cursor: pointer; }
            .share-profile-btn:hover { background: #f2cf5a; border-color: #f2cf5a; }
          }
        `}</style>
      </div>

      <ShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        url={profilePath}
        title={`${displayName ?? '@' + username}'s profile`}
      />
    </>
  )
}
