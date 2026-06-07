import feature1 from "~/assets/landing/usernft.png";
import feature2 from "~/assets/landing/caweconomy.png";
import feature3 from "~/assets/landing/messaging.png";
import feature4 from "~/assets/landing/Identity.png";
import ParticleSystemManifesto from "./ParticleSystemManifesto";
import { useState, useEffect, useMemo } from "react";

export const Features = () => {
  const tint = "#F9C337";
  const [showContent, setShowContent] = useState(false);

  const features = useMemo(() => [
    {
      title: "Username NFTs",
      description: "Automatically register tools, prompts, and resources with zero configuration.",
      image: feature1,
    },
    {
      title: "CAW Economy",
      description: "Secure access with Better Auth's integration and monetize with Polar.",
      image: feature2,
    },
    {
      title: "Encrypted Messages",
      description: "End-to-end encrypted · AES-256-GCM technology",
      image: feature3,
    },
    {
      title: "On-chain Identity & Wallet",
      description: "Built with TypeScript, hot reload, and modern tooling for the best DX.",
      image: feature4,
    },
  ], []);

  const [imageStates, setImageStates] = useState<Record<number, { imageLoaded: boolean; particlesReady: boolean; showBoth: boolean }>>({
    0: { imageLoaded: false, particlesReady: false, showBoth: false },
    1: { imageLoaded: false, particlesReady: false, showBoth: false },
    2: { imageLoaded: false, particlesReady: false, showBoth: false },
    3: { imageLoaded: false, particlesReady: false, showBoth: false },
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowContent(true);
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const updateImageState = (index: number, updates: Partial<typeof imageStates[0]>) => {
    setImageStates(prev => ({
      ...prev,
      [index]: { ...prev[index], ...updates }
    }));
  };

  useEffect(() => {
    Object.keys(imageStates).forEach(indexStr => {
      const index = parseInt(indexStr);
      const state = imageStates[index];
      if (state.imageLoaded && state.particlesReady && !state.showBoth) {
        updateImageState(index, { showBoth: true });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageStates]);

  useEffect(() => {
    const timers = features.map((_, index) => {
      return setTimeout(() => {
        setImageStates(prev => {
          const current = prev[index];
          if (current?.imageLoaded && !current?.showBoth) {
            return {
              ...prev,
              [index]: { ...current, particlesReady: true, showBoth: true }
            };
          }
          return prev;
        });
      }, 2000);
    });

    return () => {
      timers.forEach(timer => clearTimeout(timer));
    };
  }, []);

  return (
    <section className="relative py-12 sm:py-16 lg:py-20 px-4 sm:px-6 overflow-hidden">
      <div className="max-w-3xl mx-auto relative z-10"></div>
      <div className="max-w-3xl mx-auto relative z-30">
        <div className={`text-center mb-4 space-y-2 sm:space-y-4 relative z-30 transition-all duration-500 ${
          showContent
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-4'
        }`}>
          <h3 className="text-2xl sm:text-3xl md:text-4xl font-semibold relative z-30">
            The architecture of
            <br />
            <span className="text-[#F9C337]">decentralized communication</span>
          </h3>
          <p className="text-gray-400 text-sm sm:text-lg max-w-2xl mx-auto relative z-30">
            Your words, your wallet, your identity — all on-chain.
          </p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-2 gap-5 sm:gap-8 -mt-6 sm:-mt-8">
          {features.map((feature, index) => (
            <div
              key={index}
              className={`relative flex flex-col transition-all duration-500 ${
                showContent
                  ? 'opacity-100 translate-y-0'
                  : 'opacity-0 translate-y-4'
              }`}
              style={{
                transitionDelay: `${200 + (index * 100)}ms`
              }}
            >
              {/* Image with noise particle overlay. Width is per-image
                  (caweconomy a touch smaller); the row's title alignment
                  is driven by the fixed image HEIGHT below, not width. */}
              <div className={`mx-auto relative hero-vignette ${
                index === 1
                  ? 'max-w-[130px] sm:max-w-[235px]'
                  : index === 0
                  ? 'max-w-[145px] sm:max-w-[270px]'
                  : 'max-w-[130px] sm:max-w-[224px]'
              }`}>
                <img
                  src={feature.image}
                  alt={feature.title}
                  className={`w-full object-contain relative z-0 transition-opacity duration-300 ${
                    index === 0 || index === 1
                      ? 'h-[120px] sm:h-[270px]'
                      : 'h-[110px] sm:h-[224px]'
                  } ${
                    imageStates[index]?.showBoth ? 'opacity-100' : 'opacity-0'
                  }`}
                  loading="eager"
                  fetchPriority="high"
                  onLoad={() => {
                    updateImageState(index, { imageLoaded: true });
                  }}
                  onError={() => {
                    updateImageState(index, { imageLoaded: true });
                  }}
                  onLoadStart={() => {
                    if (imageStates[index]?.imageLoaded === false) {
                      setTimeout(() => {
                        updateImageState(index, { imageLoaded: true });
                      }, 100);
                    }
                  }}
                />
                {/* Particle overlay for noise effect */}
                <div
                  className={`hero-vignette absolute inset-0 pointer-events-none z-[1] overflow-hidden mix-blend-screen transition-opacity duration-300 ${
                    imageStates[index]?.showBoth ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <ParticleSystemManifesto
                    imageUrl={
                      typeof feature.image === 'string'
                        ? feature.image
                        : (feature.image as any)?.default || String(feature.image)
                    }
                    particleDensity={256}
                    tint={tint}
                    className="w-full h-full"
                    onReady={() => {
                      updateImageState(index, { particlesReady: true });
                    }}
                  />
                </div>
              </div>

              {/* Text content - tucked up under the artwork. Image height
                  is fixed per row (above), so the negative margin lands
                  every title in the row at the exact same Y. */}
              <div className={`relative z-30 ${index === 0 || index === 1 ? '-mt-4 sm:-mt-14' : '-mt-2 sm:-mt-6'} space-y-1.5 sm:space-y-2 text-center transition-all duration-500 delay-300 ${
                showContent
                  ? 'opacity-100 translate-y-0'
                  : 'opacity-0 translate-y-4'
              }`}>
                <h4 className="text-[14px] sm:text-lg font-semibold">{feature.title}</h4>
                <p className="text-gray-400 text-[12px] sm:text-sm leading-snug sm:leading-normal max-w-[170px] sm:max-w-none mx-auto break-words sm:break-normal">{feature.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;
