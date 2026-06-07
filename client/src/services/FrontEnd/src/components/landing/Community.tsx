import ParticleSystemManifesto from "./ParticleSystemManifesto";
import { useEffect, useMemo, useState } from "react";
import ethereumImg from "~/assets/landing/ethereum.png";
import { useT } from "~/i18n/I18nProvider";

const RotatingWordCommunity = () => {
  const t = useT();
  // Re-derive rotator words on locale change so a language switch flips
  // the typed text on the next cycle instead of leaving stale English.
  const rotating = useMemo(
    () => [t("landing.community.rotator.community"), t("landing.community.rotator.people")],
    [t]
  );
  const [display, setDisplay] = useState(rotating[0]);
  const [deleting, setDeleting] = useState(false);
  const [idx, setIdx] = useState(0);

  const current = rotating[idx];
  const typingSpeed = deleting ? 45 : 85;
  const pauseTime = 2500;

  useEffect(() => {
    let timeout: number;
    if (!deleting && display === current) {
      timeout = window.setTimeout(() => setDeleting(true), pauseTime);
    } else if (deleting && display === "") {
      setDeleting(false);
      setIdx((i) => (i + 1) % rotating.length);
    } else {
      timeout = window.setTimeout(() => {
        const next = deleting
          ? current.slice(0, display.length - 1)
          : current.slice(0, display.length + 1);
        setDisplay(next);
      }, typingSpeed);
    }
    return () => clearTimeout(timeout);
  }, [display, deleting, current, rotating.length]);

  const maxWidth = Math.max(...rotating.map(w => w.length));

  return (
    <span className="text-[#F9C337] inline-block align-baseline" style={{ whiteSpace: "nowrap", minWidth: `${maxWidth}ch` }}>
      {display}
    </span>
  );
};

