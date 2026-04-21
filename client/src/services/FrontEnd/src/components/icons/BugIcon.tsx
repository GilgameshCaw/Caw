import React from 'react'

const BugIcon: React.FC<{ className?: string }> = ({ className = 'w-[18px] h-[18px]' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="7.5" r="2.5" fill="currentColor" />
    <path d="M10.5 5.5L9 2.5" /><path d="M13.5 5.5L15 2.5" />
    <ellipse cx="12" cy="15.5" rx="6" ry="6.5" fill="currentColor" opacity="0.15" />
    <ellipse cx="12" cy="15.5" rx="6" ry="6.5" />
    <line x1="12" y1="9" x2="12" y2="22" />
    <circle cx="9.5" cy="13" r="1.2" fill="currentColor" /><circle cx="14.5" cy="13" r="1.2" fill="currentColor" />
    <circle cx="10" cy="17.5" r="1.2" fill="currentColor" /><circle cx="14" cy="17.5" r="1.2" fill="currentColor" />
    <path d="M6.5 12.5L4 11" /><path d="M6 15.5L3.5 16" /><path d="M6.5 18.5L4.5 20.5" />
    <path d="M17.5 12.5L20 11" /><path d="M18 15.5L20.5 16" /><path d="M17.5 18.5L19.5 20.5" />
  </svg>
)

export default BugIcon
