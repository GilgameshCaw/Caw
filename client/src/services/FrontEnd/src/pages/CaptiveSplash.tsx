import { Link } from '~/utils/localizedRouter'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { useActiveToken } from '~/store/tokenDataStore'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import BoidsBg from '~/components/BoidsBg'
import LanguageSwitcher from '~/components/LanguageSwitcher'
import WalletAccountButton from '~/components/buttons/WalletAccountButton'
import { HiDocumentText } from 'react-icons/hi'

const Caw3D = lazy(() => import('~/components/Caw3D'))
const Features = lazy(() => import('~/components/landing/Features'))
const Community = lazy(() => import('~/components/landing/Community'))
const FreeSpeech = lazy(() => import('~/components/landing/FreeSpeech'))
const Cawmmunity = lazy(() => import('~/components/landing/Cawmmunity'))

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

  const [keywordIndex, setKeywordIndex] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
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
    <div className={`h-[100svh] overflow-y-auto overflow-x-hidden snap-y snap-mandatory relative ${isDark ? 'bg-black text-white' : 'bg-white text-black'}`}>
      <BoidsBg isDark={isDark} />
      {/* Language picker — top-right so a non-English visitor can pick
          their language before reading anything else. Persisted in
          localStorage; promoted to User.preferredLanguage post-mint. */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
        {/* Whitepaper CTA: icon on mobile, text button on md+. */}
        <Link
          to="/help/whitepaper"
          className="inline-flex md:hidden items-center justify-center w-9 h-9 rounded-md border border-white/20 bg-black/40 text-white transition-colors hover:bg-white hover:text-black hover:border-white"
          aria-label="Open whitepaper"
          title="Whitepaper"
        >
          <HiDocumentText className="w-5 h-5" />
        </Link>
        <Link
          to="/help/whitepaper"
          className="hidden md:inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-white/20 bg-black/40 text-white text-sm font-semibold transition-colors hover:bg-white hover:text-black hover:border-white"
        >
          <HiDocumentText className="w-4 h-4" />
          Whitepaper
        </Link>
        <LanguageSwitcher />
      </div>
      {/* Wallet pill — top-left. Lets a connected user reach the account
          modal (and Disconnect) when no other chrome is rendered on this
          captive page. Hidden when no wallet connected — the page's own
          "Sign In" CTA leads that case. */}
      <div className="absolute top-3 left-3 z-20">
        <WalletAccountButton />
      </div>
      {/* Hero — one full viewport, snaps so only the hero shows at top */}
      <div className="min-h-[100svh] snap-start flex flex-col items-center justify-center px-6 py-6 relative z-10">
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

        {/* CTA buttons (mobile: side-by-side) */}
        <div className="flex flex-row items-center justify-center gap-3 sm:gap-4 mb-12">
          {!isConnected ? (
            <button
              onClick={openConnectModal}
              className="px-5 sm:px-8 py-3 bg-yellow-500 text-black font-bold text-base sm:text-lg rounded-full hover:bg-yellow-400 transition-all shadow-lg hover:shadow-xl cursor-pointer whitespace-nowrap"
            >
              {t('common.sign_in')}
            </button>
          ) : !activeToken?.username ? (
            <Link
              to="/usernames/new"
              className="px-5 sm:px-8 py-3 bg-yellow-500 text-black font-bold text-base sm:text-lg rounded-full hover:bg-yellow-400 transition-all shadow-lg hover:shadow-xl whitespace-nowrap"
            >
              {t('main_layout.create_profile')}
            </Link>
          ) : (
            <Link
              to="/home"
              className="px-5 sm:px-8 py-3 bg-yellow-500 text-black font-bold text-base sm:text-lg rounded-full hover:bg-yellow-400 transition-all shadow-lg hover:shadow-xl whitespace-nowrap"
            >
              {t('captive_splash.go_to_feed')}
            </Link>
          )}

          <Link
            to="/help/faq"
            className={`px-5 sm:px-8 py-3 font-semibold text-base sm:text-lg rounded-full border transition-all whitespace-nowrap ${
              isDark
                ? 'border-white/20 text-white/80 hover:bg-white/10'
                : 'border-gray-300 text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t('main_layout.learn_more')}
          </Link>
        </div>


      </div>

      {/* Landing sections ported from caw-landing (below the hero/CTA).
          Each section is one full viewport + snap-start so scrolling
          settles on exactly one module at a time. */}
      <div className="min-h-[100svh] snap-start flex flex-col justify-center relative z-10">
        <Suspense fallback={<div className="py-20" />}>
          <Features />
        </Suspense>
      </div>

      <div className="min-h-[100svh] snap-start flex flex-col justify-center relative z-10">
        <Suspense fallback={<div className="py-20" />}>
          <Community />
        </Suspense>
      </div>

      <div className="min-h-[100svh] snap-start flex flex-col justify-center relative z-10">
        <Suspense fallback={<div className="py-20" />}>
          <FreeSpeech />
        </Suspense>
      </div>

      <div className="min-h-[100svh] snap-start flex flex-col justify-center relative z-10">
        <Suspense fallback={<div className="py-20" />}>
          <Cawmmunity />
        </Suspense>
      </div>

      {/* Footer - resource links */}
      <footer className={`snap-start border-t py-8 px-6 relative z-10 backdrop-blur-[2px] ${isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white/10'}`}>
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
