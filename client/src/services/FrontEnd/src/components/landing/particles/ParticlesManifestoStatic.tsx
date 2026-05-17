import { useRef, useEffect, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const vertexShader = `
uniform vec2 uResolution;
uniform sampler2D uPictureTexture;
uniform float uPointSizeMultiplier;
uniform float uTime;
uniform float uPlaneAspect;
uniform float uImageAspect;
uniform float uMinIntensity;
uniform vec3 uTint;
attribute float aIntensity;
attribute float aAngle;
varying vec3 vColor;
varying vec2 vUv;
void main()
{
    // "Contain" the texture inside the square particle plane so its
    // aspect matches the <img> (which uses object-contain). Without
    // this a non-square PNG gets squished into the square plane and
    // the particle field looks stretched on Y vs the real image.
    vec2 adjustedUv = uv;
    if (uImageAspect > uPlaneAspect) {
        adjustedUv.y = (uv.y - 0.5) * (uImageAspect / uPlaneAspect) + 0.5;
    } else {
        adjustedUv.x = (uv.x - 0.5) * (uPlaneAspect / uImageAspect) + 0.5;
    }
    vec4 picture = texture(uPictureTexture, adjustedUv);
    // Gate intensity by alpha (transparent regions emit no particles,
    // regardless of underlying RGB) AND by the contain bounds so the
    // letterbox bands stay empty — particle field == displayed image.
    float inBounds =
        step(0.0, adjustedUv.x) * step(adjustedUv.x, 1.0) *
        step(0.0, adjustedUv.y) * step(adjustedUv.y, 1.0);
    float pictureIntensity = max(picture.r, uMinIntensity) * picture.a * inBounds;
    vec3 newPosition = position;
    
    float driftSpeed = uTime * 0.4;
    vec3 drift = vec3(
        sin(driftSpeed + aAngle * 3.0) * 0.05 + sin(driftSpeed * 0.5 + aAngle) * 0.025,
        cos(driftSpeed + aAngle * 2.0) * 0.05 + cos(driftSpeed * 0.7 + aAngle * 1.5) * 0.025,
        sin(driftSpeed + aAngle) * 0.03 + cos(driftSpeed * 0.3) * 0.015
    );
    drift *= aIntensity;
    drift *= 1.5;
    
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
  vColor = vec3(pow(pictureIntensity, 1.2) * 1.35 * brightnessVariation) * uTint;
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

interface ParticlesManifestoStaticProps {
  imageUrl?: string;
  particleDensity?: number;
  tint?: string;
  /** Floor for particle intensity on opaque pixels. 0 = brightness-only
   *  (default, unchanged behaviour for bright art like Features). Raise
   *  it (~0.6) for dark-but-opaque shapes like logos so they still emit
   *  particles where their alpha covers, regardless of how dark the RGB
   *  is. Transparent pixels (alpha 0) stay empty either way. */
  minIntensity?: number;
}

export default function ParticlesManifestoStatic({ imageUrl = "", particleDensity = 384, tint = "#FFFFFF", minIntensity = 0 }: ParticlesManifestoStaticProps) {
  const { size, camera } = useThree();
  const meshRef = useRef<THREE.Points>(null);

  // Real image aspect, captured in the loader's onLoad callback. The
  // texture object identity never changes once created, so deriving
  // aspect from `pictureTexture.image` in a useMemo would stay 1
  // forever (image is undefined on first render) — that left the
  // contain remap inert and squished wide PNGs into the square plane.
  const [imageAspect, setImageAspect] = useState(1);

  const pictureTexture = useMemo(() => {
    const loader = new THREE.TextureLoader();
    return loader.load(imageUrl, (tex) => {
      if (tex.image && tex.image.height) {
        setImageAspect(tex.image.width / tex.image.height);
      }
    });
  }, [imageUrl]);

  const planeSize = useMemo(() => {
    if (!(camera instanceof THREE.PerspectiveCamera))
      return { width: 10, height: 10, aspect: 1 };

    // Match the plane to the actual canvas aspect ratio so the particle
    // field aligns 1:1 with the underlying <img> (which is DOM-sized).
    const targetAspect = size.width / Math.max(1, size.height);
    const cameraDistance = Math.abs(camera.position.z);
    const vFov = (camera.fov * Math.PI) / 180;
    const visibleHeight = 2 * Math.tan(vFov / 2) * cameraDistance;
    const visibleWidth = visibleHeight * targetAspect;
  
    return {
      // No overscan: the plane fills exactly the canvas (which is the
      // <img> box), so with the shader's contain remap the particle
      // field matches the displayed image 1:1 instead of ~10% larger.
      width: visibleWidth,
      height: visibleHeight,
      aspect: targetAspect,
    };
  }, [camera, size.width, size.height]);


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
  }, [planeSize, particleDensity]);

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
        uMinIntensity: new THREE.Uniform(minIntensity),
        uTint: new THREE.Uniform(new THREE.Color(tint)),
      },
      blending: THREE.AdditiveBlending,
    });
  }, [
    size,
    pictureTexture,
    planeSize.aspect,
    imageAspect,
    minIntensity,
    tint,
    // Shader source in deps so editing the GLSL rebuilds the material
    // on HMR (otherwise the memoized material keeps the old program).
    vertexShader,
    fragmentShader,
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
