import { Canvas } from "@react-three/fiber";
import ParticlesCursorAnimationStatic from "./particles/ParticlesCursorAnimationStatic";
import { useEffect, useState } from "react";
import { cn } from "./particles/utils";

export interface ParticleSystemFullscreenProps {
  className?: string;
  imageUrl?: string;
  tint?: string;
}

export default function ParticleSystemFullscreen({ 
  className, 
  imageUrl = "/glow.png",
  tint = "#FFFFFF",
}: ParticleSystemFullscreenProps) {
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

  return (
    <div
      className={cn(
        "w-full h-full absolute inset-0",
        className
      )}
    >
      <Canvas
        camera={{ position: [0, 0, 15], fov: 100 }}
        gl={{
          antialias: true,
          alpha: false,
          preserveDrawingBuffer: true,
        }}
        style={{
          opacity: isUnmounting ? 0 : 1,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        <color attach="background" args={["#000000"]} />
        <ParticlesCursorAnimationStatic imageUrl={imageUrl} tint={tint} />
      </Canvas>
    </div>
  );
}

