import React from 'react'

interface QuickSignHowItWorksProps {
  isDark?: boolean
}

/**
 * Shared "How it works" content for Quick Sign — used in Settings and onboarding.
 */
const QuickSignHowItWorks: React.FC<QuickSignHowItWorksProps> = ({ isDark = true }) => {
  return (
    <div className={`rounded-lg p-4 text-sm border ${
      isDark ? 'bg-yellow-900/20 border-yellow-700/50' : 'bg-yellow-50/80 border-yellow-200 shadow-xl'
    }`}>
      <p className={`font-medium ${isDark ? 'text-yellow-400' : 'text-gray-900'}`}>How it works</p>
      <p className={`mt-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
        Quick Sign creates a temporary signing key stored in your browser.
        It can post, like, repost, and follow on your behalf.
      </p>
      <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
        It <strong>cannot withdraw tokens or transfer your name</strong>, but:
      </p>
      <ul className={`space-y-1 list-disc list-outside pl-5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
        <li>Evil browser extensions with permission can access your staked CAW until key expiry or finished spending limit</li>
        <li>Transferring your name automatically invalidates it</li>
        <li>The key expires automatically after the chosen duration</li>
        <li>You can revoke it at any time</li>
      </ul>
    </div>
  )
}

export default QuickSignHowItWorks
