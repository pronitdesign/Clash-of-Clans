import * as THREE from 'three';

// Pooled point particles for the character effects: sparks, dust, smoke,
// energy. Sizes and speeds are in scene units (one character height).

export interface Emit {
  at: THREE.Vector3;
  /** Random offset around `at`, per axis. */
  spread?: [number, number, number];
  count: number;
  color?: string[];
  /** Random outward speed. */
  speed?: number;
  /** Extra upward speed. */
  up?: number;
  /** Base velocity added to every particle. */
  velocity?: THREE.Vector3;
  /** Vertical acceleration; negative falls. */
  gravity?: number;
  /** Velocity damping per second. */
  drag?: number;
  /** Spin around the vertical axis, in radians per second. */
  swirl?: number;
  life?: [number, number];
  size?: [number, number];
  /** How much the size grows over the particle's life (smoke). */
  grow?: number;
  /** Flicker, for metal fragments catching the light. */
  blink?: boolean;
}

export class Particles {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly max: number;
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly velocity: Float32Array;
  // life, maxLife, baseSize, grow, gravity, drag, swirl, blink
  private readonly props: Float32Array;
  private next = 0;
  private readonly tmp = new THREE.Color();

  constructor(max: number, blending: THREE.Blending) {
    this.max = max;
    this.position = new Float32Array(max * 3);
    this.color = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.velocity = new Float32Array(max * 3);
    this.props = new Float32Array(max * 8);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));

    const soft = blending === THREE.NormalBlending;
    const material = new THREE.ShaderMaterial({
      uniforms: { uPxPerUnit: { value: 1 } },
      vertexShader: /* glsl */ `
        uniform float uPxPerUnit;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Perspective size: shrinks with distance from the camera.
          gl_PointSize = aSize * uPxPerUnit / -mv.z;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, ${soft ? '0.0' : '0.1'}, d) * vAlpha;
          if (a < 0.005) discard;
          gl_FragColor = vec4(vColor, a);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      blending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = soft ? 1 : 2;
  }

  /** `pxPerUnit`: pixels per scene unit at `distance` from the camera. */
  setScale(pxPerUnit: number, distance: number) {
    this.points.material.uniforms.uPxPerUnit.value = pxPerUnit * distance;
  }

  emit(o: Emit) {
    const [sx, sy, sz] = o.spread ?? [0, 0, 0];
    const colors = o.color ?? ['#ffffff'];
    const [lifeMin, lifeMax] = o.life ?? [0.5, 1];
    const [sizeMin, sizeMax] = o.size ?? [0.01, 0.02];
    const speed = o.speed ?? 0.5;
    for (let n = 0; n < o.count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const i3 = i * 3;
      this.position[i3] = o.at.x + (Math.random() * 2 - 1) * sx;
      this.position[i3 + 1] = o.at.y + (Math.random() * 2 - 1) * sy;
      this.position[i3 + 2] = o.at.z + (Math.random() * 2 - 1) * sz;

      // Random direction on a sphere, scaled by speed.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const s = speed * (0.4 + Math.random() * 0.6);
      this.velocity[i3] = Math.cos(a) * r * s + (o.velocity?.x ?? 0);
      this.velocity[i3 + 1] = u * s + (o.up ?? 0) * (0.5 + Math.random()) + (o.velocity?.y ?? 0);
      this.velocity[i3 + 2] = Math.sin(a) * r * s + (o.velocity?.z ?? 0);

      this.tmp.set(colors[(Math.random() * colors.length) | 0]);
      this.tmp.toArray(this.color, i3);

      const life = lifeMin + Math.random() * (lifeMax - lifeMin);
      const p = i * 8;
      this.props[p] = life;
      this.props[p + 1] = life;
      this.props[p + 2] = sizeMin + Math.random() * (sizeMax - sizeMin);
      this.props[p + 3] = o.grow ?? 0;
      this.props[p + 4] = o.gravity ?? 0;
      this.props[p + 5] = o.drag ?? 0;
      this.props[p + 6] = (o.swirl ?? 0) * (0.5 + Math.random());
      this.props[p + 7] = o.blink ? 1 : 0;
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      const p = i * 8;
      if (this.props[p] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.props[p] -= dt;
      const t = 1 - Math.max(0, this.props[p]) / this.props[p + 1]; // 0 → 1 over life
      const i3 = i * 3;
      const damp = Math.exp(-this.props[p + 5] * dt);
      this.velocity[i3] *= damp;
      this.velocity[i3 + 1] = this.velocity[i3 + 1] * damp + this.props[p + 4] * dt;
      this.velocity[i3 + 2] *= damp;

      const swirl = this.props[p + 6] * dt;
      if (swirl) {
        const x = this.position[i3];
        const z = this.position[i3 + 2];
        const c = Math.cos(swirl);
        const s = Math.sin(swirl);
        this.position[i3] = x * c - z * s;
        this.position[i3 + 2] = x * s + z * c;
      }
      this.position[i3] += this.velocity[i3] * dt;
      this.position[i3 + 1] = Math.max(0, this.position[i3 + 1] + this.velocity[i3 + 1] * dt);
      this.position[i3 + 2] += this.velocity[i3 + 2] * dt;

      this.size[i] = this.props[p + 2] * (1 + this.props[p + 3] * t);
      // Quick fade-in, slow fade-out.
      let alpha = Math.min(1, t * 8) * (1 - t) * (1 - t);
      if (this.props[p + 7]) alpha *= 0.4 + 0.6 * Math.abs(Math.sin(t * 40 + i));
      this.alpha[i] = alpha;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}