export const Community = () => {
  const tint = "#F9C337";
  const t = useT();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [particlesReady, setParticlesReady] = useState(false);
  const [showBoth, setShowBoth] = useState(false);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (imageLoaded && particlesReady) setShowBoth(true);
  }, [imageLoaded, particlesReady]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (imageLoaded && !showBoth) {
        setParticlesReady(true);
        setShowBoth(true);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [imageLoaded, showBoth]);

  return (
    <section className="relative py-12 sm:py-16 lg:py-20 px-4 sm:px-6 overflow-hidden">
      <div className="max-w-6xl mx-auto relative z-10">
        {/* Mobile: Title above image */}
        <div className={`text-center mb-6 md:hidden transition-all duration-[1200ms] ease-out delay-200 ${
          showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        }`}>
          <h3 className="text-3xl font-semibold leading-tight">
            <span className="block">{t("landing.community.heading_lead")}</span>
            <RotatingWordCommunity />
          </h3>
        </div>

        {/* Mobile: Image below title */}
        <div className="flex justify-start md:hidden mb-6 ml-3">
          <div className="max-w-[340px] w-full relative z-0">
            <div className="relative w-full overflow-hidden rounded-lg hero-vignette">
              <img
                src={ethereumImg}
                alt={t("landing.community.ethereum_alt")}
                className={`w-full h-auto relative z-0 transition-opacity duration-[1200ms] ease-out ${
                  imageLoaded ? 'opacity-100' : 'opacity-0'
                }`}
                loading="eager"
                fetchPriority="high"
                style={{ mixBlendMode: 'screen', imageRendering: 'auto' }}
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageLoaded(true)}
              />
              <div className={`absolute inset-0 pointer-events-none z-[1] transition-opacity duration-[1200ms] ease-out ${
                particlesReady ? 'opacity-100' : 'opacity-0'
              }`}>
                <ParticleSystemManifesto
                  imageUrl={ethereumImg}
                  particleDensity={256}
                  tint={tint}
                  minIntensity={0.3}
                  className="w-full h-full"
                  onReady={() => setParticlesReady(true)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Mobile: Text boxes below image */}
        <div className="flex flex-col items-center gap-2.5 mb-4 sm:hidden translate-x-2">
          {[t("landing.community.pill.on_chain"), t("landing.community.pill.immutable"), t("landing.community.pill.node")].map((txt, i) => (
            <div key={i} className={`bg-black z-10 transition-all duration-[1200ms] ease-out ${
              i === 0 ? 'delay-300' : i === 1 ? 'delay-400' : 'delay-500'
            } ${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
              <div className="rounded-lg border border-dashed border-white/40 px-6 py-3 text-base whitespace-nowrap">
                {txt}
              </div>
            </div>
          ))}
        </div>

        {/* Desktop: icon with side text boxes + connector lines */}
        <div className="relative flex items-center justify-center mb-12 md:-translate-x-8 lg:-translate-x-12">
          <div className={`absolute left-0 sm:left-4 md:left-12 lg:left-24 top-[35%] -translate-y-1/2 bg-black z-10 transition-all duration-[1200ms] ease-out delay-300 hidden sm:block ${
            showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
          }`}>
            <div className="rounded-lg border border-dashed border-white/40 px-6 py-3 text-sm md:text-base whitespace-nowrap">
              {t("landing.community.pill.on_chain")}
            </div>
            <svg className="absolute left-full top-1/2 -translate-y-1/2 z-0 pointer-events-none h-px w-32 md:w-40 lg:w-56" style={{ marginLeft: '8px' }}>
              <line x1="0" y1="0" x2="100%" y2="0" stroke="white" strokeWidth="1" opacity="0.4" />
            </svg>
          </div>

          <div className={`absolute left-0 sm:left-4 md:left-12 lg:left-24 top-1/2 -translate-y-1/2 bg-black z-10 group transition-all duration-[1200ms] ease-out delay-400 hidden sm:block ${
            showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
          }`}>
            <div className="rounded-lg border border-dashed border-white/40 px-6 py-3 text-sm md:text-base whitespace-nowrap z-10 relative">
              {t("landing.community.pill.immutable")}
            </div>
            <svg className="absolute left-full top-1/2 -translate-y-1/2 z-0 pointer-events-none h-px w-32 md:w-48 lg:w-64" style={{ marginLeft: '8px' }}>
              <line x1="0" y1="0" x2="100%" y2="0" stroke="white" strokeWidth="1" opacity="0.35" />
            </svg>
          </div>

          {/* Center icon — desktop only */}
          <div className="hidden md:block max-w-[240px] sm:max-w-[240px] md:max-w-sm lg:max-w-lg w-full ml-auto sm:ml-auto md:ml-12 lg:ml-16 mr-4 sm:mr-0 bg-transparent relative z-0">
            <div className="relative w-full overflow-hidden rounded-lg hero-vignette">
              <img
                src={ethereumImg}
                alt={t("landing.community.ethereum_alt")}
                className={`w-full h-auto relative z-0 transition-opacity duration-[1200ms] ease-out ${
                  imageLoaded ? 'opacity-100' : 'opacity-0'
                }`}
                loading="eager"
                fetchPriority="high"
                style={{ mixBlendMode: 'screen', imageRendering: 'auto' }}
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageLoaded(true)}
              />
              <div className={`absolute inset-0 pointer-events-none z-[1] transition-opacity duration-[1200ms] ease-out ${
                particlesReady ? 'opacity-100' : 'opacity-0'
              }`}>
                <ParticleSystemManifesto
                  imageUrl={ethereumImg}
                  particleDensity={256}
                  tint={tint}
                  minIntensity={0.3}
                  className="w-full h-full"
                  onReady={() => setParticlesReady(true)}
                />
              </div>
            </div>
          </div>

          {/* Title at right of icon — desktop only */}
          <div className={`absolute -right-4 sm:-right-8 md:-right-16 lg:-right-24 top-[40%] -translate-y-1/2 text-center z-10 scale-75 sm:scale-90 origin-right w-max transition-all duration-[1200ms] ease-out delay-200 hidden md:block ${
              showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}>
            <h3 className="text-2xl sm:text-4xl md:text-5xl lg:text-6xl font-semibold leading-tight">
              <span className="block">{t("landing.community.heading_lead")}</span>
              <RotatingWordCommunity />
            </h3>
          </div>

          {/* Right text box — desktop only */}
          <div className={`absolute left-0 sm:left-4 md:left-12 lg:left-24 top-[65%] -translate-y-1/2 transition-all duration-[1200ms] ease-out delay-500 hidden sm:block ${
            showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
          }`}>
            <div className="rounded-lg border border-dashed border-white/40 px-6 py-3 text-sm md:text-base whitespace-nowrap">
              {t("landing.community.pill.node")}
            </div>
            <svg className="absolute left-full top-1/2 -translate-y-1/2 z-0 pointer-events-none h-px w-16 md:w-24 lg:w-28" style={{ marginLeft: '8px' }}>
              <line x1="0" y1="0" x2="100%" y2="0" stroke="white" strokeWidth="1" opacity="0.4" />
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Community;
