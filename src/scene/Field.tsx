import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'
import { useStore } from '../store'

/**
 * The reactor's atmosphere past its own shell: a wide, faint slab of dust
 * behind everything.
 *
 * On the dash the reactor's field has to fill JARVIS's whole half of the
 * screen, readouts and conversation included, and the shell of points around
 * the core only reaches about two thirds of it once the camera has zoomed out
 * to fit the orb in its panel. This covers the rest. In the world view the orb
 * is cropped to a circle, where extra dust would only thicken the picture
 * inside it, so the slab fades out there.
 */

const COUNT = 2600

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uLevel;
  uniform float uSize;

  attribute float aSeed;

  varying float vAlpha;

  void main() {
    // A slow sway rather than an orbit: this is air, not a shell.
    float t = uTime * (0.04 + aSeed * 0.03);
    vec3 p = position;
    p.x += sin(t + aSeed * 6.2831) * 0.45;
    p.y += cos(t * 0.8 + aSeed * 12.566) * 0.35;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // A twinkle each, so the field never reads as a still texture.
    float twinkle = 0.55 + 0.45 * sin(uTime * (0.6 + aSeed) + aSeed * 40.0);
    vAlpha = (0.12 + uLevel * 0.1) * twinkle;
    gl_PointSize = uSize * (13.0 / -mv.z);
  }
`

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uShow;
  varying float vAlpha;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    float falloff = 1.0 - smoothstep(0.0, 0.5, r);
    gl_FragColor = vec4(uColor, vAlpha * falloff * uIntensity * uShow);
  }
`

export function Field({ drive }: { drive: Drive }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const pts = useRef<THREE.Points>(null)

  // Wide enough to reach the corners of JARVIS's half at the dash's zoom from
  // any drift of the camera, and all of it behind the core.
  const { positions, seeds } = useMemo(() => {
    const positions = new Float32Array(COUNT * 3)
    const seeds = new Float32Array(COUNT)
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (Math.random() * 2 - 1) * 15
      positions[i * 3 + 1] = (Math.random() * 2 - 1) * 15
      positions[i * 3 + 2] = -1.5 - Math.random() * 7
      seeds[i] = Math.random()
    }
    return { positions, seeds }
  }, [])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uSize: { value: 2.2 },
      uColor: { value: new THREE.Color('#00e5ff') },
      uIntensity: { value: 1 },
      uShow: { value: 0 },
    }),
    [],
  )

  useFrame((state, dt) => {
    if (!mat.current || !pts.current) return
    const u = mat.current.uniforms
    pts.current.visible = drive.reactor.visible
    u.uIntensity.value = drive.reactor.intensity
    u.uTime.value = state.clock.elapsedTime
    u.uLevel.value += (drive.level - u.uLevel.value) * Math.min(1, dt * 6)
    ;(u.uColor.value as THREE.Color).lerp(drive.color, Math.min(1, dt * 3))
    const show = useStore.getState().layout === 'dash' ? 1 : 0
    u.uShow.value += (show - u.uShow.value) * Math.min(1, dt * 4)
  })

  return (
    <points ref={pts} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aSeed" args={[seeds, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={vertex}
        fragmentShader={fragment}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}
