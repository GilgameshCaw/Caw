import { useRef, useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const vertexShader = `
uniform vec2 uResolution;
uniform sampler2D uPictureTexture;
uniform float uPointSizeMultiplier;
uniform float uTime;
uniform float uPlaneAspect;
uniform float uImageAspect;
uniform vec3 uTint;
attribute float aIntensity;
attribute float aAngle;
varying vec3 vColor;
varying vec2 vUv;
void main()
{
    // Use UV directly to show full image
vec2 adjustedUv = uv;
float pictureIntensity = texture(uPictureTexture, adjustedUv).r;
    vec3 newPosition = position;
    
    // Simple drift animation without cursor interaction
    float driftSpeed = uTime * 0.3;
    vec3 drift = vec3(
        sin(driftSpeed + aAngle * 3.0) * 0.03 + sin(driftSpeed * 0.5 + aAngle) * 0.015,
        cos(driftSpeed + aAngle * 2.0) * 0.03 + cos(driftSpeed * 0.7 + aAngle * 1.5) * 0.015,
        sin(driftSpeed + aAngle) * 0.02 + cos(driftSpeed * 0.3) * 0.01
    );
    drift *= aIntensity;
    
    newPosition += drift;
    vec4 modelPosition = modelMatrix * vec4(newPosition, 1.0);
    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;
    gl_Position = projectedPosition;
    
    float twinkle1 = sin(uTime * 0.6 + aAngle * 10.0 + position.x * 2.0) * 0.5 + 0.5;
    float twinkle2 = sin(uTime * 0.35 + aAngle * 7.0 + position.y * 2.0) * 0.5 + 0.5;
    float twinkle3 = sin(uTime * 0.8 + aAngle * 13.0) * 0.5 + 0.5;
    float basePulse = sin(uTime * 0.4) * 0.5 + 0.5;
    float twinkleCombined = mix(twinkle1, twinkle2, 0.5);
    twinkleCombined = mix(twinkleCombined, twinkle3, 0.3);
    twinkleCombined = mix(twinkleCombined, basePulse, 0.2);
    twinkleCombined = smoothstep(0.15, 0.85, twinkleCombined);
    float brightnessVariation = 0.5 + twinkleCombined * 0.7;
    
    gl_PointSize = uPointSizeMultiplier * pictureIntensity * uResolution.y;
    gl_PointSize *= (1.0 / - viewPosition.z);
    vColor = vec3(pow(pictureIntensity, 1.2) * 1.0 * brightnessVariation) * uTint;
    vUv = uv;
}
`;

const fragmentShader = `
varying vec3 vColor;
varying vec2 vUv;
void main()
{
    vec2 uv = gl_PointCoord;
    float distanceToCenter = length(uv - vec2(0.5));
    if(distanceToCenter > 0.5)
        discard;
    float edgeFadeSize = 0.4;
    float edgeDistX = min(vUv.x, 1.0 - vUv.x);
    float edgeDistY = min(vUv.y, 1.0 - vUv.y);
    float edgeDist = min(edgeDistX, edgeDistY);
    float edgeFade = smoothstep(0.0, edgeFadeSize, edgeDist);
    float alpha = 1.0 - smoothstep(0.0, 0.5, distanceToCenter);
    alpha = pow(alpha, 0.8);
    float glow = pow(alpha, 2.0) * 0.2;
    vec3 brighterColor = vColor * (1.0 + alpha * 0.4 + glow);
    brighterColor *= edgeFade;
    gl_FragColor = vec4(brighterColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

interface ParticlesCursorAnimationStaticProps {
  imageUrl?: string;
  particleDensity?: number;
  tint?: string;
}

export default function ParticlesCursorAnimationStatic({ imageUrl = "", particleDensity = 512, tint = "#FFFFFF" }: ParticlesCursorAnimationStaticProps) {
  const { size, camera } = useThree();
  const meshRef = useRef<THREE.Points>(null);

  const pictureTexture = useMemo(() => {
    const loader = new THREE.TextureLoader();
    // Load texture - since images are preloaded in HTML, they should be cached
    return loader.load(imageUrl);
  }, [imageUrl]);

  const planeSize = useMemo(() => {
    if (!(camera instanceof THREE.PerspectiveCamera))
      return { width: 10, height: 10, aspect: 1 };

    const targetAspect = size.width / Math.max(1, size.height);
    const cameraDistance = Math.abs(camera.position.z);
    const vFov = (camera.fov * Math.PI) / 180;
    const visibleHeight = 2 * Math.tan(vFov / 2) * cameraDistance;
    const visibleWidth = visibleHeight * targetAspect;
  
    return {
      width: visibleWidth * 1.1,
      height: visibleHeight * 1.1,
      aspect: targetAspect,
    };
  }, [camera, size.width, size.height]);

  const imageAspect = useMemo(() => {
    if (pictureTexture.image) {
      return pictureTexture.image.width / pictureTexture.image.height;
    }
    return 1;
  }, [pictureTexture]);

  const geometry = useMemo(() => {
    const particleQuantity = particleDensity;
    const geo = new THREE.PlaneGeometry(
      planeSize.width,
      planeSize.height,
      particleQuantity,
      particleQuantity
    );
    geo.setIndex(null);
    geo.deleteAttribute("normal");

    const count = geo.attributes.position.count;
    const intensitiesArray = new Float32Array(count);
    const anglesArray = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      intensitiesArray[i] = Math.random();
      anglesArray[i] = Math.random() * Math.PI * 2;
    }

    geo.setAttribute(
      "aIntensity",
      new THREE.BufferAttribute(intensitiesArray, 1)
    );
    geo.setAttribute("aAngle", new THREE.BufferAttribute(anglesArray, 1));

    return geo;
  }, [planeSize]);

  const material = useMemo(() => {
    const pixelRatio = Math.min(window.devicePixelRatio, 2);

    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uResolution: new THREE.Uniform(
          new THREE.Vector2(size.width * pixelRatio, size.height * pixelRatio)
        ),
        uPictureTexture: new THREE.Uniform(pictureTexture),
        uPointSizeMultiplier: new THREE.Uniform(0.04),
        uTime: new THREE.Uniform(0),
        uPlaneAspect: new THREE.Uniform(planeSize.aspect),
        uImageAspect: new THREE.Uniform(imageAspect),
        uTint: new THREE.Uniform(new THREE.Color(tint)),
      },
      blending: THREE.AdditiveBlending,
    });
  }, [
    size,
    pictureTexture,
    planeSize.aspect,
    imageAspect,
    tint,
  ]);

  useEffect(() => {
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    material.uniforms.uResolution.value.set(
      size.width * pixelRatio,
      size.height * pixelRatio
    );
  }, [size, material]);

  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return (
    <points
      ref={meshRef}
      geometry={geometry}
      material={material}
      position={[0, 0, 0]}
    />
  );
}

