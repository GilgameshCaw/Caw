import { useEffect, useState } from "react";
import ParticleSystemManifesto from "./ParticleSystemManifesto";

import cawmmunityImg from "~/assets/landing/cawmmunity.png";

const RotatingWordCawmmunity = () => {
  const WORDS = ["Cawmmunity", "Revolution"];
  const [display, setDisplay] = useState(WORDS[0]);
  const [deleting, setDeleting] = useState(false);
  const [idx, setIdx] = useState(0);

  const current = WORDS[idx];
  const typingSpeed = deleting ? 45 : 85;
  const pauseTime = 3000;

  useEffect(() => {
    let t: number;
    if (!deleting && display === current) {
      t = window.setTimeout(() => setDeleting(true), pauseTime);
    } else if (deleting && display === "") {
      setDeleting(false);
      setIdx(i => (i + 1) % WORDS.length);
    } else {
      t = window.setTimeout(() => {
        const next = deleting
          ? current.slice(0, display.length - 1)
          : current.slice(0, display.length + 1);
        setDisplay(next);
      }, typingSpeed);
    }
    return () => clearTimeout(t);
  }, [display, deleting, current]);

  const maxWidth = Math.max(...WORDS.map(w => w.length));

  return (
    <span
      className="text-[#F9C337] inline-block align-baseline"
      style={{ whiteSpace: "nowrap", minWidth: `${maxWidth}ch` }}
    >
      {display}
    </span>
  );
};

export const Cawmmunity = () => {
  const tint = "#F9C337";
  const [showContent, setShowContent] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [particlesReady, setParticlesReady] = useState(false);
  const [showBoth, setShowBoth] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (imageLoaded && particlesReady) setShowBoth(true);
  }, [imageLoaded, particlesReady]);

  // Safety timeout: show base image even if particles fail to init.
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center">
          {/* Left side - Image (NO background layer per request) */}
          <div
            className={`order-2 lg:order-1 transition-all duration-500 ${
              showContent ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-8"
            }`}
          >
            <div className="relative w-full max-w-[90%] sm:max-w-xl mx-auto lg:max-w-lg hero-vignette">
              <img
                src={cawmmunityImg}
                alt="Cawmmunity"
                className={`w-full h-auto relative z-0 transition-opacity duration-[1200ms] ease-out scale-[1.15] lg:scale-100 ${
                  imageLoaded ? "opacity-100" : "opacity-0"
                }`}
                loading="eager"
                fetchPriority="high"
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageLoaded(true)}
                onLoadStart={() => {
                  if (!imageLoaded) {
                    setTimeout(() => setImageLoaded(true), 100);
                  }
                }}
              />

              <div
                className={`absolute inset-0 pointer-events-none z-[1] overflow-hidden transition-opacity duration-[1200ms] ease-out ${
                  particlesReady ? "opacity-100" : "opacity-0"
                }`}
              >
                <ParticleSystemManifesto
                  key="cawmmunity-particles"
                  imageUrl={cawmmunityImg}
                  particleDensity={256}
                  tint={tint}
                  minIntensity={0.3}
                  className="w-full h-full"
                  onReady={() => setParticlesReady(true)}
                />
              </div>
            </div>
          </div>

          {/* Right side - Text and CTA */}
          <div
            className={`order-1 lg:order-2 text-center lg:text-left space-y-6 transition-all duration-500 delay-200 ${
              showContent ? "opacity-100 translate-x-0" : "opacity-0 translate-x-8"
            }`}
          >
            <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-semibold">
              Join Teh <RotatingWordCawmmunity />
            </h2>
            <p className="text-gray-400 text-base sm:text-lg max-w-xl mx-auto lg:mx-0">
              Connect with fellow builders, share ideas, and be part of the decentralized future.
            </p>

            <div className="flex justify-center lg:justify-start pt-2">
              <a
                href="https://t.me/AHuntersDreamCAW"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-3 px-4 py-2 rounded-md border border-white/70 bg-zinc-900/80 text-white font-semibold transition-colors hover:bg-yellow-400 hover:border-yellow-400 hover:text-black"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.14.18-.357.295-.6.295-.002 0-.003 0-.005 0l.213-3.054 5.56-5.022c.24-.213-.054-.334-.373-.121l-6.869 4.326-2.96-.924c-.64-.203-.658-.64.135-.954l11.566-4.458c.538-.196 1.006.128.832.941z"/>
                </svg>
                <span>Join Telegram</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Cawmmunity;
