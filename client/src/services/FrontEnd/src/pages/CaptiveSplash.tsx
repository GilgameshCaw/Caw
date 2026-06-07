import { Link, useNavigate } from '~/utils/localizedRouter'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { useActiveToken } from '~/store/tokenDataStore'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import BoidsBg from '~/components/BoidsBg3D'
import LanguageSwitcher from '~/components/LanguageSwitcher'
import WalletAccountButton from '~/components/buttons/WalletAccountButton'
import { SignInChoiceModal } from '~/components/identity/SignInChoiceModal'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'

const Caw3D = lazy(() => import('~/components/Caw3D'))

const KEYWORD_KEYS = [
  'captive_splash.kw.permissionless',
  'captive_splash.kw.unstoppable',
  'captive_splash.kw.censorship_resistant',
  'captive_splash.kw.on_chain',
  'captive_splash.kw.decentralized',
  'captive_splash.kw.trustless',
  'captive_splash.kw.sovereign',
  'captive_splash.kw.unbreakable',
]

export default function CaptiveSplash() {
  const { isDark } = useTheme()
  const t = useT()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const activeToken = useActiveToken()
  const { isInRecoveryMode } = useRecoveryContext()
  const navigate = useNavigate()

  const [keywordIndex, setKeywordIndex] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const [showSignInChoice, setShowSignInChoice] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setIsAnimating(true)
      setTimeout(() => {
        setKeywordIndex(i => (i + 1) % KEYWORD_KEYS.length)
        setIsAnimating(false)
      }, 400)
    }, 3000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  return (
    <div className={`min-h-screen flex flex-col relative overflow-hidden ${isDark ? 'bg-black text-white' : 'bg-white text-black'}`}>
      <BoidsBg isDark={isDark} />
      {/* Language picker — top-right so a non-English visitor can pick
          their language before reading anything else. Persisted in
          localStorage; promoted to User.preferredLanguage post-mint. */}
      <div className="absolute top-3 right-3 z-20">
        <LanguageSwitcher />
      </div>
      {/* Wallet pill — top-left. Lets a connected user reach the account
          modal (and Disconnect) when no other chrome is rendered on this
          captive page. Hidden when no wallet connected — the page's own
          "Sign In" CTA leads that case. */}
      <div className="absolute top-3 left-3 z-20">
        <WalletAccountButton />
      </div>
      {/* Main content - centered */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-6 relative z-10">
        {/* 3D Crow shape — lazy loaded */}
        <Suspense fallback={
          <div className="my-1 w-64 h-64 md:w-80 md:h-72" />
        }>
          <Caw3D className="my-1 w-64 h-64 md:w-80 md:h-72" isDark={isDark} />
        </Suspense>

        {/* Tagline */}
        <h1 className="text-3xl md:text-5xl font-bold text-center mb-4 max-w-3xl leading-tight">
          {t('captive_splash.tagline_prefix')}
          <br />
          <span
            className={`text-yellow-500 inline-block text-[2.7rem] md:text-7xl whitespace-nowrap transition-all duration-400 ${
              isAnimating
                ? 'opacity-0 translate-y-3'
                : 'opacity-100 translate-y-0'
            }`}
          >
            {t(KEYWORD_KEYS[keywordIndex])}
          </span>
          <br />
          {t('captive_splash.tagline_suffix')}
        </h1>

        <p className={`text-center text-lg md:text-xl mb-10 max-w-lg ${
          isDark ? 'text-white/60' : 'text-gray-500'
        }`}>
          {t('captive_splash.subtitle')}
        </p>

        {/* CTA buttons */}
        <div className="flex flex-col items-center gap-4 mb-12">
          <div className="flex flex-col sm:flex-row items-center gap-4">
          {!isConnected && !isInRecoveryMode ? (
            <button
              onClick={() => setShowSignInChoice(true)}
              className="px-8 py-3 bg-yellow-500 text-black font-bold text-lg rounded-full hover:bg-yellow-400 transition-all shadow-lg hover:shadow-xl cursor-pointer"
            >
              {t('common.sign_in')}
            </button>
          ) : !activeToken?.username ? (
            <Link
              to="/usernames/new"
              className="px-8 py-3 bg-yellow-500 text-black font-bold text-lg rounded-full hover:bg-yellow-400 transition-all shadow-lg hover:shadow-xl"
            >
              {t('main_layout.create_profile')}
            </Link>
          ) : (
            <Link
              to="/home"
              className="px-8 py-3 bg-yellow-500 text-black font-bold text-lg rounded-full hover:bg-yellow-400 transition-all shadow-lg hover:shadow-xl"
            >
              {t('captive_splash.go_to_feed')}
            </Link>
          )}

          <Link
            to="/help/faq"
            className={`px-8 py-3 font-semibold text-lg rounded-full border transition-all ${
              isDark
                ? 'border-white/20 text-white/80 hover:bg-white/10'
                : 'border-gray-300 text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t('main_layout.learn_more')}
          </Link>
          </div>
        </div>

        {/* Sign-in chooser modal */}
        <SignInChoiceModal
          open={showSignInChoice}
          onClose={() => setShowSignInChoice(false)}
          onWalletPath={() => openConnectModal?.()}
          onPasskeyPath={() => navigate('/onboarding')}
        />

        {/* Feature highlights */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-2xl w-full mb-12">
          <div className="text-center">
            <div className={`w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center ${
              isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'
            }`}>
              <svg className="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h3 className="font-semibold mb-1">{t('captive_splash.feature1.title')}</h3>
            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              {t('captive_splash.feature1.body')}
            </p>
          </div>

          <div className="text-center">
            <div className={`w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center ${
              isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'
            }`}>
              <svg className="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
              </svg>
            </div>
            <h3 className="font-semibold mb-1">{t('captive_splash.feature2.title')}</h3>
            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              {t('captive_splash.feature2.body')}
            </p>
          </div>

          <div className="text-center">
            <div className={`w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center ${
              isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'
            }`}>
              <svg className="w-6 h-6 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <h3 className="font-semibold mb-1">{t('captive_splash.feature3.title')}</h3>
            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              {t('captive_splash.feature3.body')}
            </p>
          </div>
        </div>


      </div>

      {/* Footer - resource links */}
      <footer className={`border-t py-8 px-6 relative z-10 backdrop-blur-[2px] ${isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white/10'}`}>
        <div className="max-w-2xl mx-auto">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm">
            <Link to="/help/faq" className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}>{t('captive_splash.footer.faq')}</Link>
            <Link to="/help/manifesto" className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}>{t('captive_splash.footer.manifesto')}</Link>
            <Link to="/help/history" className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}>{t('captive_splash.footer.history')}</Link>
            <Link to="/help/howto" className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}>{t('captive_splash.footer.how_it_works')}</Link>
            <Link to="/help/developers" className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}>{t('captive_splash.footer.developers')}</Link>
            <Link to="/help/resources" className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}>{t('captive_splash.footer.resources')}</Link>
            <Link to="/faucet" className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}>{t('captive_splash.footer.faucet')}</Link>
          </div>
          <p className={`text-center text-xs mt-4 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
            {t('captive_splash.footer.tagline')}
          </p>
        </div>
      </footer>
    </div>
  )
}
