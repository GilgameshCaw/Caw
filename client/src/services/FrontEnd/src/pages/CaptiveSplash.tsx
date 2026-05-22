import { Link } from '~/utils/localizedRouter'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { useActiveToken } from '~/store/tokenDataStore'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import BoidsBg from '~/components/BoidsBg'
import LandingHeader from '~/components/landing/LandingHeader'
import LandingFooter from '~/components/landing/LandingFooter'

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

  // Header backing: transparent over the hero, fades in a translucent
  // blurred strip once the user scrolls past the top so the header
  // elements don't float over the scrolling content.
  const [scrolled, setScrolled] = useState(false)

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
    <div
      className={`h-[100svh] overflow-y-auto overflow-x-hidden snap-y snap-mandatory relative ${isDark ? 'bg-black text-white' : 'bg-white text-black'}`}
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 24)}
    >
      <BoidsBg isDark={isDark} />
      {/* Translucent blurred strip behind the header — hidden over the
          hero, fades in once scrolled. z-20 so it paints above the
          content sections (which are also z-10); the header clusters are
          z-20 too but come later in the DOM, so they stay on top. */}
      <div
        className={`fixed top-0 left-0 right-0 h-[4.75rem] z-20 pointer-events-none border-b backdrop-blur transition-opacity duration-200 ${
          scrolled ? 'opacity-100' : 'opacity-0'
        } ${isDark ? 'bg-black/95 border-white/10' : 'bg-white/95 border-gray-200'}`}
      />
      {/* Shared landing header — logo lockup + resource links + language
          picker. Same component used by ManifestoPage. */}
      <LandingHeader fixed />
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
      <LandingFooter className="snap-start" />
    </div>
  )
}
