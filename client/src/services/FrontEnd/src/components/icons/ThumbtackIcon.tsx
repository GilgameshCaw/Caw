import React from 'react'

/**
 * Shared thumbtack/pin icon used by:
 *   - AccountSettings: per-profile pin button in the All Usernames list
 *   - FeedItem: pin/unpin menu item + the "Pinned" badge above the bubble
 *
 * Source: noun-project "pin" by Adrien Coquet (CC). Original viewBox is
 * 0 0 100 125; we crop to 20 20 60 60 so the icon fills its container
 * without the source's empty bottom padding.
 */
export const ThumbtackIcon: React.FC<React.SVGProps<SVGSVGElement>> = ({ className = 'w-5 h-5', ...rest }) => (
  <svg className={className} fill="currentColor" viewBox="20 20 60 60" {...rest}>
    <path d="M77.1,46c-1.5,1.7-3.8,2.1-5.8,1.4c-0.7-0.3-1.6-0.1-2.1,0.4L57.4,59.6c-0.6,0.6-0.7,1.4-0.4,2.1c0.8,2,0.3,4.3-1.4,5.8c-2.1,1.9-5.4,1.6-7.4-0.4L32.8,51.8c-2-2-2.3-5.3-0.4-7.4c1.5-1.7,3.9-2.2,5.8-1.4c0.7,0.3,1.6,0.1,2.1-0.4l11.7-11.7c0.6-0.6,0.7-1.4,0.5-2.1c-0.8-2-0.3-4.3,1.4-5.8c2.1-1.9,5.4-1.6,7.4,0.4l15.3,15.3C78.7,40.6,79,43.9,77.1,46z" />
    <path d="M41.8,62.7l-4.5-4.5c-0.3-0.3-0.7-0.5-1.2-0.4c-0.4,0-0.8,0.3-1.1,0.6L21.9,76c-0.5,0.6-0.4,1.4,0.1,2s1.4,0.6,2,0.1L41.6,65c0.3-0.3,0.6-0.7,0.6-1.1C42.2,63.5,42.1,63,41.8,62.7z" />
  </svg>
)
