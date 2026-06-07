import { Link, useNavigate } from '~/utils/localizedRouter'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { useActiveToken } from '~/store/tokenDataStore'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { HiChevronDown } from 'react-icons/hi'
import BoidsBg from '~/components/BoidsBg3D'
import LanguageSwitcher from '~/components/LanguageSwitcher'
import WalletAccountButton from '~/components/buttons/WalletAccountButton'
import { SignInChoiceModal } from '~/components/identity/SignInChoiceModal'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
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
  const { isInRecoveryMode } = useRecoveryContext()
  const navigate = useNavigate()

  const [keywordIndex, setKeywordIndex] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const [showSignInChoice, setShowSignInChoice] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Surface a compact Sign-in button in the LandingHeader's right cluster
  // once the hero CTA has scrolled out of view, so the user always has
  // a one-tap path back to sign-in without scrolling back to the top.
  const heroCtaRef = useRef<HTMLDivElement | null>(null)
  const [heroCtaOut, setHeroCtaOut] = useState(false)
  // First content section below the hero — the down-arrow scrolls here.
  const featuresRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = heroCtaRef.current
    if (!el) return
    // Root null = use the viewport (the scroll container is the page
    // root :100svh div, but IntersectionObserver against that root works
    // identically here since the CTA lives inside it).
    const io = new IntersectionObserver(
      ([entry]) => setHeroCtaOut(!entry.isIntersecting),
      { threshold: 0 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

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
      className={`h-[100svh] overflow-y-auto overflow-x-hidden relative ${isDark ? 'bg-black text-white' : 'bg-white text-black'}`}
    >
      <BoidsBg isDark={isDark} />
      {/* Shared landing header — logo lockup + resource links + language
          picker. Same component used by ManifestoPage. Once the hero CTA
          has scrolled off-screen, surface a compact Sign-in / Create /
          Go-to-feed action in the right cluster so the user always has
          a one-tap path back to the primary CTA. */}
      <LandingHeader
        fixed
        rightExtra={heroCtaOut && (
          !isConnected && !isInRecoveryMode ? (
            <button
              onClick={() => setShowSignInChoice(true)}
              className="px-3 sm:px-4 py-1.5 bg-yellow-500 text-black font-bold text-sm rounded-full hover:bg-yellow-400 transition-all shadow cursor-pointer whitespace-nowrap"
            >
              {t('common.sign_in')}
            </button>
          ) : !activeToken?.username ? (
            <Link
              to="/usernames/new"
              className="px-3 sm:px-4 py-1.5 bg-yellow-500 text-black font-bold text-sm rounded-full hover:bg-yellow-400 transition-all shadow whitespace-nowrap"
            >
              {t('main_layout.create_profile')}
            </Link>
          ) : (
            <Link
              to="/home"
              className="px-3 sm:px-4 py-1.5 bg-yellow-500 text-black font-bold text-sm rounded-full hover:bg-yellow-400 transition-all shadow whitespace-nowrap"
            >
              {t('captive_splash.go_to_feed')}
            </Link>
          )
        )}
      />
      {/* Hero — one full viewport, snaps so only the hero shows at top */}
      <div className="min-h-[100svh] flex flex-col items-center justify-center px-6 py-6 relative z-10">
        {/* 3D Crow shape — lazy loaded */}
        <Suspense fallback={
          <div className="my-1 w-64 h-64 md:w-80 md:h-72" />
        }>
          <Caw3D className="my-1 w-64 h-64 md:w-80 md:h-72 translate-y-3" isDark={isDark} />
        </Suspense>

        {/* Tagline */}
        <h1 className="text-3xl md:text-5xl font-bold text-center mb-4 max-w-3xl leading-tight">
          {t('captive_splash.tagline_prefix')}
          <br />
          <span
            className={`text-yellow-500 inline-block text-[2.15rem] md:text-7xl whitespace-nowrap transition-all duration-400 ${
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
        <div ref={heroCtaRef} className="flex flex-col items-center gap-4 mb-12">
          <div className="flex flex-row items-center justify-center gap-3 sm:gap-4">
          {!isConnected && !isInRecoveryMode ? (
            <button
              onClick={() => setShowSignInChoice(true)}
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

        {/* Sign-in chooser modal */}
        <SignInChoiceModal
          open={showSignInChoice}
          onClose={() => setShowSignInChoice(false)}
          onWalletPath={() => openConnectModal?.()}
          onPasskeyPath={() => navigate('/onboarding')}
        />

        {/* Scroll cue — a gently bouncing down-arrow at the bottom of the hero
            so it's clear there's more below. Clicking scrolls to the first
            content section. Fades out once the user has scrolled past the hero. */}
        <button
          type="button"
          aria-label={t('captive_splash.scroll_down') || 'Scroll down'}
          onClick={() => featuresRef.current?.scrollIntoView({ behavior: 'smooth' })}
          className={`absolute bottom-6 left-1/2 -translate-x-1/2 z-20 p-2 rounded-full transition-opacity duration-300 animate-bounce ${
            heroCtaOut ? 'opacity-0 pointer-events-none' : 'opacity-70 hover:opacity-100'
          } ${isDark ? 'text-white' : 'text-black'}`}
        >
          <HiChevronDown className="w-8 h-8" />
        </button>

      </div>

      {/* Landing sections ported from caw-landing (below the hero/CTA).
          Each section is one full viewport tall; the page scrolls freely
          (no scroll-snap). */}
      <div ref={featuresRef} className="min-h-[100svh] flex flex-col justify-center relative z-10 pt-20 sm:pt-0">
        <Suspense fallback={<div className="py-20" />}>
          <Features />
        </Suspense>
      </div>

      <div className="min-h-[100svh] flex flex-col justify-center relative z-10 pt-20 sm:pt-0">
        <Suspense fallback={<div className="py-20" />}>
          <Community />
        </Suspense>
      </div>

      <div className="min-h-[100svh] flex flex-col justify-center relative z-10">
        <Suspense fallback={<div className="py-20" />}>
          <FreeSpeech />
        </Suspense>
      </div>

      <div className="min-h-[100svh] flex flex-col justify-center relative z-10">
        <Suspense fallback={<div className="py-20" />}>
          <Cawmmunity />
        </Suspense>
      </div>

      {/* Footer - resource links */}
      <LandingFooter />
    </div>
  )
}
