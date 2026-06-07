import ParticleSystemManifesto from "./ParticleSystemManifesto";
import { useEffect, useState } from "react";

import freeSpeechImg from "~/assets/landing/freespeech.png";

export const FreeSpeech = () => {
  const tint = "#F9C337";
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
        {/* Section title */}
        <div
          className={`text-center mb-6 transition-all duration-[1200ms] ease-out ${
            showContent ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <h3 className="text-2xl sm:text-3xl md:text-4xl font-semibold">
            Freedom of <span className="text-[#F9C337]">Speech</span>
          </h3>
          <p className="text-gray-400 text-sm sm:text-lg max-w-2xl mx-auto mt-4">
            A censorship-resistant social graph where your words live on-chain.
          </p>
        </div>

        {/* Image with noise particle overlay */}
        <div className="max-w-[340px] sm:max-w-sm md:max-w-md lg:max-w-xl w-full mx-auto relative -mt-12 sm:mt-0 -mb-2 hero-vignette">
          <img
            src={freeSpeechImg}
            alt="Free Speech"
            className={`w-full h-auto relative z-0 transition-opacity duration-[1200ms] ease-out ${
              imageLoaded ? "opacity-100" : "opacity-0"
            }`}
            loading="eager"
            fetchPriority="high"
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageLoaded(true)}
          />

          <div
            className={`absolute inset-0 pointer-events-none z-[1] overflow-hidden transition-opacity duration-[1200ms] ease-out ${
              particlesReady ? "opacity-100" : "opacity-0"
            }`}
          >
            <ParticleSystemManifesto
              imageUrl={freeSpeechImg}
              particleDensity={256}
              tint={tint}
              minIntensity={0.15}
              className="w-full h-full"
              onReady={() => setParticlesReady(true)}
            />
          </div>
        </div>

        {/* Key points */}
        <div
          className={`grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 mt-2 transition-all duration-[1200ms] ease-out delay-200 ${
            showContent ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <div
            className={`bg-black md:bg-transparent rounded-lg border border-dashed border-white/40 md:border-white/30 px-4 py-2 md:p-4 text-center transition-all duration-[1200ms] ease-out ${
              showContent ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
            style={{ transitionDelay: "300ms" }}
          >
            <h4 className="font-semibold mb-1.5 text-xs md:text-base">On-chain Identity</h4>
            <p className="text-xs text-gray-400">
              Your wallet is your username — portable and self-sovereign.
            </p>
          </div>

          <div
            className={`bg-black md:bg-transparent rounded-lg border border-dashed border-white/40 md:border-white/30 px-4 py-2 md:p-4 text-center transition-all duration-[1200ms] ease-out ${
              showContent ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
            style={{ transitionDelay: "400ms" }}
          >
            <h4 className="font-semibold mb-1.5 text-xs md:text-base">Open Protocols</h4>
            <p className="text-xs text-gray-400">
              <a
                href="https://github.com/GilgameshCaw/Caw"
                target="_blank"
                rel="noopener noreferrer"
                className="text-yellow-400 hover:underline"
              >
                Open source
              </a>
              {' '}and built on open standards for interoperability and composability.
            </p>
          </div>

          <div
            className={`bg-black md:bg-transparent rounded-lg border border-dashed border-white/40 md:border-white/30 px-4 py-2 md:p-4 text-center transition-all duration-[1200ms] ease-out ${
              showContent ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
            style={{ transitionDelay: "500ms" }}
          >
            <h4 className="font-semibold mb-1.5 text-xs md:text-base">Censorship Resistance</h4>
            <p className="text-xs text-gray-400">
              Verifiable messages resilient to centralized takedowns.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default FreeSpeech;
