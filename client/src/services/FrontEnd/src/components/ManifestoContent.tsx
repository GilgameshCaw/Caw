import { useEffect, useState } from 'react'
import { Link } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import ParticleSystemManifesto from '~/components/landing/ParticleSystemManifesto'

// Image assets ported from caw-landing/public. Imported (not referenced by
// public path) so Vite hashes + fingerprints them like the other landing
// modules (see Features/FreeSpeech).
import manifestoImg from '~/assets/landing/manifesto.png'
import decentralizationImg from '~/assets/landing/decentralization.png'
import dreamsImg from '~/assets/landing/dreams.png'

// The manifesto body, extracted from ManifestoPage so it can be shared by both
// the standalone /manifesto route (wrapped in LandingHeader/Footer) and the
// in-app /help/manifesto tab (rendered below the Help tab bar). Renders NO page
// chrome of its own — just the <main> content.
const ManifestoContent: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()

  // CAW-yellow particle tint — matches the welcome landing modules
  // (see FreeSpeech.tsx). Default is white; without this the particle
  // overlays read cold against the yellow-accented page.
  const tint = '#F9C337'

  // Theme-aware class fragments — keeps the JSX below readable.
  const muted = isDark ? 'text-white/60' : 'text-black/60'
  const strong = isDark ? 'text-white' : 'text-black'
  const accentBorder = isDark ? 'border-white/20' : 'border-black/15'

  // Below 650px the wide cost tables get cramped, so we abbreviate the long
  // CAW burn amounts (1,000,000,000,000 → 1T). Tracked via matchMedia so it
  // updates live on resize/rotate. Tailwind's breakpoints don't include 650.
  const [isNarrow, setIsNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 650px)')
    const update = () => setIsNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Hero image + particle-overlay readiness gate. Mirrors the pattern used
  // by FreeSpeech: fade the PNG + particle layer in together once both are
  // ready, with a 2s safety timeout so a particle init failure never leaves
  // the image hidden.
  const [imageLoaded, setImageLoaded] = useState(false)
  const [particlesReady, setParticlesReady] = useState(false)
  const [showBoth, setShowBoth] = useState(false)
  const [showContent, setShowContent] = useState(false)

  // Decentralization image gate.
  const [decImageLoaded, setDecImageLoaded] = useState(false)
  const [decParticlesReady, setDecParticlesReady] = useState(false)
  const [showDecBoth, setShowDecBoth] = useState(false)

  // Dreams image gate.
  const [dreamsImageLoaded, setDreamsImageLoaded] = useState(false)
  const [dreamsParticlesReady, setDreamsParticlesReady] = useState(false)
  const [showDreamsBoth, setShowDreamsBoth] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (imageLoaded && particlesReady) setShowBoth(true)
  }, [imageLoaded, particlesReady])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (imageLoaded && !showBoth) {
        setParticlesReady(true)
        setShowBoth(true)
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [imageLoaded, showBoth])

  useEffect(() => {
    if (decImageLoaded && decParticlesReady) setShowDecBoth(true)
  }, [decImageLoaded, decParticlesReady])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (decImageLoaded && !showDecBoth) {
        setDecParticlesReady(true)
        setShowDecBoth(true)
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [decImageLoaded, showDecBoth])

  useEffect(() => {
    if (dreamsImageLoaded && dreamsParticlesReady) setShowDreamsBoth(true)
  }, [dreamsImageLoaded, dreamsParticlesReady])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (dreamsImageLoaded && !showDreamsBoth) {
        setDreamsParticlesReady(true)
        setShowDreamsBoth(true)
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [dreamsImageLoaded, showDreamsBoth])

  return (
      <main className="flex-grow pt-20">
        {/* Hero */}
        <section className="relative min-h-[70vh] flex items-center justify-center px-6 overflow-hidden">
          <div className="w-full max-w-5xl mx-auto relative z-10">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
              {/* Image with noise particle overlay */}
              <div className="flex justify-center relative z-10 w-full mt-8 lg:mt-0">
                <div className="relative w-full max-w-[500px] hero-vignette">
                  <img
                    src={manifestoImg}
                    alt={t('manifesto.hero.title_post')}
                    className={`w-full h-auto relative z-0 transition-opacity duration-300 ${
                      showBoth ? 'opacity-100' : 'opacity-0'
                    }`}
                    loading="eager"
                    fetchPriority="high"
                    onLoad={() => setImageLoaded(true)}
                    onError={() => setImageLoaded(true)}
                  />
                  <div
                    className={`absolute inset-0 pointer-events-none z-[1] overflow-hidden transition-opacity duration-300 ${
                      showBoth ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <ParticleSystemManifesto
                      imageUrl={manifestoImg}
                      particleDensity={256}
                      tint={tint}
                      minIntensity={0.6}
                      className="w-full h-full"
                      onReady={() => setParticlesReady(true)}
                    />
                  </div>
                </div>
              </div>

              {/* Title */}
              <div
                className={`space-y-4 md:space-y-6 text-center lg:text-left relative z-10 transition-all duration-500 ${
                  showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
                }`}
              >
                <h1 className="text-4xl md:text-5xl lg:text-6xl font-semibold leading-tight">
                  {t('manifesto.hero.title_pre')}<span className="text-yellow-400">CAW</span> {t('manifesto.hero.title_post')}
                </h1>
                <p
                  className={`text-base md:text-lg max-w-2xl mx-auto lg:mx-0 transition-all duration-500 delay-200 ${muted} ${
                    showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
                  }`}
                >
                  {t('manifesto.hero.subtitle')}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Full Manifesto Content */}
        <section className="relative py-16 md:py-20 px-6 overflow-hidden">
          <div className="max-w-4xl mx-auto relative z-10 space-y-12 md:space-y-16">
            {/* Main Title */}
            <div
              className={`text-center space-y-6 transition-all duration-500 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h2 className="text-2xl md:text-3xl lg:text-4xl font-semibold">
                {t('manifesto.heading.title')}
              </h2>
              <p className={`text-xl ${muted}`}>
                <span className="text-yellow-400">{t('manifesto.heading.aka')}</span>
              </p>
            </div>

            {/* Decentralization */}
            <div
              className={`space-y-6 max-w-[600px] mx-auto transition-all duration-500 delay-300 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-center text-2xl md:text-3xl font-semibold">
                {t('manifesto.section.decentralization_heading').split('Decentralization').map((part, i, arr) =>
                  i < arr.length - 1
                    ? <span key={i}>{part}<span className="text-yellow-400">Decentralization</span></span>
                    : <span key={i}>{part}</span>
                )}
              </h3>
              <div className={`text-center space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>{t('manifesto.decentralization.p1')}</p>
                <p>{t('manifesto.decentralization.p2')}</p>
                <p>{t('manifesto.decentralization.p3')}</p>
                <p>{t('manifesto.decentralization.p4')}</p>
                <p>{t('manifesto.decentralization.p5')}</p>
              </div>

              {/* Decentralization image */}
              <div className="relative pt-6 md:pt-10 pb-0 px-6 flex justify-center mt-4">
                <div className="relative w-full max-w-[500px] md:max-w-xl mx-auto hero-vignette z-10">
                  <img
                    src={decentralizationImg}
                    alt={t('manifesto.section.decentralization_heading')}
                    className={`w-full h-auto relative z-0 transition-opacity duration-300 ${
                      showDecBoth || decImageLoaded ? 'opacity-100' : 'opacity-0'
                    }`}
                    loading="eager"
                    fetchPriority="high"
                    onLoad={() => {
                      setDecImageLoaded(true)
                      setTimeout(() => setShowDecBoth(true), 100)
                    }}
                    onError={() => {
                      setDecImageLoaded(true)
                      setShowDecBoth(true)
                    }}
                  />
                  <div
                    className={`absolute inset-0 pointer-events-none z-[1] overflow-hidden transition-opacity duration-300 ${
                      showDecBoth ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <ParticleSystemManifesto
                      imageUrl={decentralizationImg}
                      particleDensity={256}
                      tint={tint}
                      minIntensity={0.2}
                      className="w-full h-full"
                      onReady={() => setDecParticlesReady(true)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* CAW Origins */}
            <div
              className={`space-y-6 transition-all duration-500 delay-500 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                {t('manifesto.section.origin_heading').split('CAW').map((part, i, arr) =>
                  i < arr.length - 1
                    ? <span key={i}>{part}<span className="text-yellow-400">CAW</span></span>
                    : <span key={i}>{part}</span>
                )}
              </h3>
              <div className={`space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>{t('help.manifesto.p4')}</p>
                <p>{t('help.manifesto.p5')}</p>
              </div>

              <div className="space-y-6 mt-8 border-l-2 border-yellow-400/40 pl-6">
                <div className="space-y-2">
                  <h4 className="text-xl font-semibold">{t('manifesto.preamble.item1_heading')}</h4>
                  <p className={muted}>{t('manifesto.preamble.item1_body')}</p>
                </div>
                <div className="space-y-2">
                  <h4 className="text-xl font-semibold">{t('manifesto.preamble.item2_heading')}</h4>
                  <p className={muted}>{t('manifesto.preamble.item2_body')}</p>
                </div>
                <div className="space-y-2">
                  <h4 className="text-xl font-semibold">{t('manifesto.preamble.item3_heading')}</h4>
                  <p className={muted}>{t('manifesto.preamble.item3_body')}</p>
                </div>
              </div>
            </div>

            {/* Protocol Proposal */}
            <div
              className={`space-y-2 transition-all duration-500 delay-700 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                {t('manifesto.section.propose_heading').split('Propose').map((part, i, arr) =>
                  i < arr.length - 1
                    ? <span key={i}>{part}<span className="text-yellow-400">Propose</span></span>
                    : <span key={i}>{part}</span>
                )}
              </h3>
              <div className={`space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>{t('help.manifesto.propose.a')}</p>
                <p>{t('help.manifesto.propose.b')}</p>
              </div>
            </div>

            {/* Protocol Functions */}
            <div
              className={`space-y-8 transition-all duration-500 delay-[800ms] ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                {t('manifesto.section.protocol_heading').split('Functions').map((part, i, arr) =>
                  i < arr.length - 1
                    ? <span key={i}>{part}<span className="text-yellow-400">Functions</span></span>
                    : <span key={i}>{part}</span>
                )}
              </h3>

              <div className="space-y-8">
                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">{t('manifesto.proto.i_heading')}</h4>
                  <div className={`space-y-3 pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    <p>{t('help.manifesto.proto.i')}</p>
                    <ul className="list-disc list-inside space-y-2 ml-4">
                      <li>{t('manifesto.proto.i_a')}</li>
                      <li>{t('manifesto.proto.i_b')}</li>
                    </ul>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">{t('manifesto.proto.ii_heading')}</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    {t('help.manifesto.proto.ii')}
                  </p>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">{t('manifesto.proto.iii_heading')}</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    {t('help.manifesto.proto.iii')}
                  </p>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">{t('manifesto.proto.iv_heading')}</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    {t('help.manifesto.proto.iv')}
                  </p>
                </div>

                <div className="space-y-4">
                  <h4 className="text-xl font-semibold">{t('manifesto.proto.v_heading')}</h4>
                  <div className={`space-y-4 pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    <div>
                      <p className={`font-semibold mb-2 ${strong}`}>{t('manifesto.proto.v_i_label')}</p>
                      <p className="ml-4">{t('manifesto.proto.v_i_a')}</p>
                    </div>
                    <div>
                      <p className={`font-semibold mb-2 ${strong}`}>{t('manifesto.proto.v_ii_label')}</p>
                      <p className="ml-4">{t('manifesto.proto.v_ii_a')}</p>
                    </div>
                    <div>
                      <p className={`font-semibold mb-2 ${strong}`}>{t('manifesto.proto.v_iii_label')}</p>
                      <p className="ml-4">{t('manifesto.proto.v_iii_a')}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">{t('manifesto.proto.vi_heading')}</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    {t('help.manifesto.proto.vi')}
                  </p>
                  <ul className={`list-disc list-inside space-y-1 ml-8 ${muted}`}>
                    <li>{t('manifesto.proto.vi_a')}</li>
                    <li>{t('manifesto.proto.vi_b')}</li>
                  </ul>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">{t('manifesto.proto.vii_heading')}</h4>
                  <p className={`pl-4 border-l-2 ${accentBorder} ${muted}`}>
                    {t('help.manifesto.proto.vii')}
                  </p>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xl font-semibold">{t('manifesto.proto.viii_heading')}</h4>
                  <div className={`pl-4 border-l-2 ${accentBorder} space-y-2 ${muted}`}>
                    <p>{t('help.manifesto.proto.viii')}</p>
                    <p>{t('manifesto.proto.viii_p2')}</p>
                    <p>{t('manifesto.proto.viii_p3')}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Protocol vs Frontend */}
            <div
              className={`space-y-6 transition-all duration-500 delay-[900ms] ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                {t('manifesto.section.protocol_vs_frontend_heading').split('Frontend').map((part, i, arr) =>
                  i < arr.length - 1
                    ? <span key={i}>{part}<span className="text-yellow-400">Frontend</span></span>
                    : <span key={i}>{part}</span>
                )}
              </h3>
              <div className={`space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>{t('help.manifesto.frontends_intro_a')}</p>
                <p>{t('help.manifesto.frontends_intro_b')}</p>
              </div>
            </div>

            {/* Frontends */}
            <div
              className={`space-y-6 transition-all duration-500 delay-1000 ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                <span className="text-yellow-400">{t('manifesto.section.frontends_heading')}</span>
              </h3>
              <div className={`space-y-4 text-base md:text-lg leading-relaxed ${muted}`}>
                <p>{t('manifesto.frontends.p1')}</p>
                <p>{t('manifesto.frontends.p2')}</p>
                <p className={`font-semibold ${strong}`}>{t('manifesto.frontends.p3')}</p>
                <p>{t('help.manifesto.frontends.p3_strong')}</p>
              </div>
            </div>

            {/* Appendix */}
            <div
              className={`space-y-10 transition-all duration-500 delay-[1100ms] ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <h3 className="text-2xl md:text-3xl font-semibold">
                <span className="text-yellow-400">{t('help.manifesto.appendix.heading')}</span>
              </h3>

              {/* a. Marketplace */}
              <div className="space-y-4">
                <h4 className="text-xl font-semibold">{t('manifesto.appendix.a_heading')}</h4>
                <div className={`space-y-3 pl-4 border-l-2 ${accentBorder} ${muted}`}>
                  <p>{t('manifesto.appendix.a_p1')}</p>
                  <p>{t('manifesto.appendix.a_p2')}</p>
                  <p>{t('help.manifesto.appendix.a_followup')}</p>
                </div>
              </div>

              {/* b. Economics */}
              <div className="space-y-6">
                <h4 className="text-xl font-semibold">{t('manifesto.appendix.b_heading')}</h4>
                <p className={muted}>{t('manifesto.appendix.b_intro')}</p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className={`text-center p-4 border rounded ${accentBorder}`}>
                    <p className="text-2xl font-semibold text-yellow-400">50M</p>
                    <p className={`text-sm mt-2 ${muted}`}>{t('manifesto.appendix.b_mc_current')}</p>
                  </div>
                  <div className={`text-center p-4 border rounded ${accentBorder}`}>
                    <p className="text-2xl font-semibold text-yellow-400">1B</p>
                    <p className={`text-sm mt-2 ${muted}`}>{t('manifesto.appendix.b_mc_moon')}</p>
                  </div>
                  <div className={`text-center p-4 border rounded ${accentBorder}`}>
                    <p className="text-2xl font-semibold text-yellow-400">10B</p>
                    <p className={`text-sm mt-2 ${muted}`}>{t('manifesto.appendix.b_mc_shib')}</p>
                  </div>
                </div>

                {/* Username Costs */}
                <div className="space-y-4">
                  <h5 className="text-lg font-semibold">{t('manifesto.appendix.username_costs_heading')}</h5>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className={`border-b ${accentBorder}`}>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.username_length')}</th>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.burn_amount')}</th>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.usd_50m')}</th>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.usd_1b')}</th>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.usd_10b')}</th>
                        </tr>
                      </thead>
                      <tbody className={muted}>
                        {([
                          // [length, burnFull, burnAbbrev, usd50M, usd1B, usd10B]
                          ['1 Character', '1,000,000,000,000', '1T', '$89,985', '$1,799,712', '$17,997,120'],
                          ['2 Characters', '240,000,000,000', '240B', '$21,600', '$432,000', '$4,320,000'],
                          ['3 Characters', '60,000,000,000', '60B', '$5,400', '$108,000', '$1,080,000'],
                          ['4 Characters', '6,000,000,000', '6B', '$540', '$10,800', '$108,000'],
                          ['5 Characters', '200,000,000', '200M', '$18', '$360', '$3,600'],
                          ['6 Characters', '20,000,000', '20M', '$1.80', '$36', '$360'],
                          ['7 Characters', '10,000,000', '10M', '$0.90', '$18', '$180'],
                          ['8+ Characters', '1,000,000', '1M', '$0.09', '$1.80', '$18'],
                        ] as const).map(([length, burnFull, burnAbbrev, ...usd]) => (
                          <tr key={length} className={`border-b ${isDark ? 'border-white/10' : 'border-black/10'}`}>
                            <td className="py-3 px-4 whitespace-nowrap">{length}</td>
                            <td className="py-3 px-4 whitespace-nowrap">{isNarrow ? burnAbbrev : burnFull}</td>
                            {usd.map((cell, i) => (
                              <td key={i} className="py-3 px-4">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Protocol Action Costs */}
                <div className="space-y-4 mt-8">
                  <h5 className="text-lg font-semibold">{t('manifesto.appendix.action_costs_heading')}</h5>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className={`border-b ${accentBorder}`}>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.action')}</th>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.cost_caw')}</th>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.distribution')}</th>
                          <th className="text-left py-3 px-4 font-semibold">{t('manifesto.appendix.table.usd_10b_mc')}</th>
                        </tr>
                      </thead>
                      <tbody className={muted}>
                        {[
                          ['Follow Account', '30,000', '80/20 to account and stakepool', '$0.009'],
                          ['Send a CAW (max 420 chars)', '5,000', '100% to stakepool', '$0.0015'],
                          ['Like a CAW', '2,000', '80/20 to account and stakepool', '$0.0007'],
                          ['ReCAW', '4,000', '50/50 to account and stakepool', '$0.0012'],
                        ].map(row => (
                          <tr key={row[0]} className={`border-b ${isDark ? 'border-white/10' : 'border-black/10'}`}>
                            {row.map((cell, i) => (
                              <td key={i} className="py-3 px-4">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* c. Image Hosting */}
              <div className="space-y-4">
                <h4 className="text-xl font-semibold">{t('manifesto.appendix.c_heading')}</h4>
                <div className={`space-y-3 pl-4 border-l-2 ${accentBorder} ${muted}`}>
                  <p>{t('manifesto.appendix.c_i')}</p>
                  <p>{t('manifesto.appendix.c_ii')}</p>
                  <div className={`p-4 rounded border mt-4 ${
                    isDark ? 'bg-black/30 border-white/10' : 'bg-black/5 border-black/10'
                  }`}>
                    <p className="text-sm">
                      <span className="text-yellow-400">{t('manifesto.appendix.example_label')}</span>{' '}
                      {'"Just had some great fried fish on Point Road with @tk420 #yum #foodie #bestfrens https://savoryandsweetfood.com/wp-content/uploads/2013/10/20131020-164849.jpg"'}
                    </p>
                    <p className={`text-sm mt-2 ${muted}`}>
                      {t('help.manifesto.appendix.c_example_explanation')}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Dreams image */}
            <div
              className={`relative py-4 md:py-6 px-6 flex justify-center transition-all duration-500 delay-[1100ms] ${
                showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
              }`}
            >
              <div className="relative w-full max-w-lg lg:max-w-2xl mx-auto z-10 hero-vignette">
                <img
                  src={dreamsImg}
                  alt={t('manifesto.closing.signoff_name')}
                  className={`w-full h-auto relative z-0 transition-opacity duration-300 ${
                    showDreamsBoth ? 'opacity-100' : 'opacity-0'
                  }`}
                  loading="eager"
                  fetchPriority="high"
                  onLoad={() => setDreamsImageLoaded(true)}
                  onError={() => setDreamsImageLoaded(true)}
                />
                <div
                  className={`absolute inset-0 pointer-events-none z-[1] overflow-hidden transition-opacity duration-300 ${
                    showDreamsBoth ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <ParticleSystemManifesto
                    imageUrl={dreamsImg}
                    particleDensity={256}
                    tint={tint}
                    minIntensity={0.6}
                    className="w-full h-full"
                    onReady={() => setDreamsParticlesReady(true)}
                  />
                </div>
              </div>
            </div>

            {/* Closing */}
            <div
              className={`text-center space-y-3 pb-4 -mt-8 md:-mt-12 transition-opacity duration-500 delay-[1200ms] ${
                showContent ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <p className="text-2xl md:text-3xl font-semibold">
                {t('manifesto.closing.signoff_pre')}<span className="text-yellow-400">{t('manifesto.closing.signoff_name')}</span>.
              </p>
              <div className={`space-y-3 ${muted}`}>
                <p>{t('manifesto.ps.line1')}</p>
                <p>{t('manifesto.ps.line2')}</p>
                <p>{t('manifesto.ps.line3')}</p>
              </div>
            </div>
          </div>
        </section>


        {/* Deep-link to the verbatim manifesto inside the white paper. */}
        <section className="px-6 pb-16 text-center">
          <Link
            to="/help/whitepaper/appendix-e--the-manifesto"
            className={`inline-flex items-center gap-2 text-sm font-semibold underline underline-offset-4 ${
              isDark ? 'text-yellow-400 hover:text-yellow-300' : 'text-yellow-700 hover:text-yellow-600'
            }`}
          >
            {t('manifesto.whitepaper_link')}
          </Link>
        </section>
      </main>
  )
}

export default ManifestoContent
