import { Canvas } from "@react-three/fiber";
import ParticlesManifestoStatic from "./particles/ParticlesManifestoStatic";
import { useEffect, useState } from "react";
import { cn } from "./particles/utils";

export interface ParticleSystemManifestoProps {
  className?: string;
  imageUrl?: string;
  particleDensity?: number;
  onReady?: () => void;
  tint?: string;
  minIntensity?: number;
}

export default function ParticleSystemManifesto({
  className,
  imageUrl = "/manifesto.png",
  particleDensity = 256,
  onReady,
  tint = "#FFFFFF",
  minIntensity = 0,
}: ParticleSystemManifestoProps) {
  const [isUnmounting, setIsUnmounting] = useState(false);
  
  useEffect(() => {
    const handleUnmount = () => setIsUnmounting(true);
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setIsUnmounting(true);
      } else {
        setIsUnmounting(false);
      }
    };
    window.addEventListener("beforeunload", handleUnmount);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handleUnmount);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Notify parent when Canvas is ready (after a short delay for Three.js initialization)
  useEffect(() => {
    if (onReady) {
      const timer = setTimeout(() => {
        onReady();
      }, 100); // Reduced delay for faster appearance
      return () => clearTimeout(timer);
    }
  }, [onReady]);

  return (
    <div
      className={cn(
        "w-full h-full absolute inset-0",
        className
      )}
      key={particleDensity}
    >
      <Canvas
        camera={{ position: [0, 0, 18], fov: 35 }}
        gl={{
          antialias: true,
          alpha: true,
          preserveDrawingBuffer: false,
          premultipliedAlpha: true,
        }}
        style={{
          opacity: isUnmounting ? 0 : 1,
          background: "transparent",
        }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
      >
    <ParticlesManifestoStatic
          imageUrl={imageUrl}
          particleDensity={particleDensity}
          tint={tint}
          minIntensity={minIntensity}
          key={particleDensity}
        />
      </Canvas>
    </div>
  );
}
