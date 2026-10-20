import gsap from 'gsap';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import { Particles, type Emit } from './particles';

// The models are static (no rig), so every reaction is done by moving the
// whole model plus particles. Everything in the scene is measured in "model
// heights": each character is scaled to 1 unit tall, feet at y = 0, facing +z.

interface CharacterConfig { id: string; color: string; model: string }

interface Character extends CharacterConfig {
  tint: THREE.Color;
  /** Width / height, used to keep wide models (sword out) inside the frame. */
  aspect: number;
  fit: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  dust: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

const FOV = 30;
const CAMERA_Z = 10;
// Share of the focus box's height the model fills.
const FILL = 0.97;
// The Tripo exports face +x; this turns them towards the camera.
const FACE_CAMERA = -Math.PI / 2;
const DUST_POINTS = 6000;

/** `ready` resolves once the page loader is gone, so the models don't compete with it. */
export function initCharacters(ready: Promise<void>) {
  const section = document.getElementById('personagens');
  if (!section) return;

  const canvas = section.querySelector<HTMLCanvasElement>('.chars__canvas')!;
  const focus = section.querySelector<HTMLElement>('.chars__focus')!;
  const tabs = [...section.querySelectorAll<HTMLButtonElement>('.char-tab')];
  const panels = [...section.querySelectorAll<HTMLElement>('.char-info')];
  const watermark = section.querySelector<HTMLElement>('.chars__watermark')!;
  const indexLabel = section.querySelector<HTMLElement>('.chars__index-current')!;
  const configs: CharacterConfig[] = JSON.parse(section.dataset.characters!);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    section.classList.add('no-webgl');
    bindPicker((i) => showInfo(i));
    return;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.position.z = CAMERA_Z;

  // root: placed and scaled over the focus box · turn: drag + cursor follow ·
  // action: attack and hover poses · each character's fit group goes inside.
  const root = new THREE.Group();
  const turn = new THREE.Group();
  const action = new THREE.Group();
  root.add(turn);
  turn.add(action);
  scene.add(root);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2238, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(3, 5, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 3);
  rim.position.set(-4, 3, -5);
  scene.add(rim);
  const flash = new THREE.PointLight(0xffffff, 0, 3, 1.5);
  flash.position.set(0, 0.4, 0.5);
  root.add(flash);
  const eyes = new THREE.PointLight(0xa65cff, 0, 0.6, 2);
  eyes.position.set(0, 0.82, 0.32);
  action.add(eyes);

  const shadow = groundDecal(radialTexture('rgba(0,0,0,0.75)'), 1.1, THREE.NormalBlending);
  const ring = groundDecal(radialTexture('rgba(255,255,255,1)', 0.55), 1.3, THREE.AdditiveBlending);
  root.add(shadow, ring);

  const glow = new Particles(1400, THREE.AdditiveBlending);
  const smoke = new Particles(500, THREE.NormalBlending);
  root.add(glow.points, smoke.points);

  const shockwave = groundDecal(ringTexture(), 1, THREE.AdditiveBlending);
  const cracks = groundDecal(crackTexture(), 1.6, THREE.AdditiveBlending);
  shockwave.material.opacity = 0;
  cracks.material.opacity = 0;
  root.add(shockwave, cracks);

  const arrow = makeArrow();
  const bomb = makeBomb();
  root.add(arrow, bomb);

  const characters: (Character | undefined)[] = [];
  const loading: Promise<Character>[] = [];
  let current = 0;
  let shown: Character | undefined;
  let busy = false; // attacking or switching

  // Pointer state
  const pointer = new THREE.Vector2(); // -1..1 relative to the focus box
  const ndc = new THREE.Vector2(-10, -10);
  let dragYaw = 0;
  let dragVelocity = 0;
  let dragging: { x: number; y: number; moved: boolean } | null = null;
  let lastDrag = 0;
  let hover = 0;
  let hovering = false;
  let shake = 0;
  let visible = false;
  let pxPerUnit = 1;
  let edgeX = 4; // section's right edge, in root units

  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const raycaster = new THREE.Raycaster();
  const box = new THREE.Box3();
  const clock = new THREE.Clock();

  function load(i: number) {
    loading[i] ??= loader.loadAsync(configs[i].model).then((gltf) => {
      const char = buildCharacter(configs[i], gltf.scene);
      characters[i] = char;
      layout();
      return char;
    });
    return loading[i];
  }

  function buildCharacter(config: CharacterConfig, model: THREE.Object3D): Character {
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -bounds.min.y, -center.z);

    const fit = new THREE.Group();
    const inner = new THREE.Group();
    inner.add(model);
    inner.rotation.y = FACE_CAMERA;
    inner.scale.setScalar(1 / size.y);
    fit.add(inner);
    fit.visible = false;
    action.add(fit);
    fit.updateMatrixWorld(true);

    const materials: THREE.MeshStandardMaterial[] = [];
    let mesh: THREE.Mesh | undefined;
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        mesh ??= o as THREE.Mesh;
        materials.push((o as THREE.Mesh).material as THREE.MeshStandardMaterial);
      }
    });

    const tint = new THREE.Color(config.color);
    const dust = buildDust(mesh!, fit, tint);
    fit.add(dust);

    // After facing the camera, the screen width is the model's original depth.
    return { ...config, tint, aspect: size.z / size.y, fit, materials, dust };
  }

  /** Points sampled from the model's surface, coloured from its texture, used
   *  to dissolve one character and assemble the next. */
  function buildDust(mesh: THREE.Mesh, fit: THREE.Group, tint: THREE.Color) {
    const sampler = new MeshSurfaceSampler(mesh).build();
    const toFit = new THREE.Matrix4().copy(fit.matrixWorld).invert().multiply(mesh.matrixWorld);
    const pixels = readTexture((mesh.material as THREE.MeshStandardMaterial).map);

    const position = new Float32Array(DUST_POINTS * 3);
    const color = new Float32Array(DUST_POINTS * 3);
    const seed = new Float32Array(DUST_POINTS * 4);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const c = new THREE.Color();
    const uv = new THREE.Vector2();
    for (let i = 0; i < DUST_POINTS; i++) {
      sampler.sample(p, n, c, uv);
      p.applyMatrix4(toFit);
      p.toArray(position, i * 3);
      if (pixels) {
        const x = Math.floor(THREE.MathUtils.euclideanModulo(uv.x, 1) * (pixels.width - 1));
        const y = Math.floor(THREE.MathUtils.euclideanModulo(uv.y, 1) * (pixels.height - 1));
        const k = (y * pixels.width + x) * 4;
        c.setRGB(pixels.data[k] / 255, pixels.data[k + 1] / 255, pixels.data[k + 2] / 255, THREE.SRGBColorSpace);
      } else {
        c.copy(tint);
      }
      c.toArray(color, i * 3);
      // Outward direction with an upward bias; the top crumbles first.
      const dir = new THREE.Vector3(p.x, 0.25, p.z).normalize().add(randomInSphere(0.8)).normalize();
      seed.set([dir.x, dir.y, dir.z, (1 - p.y) * 0.6 + Math.random() * 0.4], i * 4);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uProgress: { value: 0 },
        uTint: { value: tint.clone() },
        uSize: { value: 3 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        uniform float uProgress;
        uniform float uSize;
        uniform float uPixelRatio;
        attribute vec3 aColor;
        attribute vec4 aSeed;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vMix;
        void main() {
          float p = clamp((uProgress - aSeed.w * 0.45) / 0.55, 0.0, 1.0);
          float e = p * p * (3.0 - 2.0 * p);
          vec3 pos = position + aSeed.xyz * 0.55 * e + vec3(0.0, 0.35 * e * e, 0.0);
          float a = atan(pos.z, pos.x) + e * 1.6;
          float r = length(pos.xz);
          pos.xz = vec2(cos(a), sin(a)) * r;
          vColor = aColor;
          vMix = e;
          vAlpha = step(0.001, p) * (1.0 - e);
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio * (1.0 + e * 0.8);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vMix;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float alpha = smoothstep(0.5, 0.15, d) * vAlpha;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(mix(vColor, uTint * 1.8, vMix * 0.75), alpha);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.visible = false;
    return points;
  }

  // ---------------------------------------------------------------- layout

  function layout() {
    const w = section.clientWidth;
    const h = section.clientHeight;
    const pixelRatio = Math.min(devicePixelRatio || 1, w < 860 ? 1.5 : 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    const unitsPerPx = (2 * CAMERA_Z * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / h;
    const s = section.getBoundingClientRect();
    const f = focus.getBoundingClientRect();
    const height = f.height * FILL;
    const feet = f.bottom - s.top - (f.height - height) / 2;
    root.position.set((f.left + f.width / 2 - s.left - w / 2) * unitsPerPx, -(feet - h / 2) * unitsPerPx, 0);
    root.scale.setScalar(height * unitsPerPx);
    pxPerUnit = height * pixelRatio;
    edgeX = (w / 2 * unitsPerPx - root.position.x) / root.scale.x + 0.2;

    // Wide characters shrink so they never spill out of the focus box.
    for (const char of characters) {
      if (!char) continue;
      char.fit.scale.setScalar(Math.min(1, (f.width * 1.05) / (char.aspect * height)));
      char.dust.material.uniforms.uPixelRatio.value = pixelRatio;
      char.dust.material.uniforms.uSize.value = Math.max(2, height / 260);
    }
    glow.setScale(pxPerUnit, CAMERA_Z);
    smoke.setScale(pxPerUnit, CAMERA_Z);
  }

  // ------------------------------------------------------------ switching

  function setTint(char: CharacterConfig) {
    const tint = new THREE.Color(char.color);
    rim.color.copy(tint);
    ring.material.color.copy(tint);
    flash.color.copy(tint);
  }

  function setOpacity(char: Character, opacity: number) {
    for (const m of char.materials) {
      // Opaque materials are compiled with alpha forced to 1, so switching
      // needs a recompile; only flag it when the mode actually changes.
      if (m.transparent !== opacity < 1) {
        m.transparent = opacity < 1;
        m.needsUpdate = true;
      }
      m.opacity = opacity;
      m.depthWrite = opacity > 0.5;
    }
  }

  function dissolve(char: Character, from: number, to: number, duration: number) {
    const u = char.dust.material.uniforms.uProgress;
    u.value = from;
    char.dust.visible = true;
    char.fit.visible = true;
    return gsap.to(u, {
      value: to,
      duration,
      ease: to > from ? 'power2.in' : 'power2.out',
      onUpdate: () => setOpacity(char, 1 - THREE.MathUtils.smoothstep(u.value, 0, 0.35)),
      onComplete: () => {
        char.dust.visible = false;
        if (to === 1) char.fit.visible = false;
      },
    });
  }

  async function select(i: number) {
    if (i === current && shown) return;
    current = i;
    showInfo(i);
    setTint(configs[i]);

    const next = await load(i);
    if (current !== i) return; // the user already picked someone else
    busy = true;
    gsap.killTweensOf(action.position);
    gsap.killTweensOf(action.rotation);
    gsap.killTweensOf(action.scale);
    action.position.set(0, 0, 0);
    action.rotation.set(0, 0, 0);
    action.scale.setScalar(1);
    bomb.visible = false;
    arrow.visible = false;

    const previous = shown;
    shown = next;
    for (const char of characters) {
      if (char && char !== next && char !== previous) char.fit.visible = false;
    }

    if (reduceMotion) {
      if (previous) previous.fit.visible = false;
      next.fit.visible = true;
      setOpacity(next, 1);
      busy = false;
      return;
    }

    if (previous) dissolve(previous, 0, 1, 0.7);
    gsap.delayedCall(previous ? 0.3 : 0, () => {
      if (shown !== next) return;
      dissolve(next, 1, 0, 0.9).eventCallback('onComplete', () => {
        next.dust.visible = false;
        setOpacity(next, 1);
        busy = false;
      });
      arrivalEffect(next);
    });
  }

  function showInfo(i: number) {
    tabs.forEach((tab, k) => {
      const on = k === i;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    section.style.setProperty('--char', configs[i].color);
    indexLabel.textContent = String(i + 1).padStart(2, '0');
    watermark.textContent = tabs[i].dataset.name!;

    const panel = panels[i];
    panels.forEach((p) => (p.hidden = p !== panel));
    if (reduceMotion) return;
    gsap.fromTo(
      panel.querySelectorAll('[data-reveal]'),
      { autoAlpha: 0, y: 18 },
      { autoAlpha: 1, y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.05 },
    );
    gsap.fromTo(
      panel.querySelectorAll('.stat__fill'),
      { scaleX: 0 },
      { scaleX: (_: number, el: HTMLElement) => el.style.getPropertyValue('--value'), duration: 1, ease: 'power3.out', stagger: 0.08, delay: 0.2 },
    );
    gsap.fromTo(watermark, { autoAlpha: 0, scale: 0.94 }, { autoAlpha: 1, scale: 1, duration: 0.8, ease: 'power3.out' });
  }

  function bindPicker(onSelect: (i: number) => void) {
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => onSelect(i));
      tab.addEventListener('pointerenter', () => load(i));
      tab.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const k = (i + step + tabs.length) % tabs.length;
        tabs[k].focus();
        onSelect(k);
      });
    });
  }

  // -------------------------------------------------------------- effects

  /** Converts a point in the character's own space to root space, where the
   *  particles live, so effects follow the model when it's turned. */
  function local(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z);
    action.localToWorld(v);
    return root.worldToLocal(v);
  }

  function arrivalEffect(char: Character) {
    const base: Emit = { at: new THREE.Vector3(0, 0.5, 0), spread: [0.35, 0.5, 0.3], count: 0 };
    switch (char.id) {
      case 'barbaro':
        smoke.emit({ ...base, at: local(0, 0.03, 0), spread: [0.5, 0.02, 0.3], count: 40, color: ['#8a6a48', '#5c4632'], speed: 0.35, up: 0.15, life: [0.8, 1.4], size: [0.1, 0.2], grow: 1.5, drag: 2.5 });
        glow.emit({ ...base, count: 120, color: ['#ffe28c', '#ffbf00', '#ff9a00'], speed: 0.9, up: 0.5, gravity: -0.9, life: [0.5, 1.1], size: [0.012, 0.028] });
        break;
      case 'arqueira':
        glow.emit({ ...base, count: 140, color: ['#b8ff8c', '#7ee35a', '#3fbf3a'], speed: 0.5, up: 0.6, life: [0.6, 1.2], size: [0.012, 0.03], drag: 1.5, swirl: 3 });
        for (let k = 0; k < 6; k++) gsap.delayedCall(k * 0.06, () => streak(local((Math.random() - 0.5) * 0.8, 0.2 + Math.random() * 0.6, 0.2), char.tint));
        break;
      case 'esqueleto':
        smoke.emit({ ...base, count: 60, color: ['#3a3633', '#5a524c', '#2a2624'], speed: 0.3, up: 0.35, life: [1, 1.8], size: [0.12, 0.26], grow: 1.8, drag: 1.5 });
        glow.emit({ ...base, at: local(0, 0.15, 0), spread: [0.4, 0.15, 0.3], count: 90, color: ['#ffd04a', '#ff7a1a', '#ff3d00'], speed: 0.4, up: 0.9, life: [0.4, 0.9], size: [0.02, 0.045], drag: 1 });
        break;
      case 'pekka':
        glow.emit({ ...base, count: 150, color: ['#e2c2ff', '#a65cff', '#6a2bff'], speed: 0.6, up: 0.4, life: [0.6, 1.2], size: [0.012, 0.032], swirl: 4, drag: 1.2 });
        glow.emit({ ...base, count: 50, color: ['#c9ccd6', '#8a90a3'], speed: 1.1, up: 0.6, gravity: -2, life: [0.6, 1], size: [0.014, 0.024], blink: true });
        break;
    }
  }

  function streak(at: THREE.Vector3, tint: THREE.Color) {
    glow.emit({ at, count: 14, color: ['#d9ffc4', '#' + tint.getHexString()], speed: 0.05, velocity: new THREE.Vector3(0, 1.4, 0), life: [0.3, 0.5], size: [0.01, 0.02] });
  }

  function impactRing(at: THREE.Vector3, color: THREE.Color, size: number) {
    shockwave.position.set(at.x, 0.004, at.z);
    shockwave.material.color.copy(color);
    gsap.fromTo(shockwave.scale, { x: 0.1, y: 0.1 }, { x: size, y: size, duration: 0.7, ease: 'power3.out' });
    gsap.fromTo(shockwave.material, { opacity: 0.9 }, { opacity: 0, duration: 0.7, ease: 'power2.in' });
  }

  function flashLight(intensity: number, duration: number) {
    gsap.fromTo(flash, { intensity }, { intensity: 0, duration, ease: 'power2.out' });
  }

  function addShake(amount: number) {
    if (!reduceMotion) shake = Math.max(shake, amount);
  }

  function attack() {
    if (busy || !shown) return;
    busy = true;
    const done = () => (busy = false);
    const tint = shown.tint;
    const tl = gsap.timeline({ onComplete: done, defaults: { overwrite: 'auto' } });

    switch (shown.id) {
      case 'barbaro': {
        tl.to(action.rotation, { x: -0.18, duration: 0.2, ease: 'power2.out' })
          .to(action.position, { y: 0.04, duration: 0.2, ease: 'power2.out' }, '<')
          .to(action.position, { z: 0.35, y: 0, duration: 0.13, ease: 'power3.in' })
          .to(action.rotation, { x: 0.32, duration: 0.13, ease: 'power3.in' }, '<')
          .add(() => {
            const at = local(0.1, 0.02, 0.45);
            smoke.emit({ at, spread: [0.25, 0.02, 0.15], count: 45, color: ['#8a6a48', '#6b5138', '#a88a66'], speed: 0.6, up: 0.2, life: [0.7, 1.3], size: [0.08, 0.18], grow: 1.6, drag: 3 });
            glow.emit({ at: local(0.15, 0.3, 0.45), spread: [0.05, 0.1, 0.05], count: 90, color: ['#fff2c0', '#ffbf00', '#ff8a00'], speed: 1.6, up: 0.6, gravity: -2.5, life: [0.3, 0.7], size: [0.008, 0.02] });
            impactRing(at, tint, 1.2);
            cracks.position.set(at.x, 0.003, at.z);
            cracks.material.color.set('#ffbf00');
            gsap.fromTo(cracks.material, { opacity: 0.6 }, { opacity: 0, duration: 1.4, ease: 'power2.in' });
            flashLight(4, 0.5);
            addShake(0.06);
          })
          .to(action.position, { z: 0, duration: 0.5, ease: 'power2.inOut' }, '+=0.15')
          .to(action.rotation, { x: 0, duration: 0.5, ease: 'power2.inOut' }, '<')
          // Victory hop with a burst over the head: the battle cry.
          .to(action.position, { y: 0.1, duration: 0.18, ease: 'power2.out', yoyo: true, repeat: 3 })
          .to(action.scale, { y: 1.04, x: 0.98, z: 0.98, duration: 0.18, yoyo: true, repeat: 3 }, '<')
          .add(() => glow.emit({ at: local(0, 1.05, 0.1), spread: [0.15, 0.05, 0.1], count: 60, color: ['#ffe28c', '#ffbf00'], speed: 0.8, up: 0.8, life: [0.4, 0.8], size: [0.01, 0.022] }), '<');
        break;
      }
      case 'arqueira': {
        tl.to(action.rotation, { y: 0.55, duration: 0.35, ease: 'power2.out' })
          .to(action.position, { z: -0.06, duration: 0.35, ease: 'power2.out' }, '<')
          .add(() => {
            const from = local(0.12, 0.58, 0.15);
            arrow.position.copy(from);
            arrow.visible = true;
            const trail = { x: from.x };
            gsap.to(trail, {
              x: edgeX + 0.5,
              duration: 0.4,
              ease: 'power1.in',
              onUpdate: () => {
                arrow.position.x = trail.x;
                glow.emit({ at: arrow.position.clone(), spread: [0.02, 0.01, 0.01], count: 4, color: ['#d9ffc4', '#7ee35a'], speed: 0.05, life: [0.25, 0.45], size: [0.008, 0.016] });
              },
              onComplete: () => {
                arrow.visible = false;
                const hit = new THREE.Vector3(edgeX - 0.15, from.y, from.z);
                glow.emit({ at: hit, spread: [0.02, 0.08, 0.05], count: 80, color: ['#d9ffc4', '#7ee35a', '#3fbf3a'], speed: 1.2, velocity: new THREE.Vector3(-0.8, 0.2, 0), gravity: -1.5, life: [0.3, 0.7], size: [0.01, 0.024] });
                addShake(0.025);
              },
            });
            glow.emit({ at: from, spread: [0.03, 0.03, 0.03], count: 30, color: ['#d9ffc4', '#7ee35a'], speed: 0.5, life: [0.2, 0.4], size: [0.008, 0.016] });
          })
          .to(action.position, { z: 0.03, duration: 0.08, ease: 'power2.out' })
          .to(action.rotation, { y: 0, duration: 0.6, ease: 'power2.inOut' }, '+=0.45')
          .to(action.position, { z: 0, duration: 0.6, ease: 'power2.inOut' }, '<');
        break;
      }
      case 'esqueleto': {
        const spot = local(0.05, 0, 0.45);
        let fuse: gsap.core.Tween | undefined;
        tl.to(action.scale, { y: 0.92, duration: 0.25, ease: 'power2.out' })
          .to(action.rotation, { x: 0.15, duration: 0.25, ease: 'power2.out' }, '<')
          .add(() => {
            bomb.position.set(spot.x, 0.07, spot.z);
            bomb.visible = true;
            gsap.fromTo(bomb.scale, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1, duration: 0.25, ease: 'back.out(2)' });
            fuse = gsap.to({}, {
              duration: 1,
              onUpdate: () => glow.emit({ at: new THREE.Vector3(spot.x + 0.03, 0.17, spot.z), spread: [0.01, 0.01, 0.01], count: 3, color: ['#fff2c0', '#ffbf00', '#ff7a1a'], speed: 0.5, up: 0.4, gravity: -1.5, life: [0.15, 0.35], size: [0.006, 0.014] }),
            });
          })
          .to(action.scale, { y: 1, duration: 0.2 })
          .to(action.rotation, { x: -0.1, y: 0.4, duration: 0.45, ease: 'power2.inOut' }, '<')
          .to(action.position, { z: -0.3, x: -0.25, duration: 0.45, ease: 'power2.inOut' }, '<')
          .add(() => {
            fuse?.kill();
            bomb.visible = false;
            const at = new THREE.Vector3(spot.x, 0.1, spot.z);
            glow.emit({ at, spread: [0.06, 0.06, 0.06], count: 220, color: ['#fff2c0', '#ffd04a', '#ff7a1a', '#ff3d00'], speed: 1.5, up: 0.5, life: [0.3, 0.8], size: [0.02, 0.05], drag: 2.5 });
            smoke.emit({ at, spread: [0.12, 0.08, 0.12], count: 70, color: ['#2a2624', '#45403b', '#5e5650'], speed: 0.7, up: 0.6, life: [1.2, 2.2], size: [0.14, 0.3], grow: 2, drag: 2 });
            smoke.emit({ at, spread: [0.05, 0.02, 0.05], count: 30, color: ['#6b5138', '#4a3a2a'], speed: 1.6, up: 1.1, gravity: -3, life: [0.6, 1.1], size: [0.025, 0.05] });
            impactRing(at, new THREE.Color('#ff7a1a'), 1.8);
            flashLight(9, 0.9);
            addShake(0.12);
          }, '+=0.25')
          .to(action.position, { x: 0, z: 0, duration: 0.7, ease: 'power2.inOut' }, '+=0.9')
          .to(action.rotation, { x: 0, y: 0, duration: 0.7, ease: 'power2.inOut' }, '<');
        break;
      }
      case 'pekka': {
        tl.to(action.position, { y: 0.1, duration: 0.4, ease: 'power2.out' })
          .to(action.rotation, { x: -0.14, duration: 0.4, ease: 'power2.out' }, '<')
          .add(() => glow.emit({ at: local(-0.4, 0.3, 0.15), spread: [0.12, 0.15, 0.05], count: 40, color: ['#e2c2ff', '#a65cff'], speed: 0.2, up: 0.4, life: [0.3, 0.6], size: [0.01, 0.02] }), '<')
          .to(action.position, { y: 0, duration: 0.12, ease: 'power4.in' })
          .to(action.rotation, { x: 0.22, duration: 0.12, ease: 'power4.in' }, '<')
          .to(action.scale, { y: 0.95, x: 1.03, z: 1.03, duration: 0.12, ease: 'power4.in' }, '<')
          .add(() => {
            const at = local(-0.1, 0.02, 0.45);
            glow.emit({ at, spread: [0.1, 0.02, 0.1], count: 200, color: ['#f0e0ff', '#a65cff', '#6a2bff'], speed: 1.4, up: 0.7, life: [0.4, 1], size: [0.012, 0.035], drag: 1.8 });
            smoke.emit({ at, spread: [0.08, 0.02, 0.08], count: 35, color: ['#4a4555', '#2e2a36'], speed: 1.6, up: 1.2, gravity: -3, life: [0.6, 1.1], size: [0.02, 0.045] });
            impactRing(at, new THREE.Color('#a65cff'), 1.6);
            cracks.position.set(at.x, 0.003, at.z);
            cracks.material.color.set('#a65cff');
            gsap.fromTo(cracks.material, { opacity: 1 }, { opacity: 0, duration: 2.6, ease: 'power2.in' });
            flashLight(10, 2.5);
            // The section's own glow reacts to the blow for a few seconds.
            gsap.fromTo(section, { '--pulse': 1 }, { '--pulse': 0, duration: 2.8, ease: 'power2.out' });
            addShake(0.14);
          })
          .to(action.scale, { x: 1, y: 1, z: 1, duration: 0.3, ease: 'back.out(3)' })
          .to(action.rotation, { x: 0, duration: 0.8, ease: 'power2.inOut' }, '+=0.3');
        break;
      }
    }
  }

  /** Small, continuous effects while the cursor is over the model. */
  function hoverEffects(t: number) {
    if (!shown || hover < 0.3 || busy) return;
    switch (shown.id) {
      case 'esqueleto':
        if (Math.random() < 0.7) glow.emit({ at: local(0.32, 0.5, 0.05), spread: [0.02, 0.02, 0.02], count: 1, color: ['#fff2c0', '#ffbf00', '#ff7a1a'], speed: 0.35, up: 0.3, gravity: -1.2, life: [0.2, 0.4], size: [0.006, 0.012] });
        break;
      case 'pekka': {
        const k = Math.random();
        glow.emit({ at: local(-0.3 - k * 0.25, 0.35 - k * 0.3, 0.12 + k * 0.08), spread: [0.02, 0.02, 0.02], count: 1, color: ['#e2c2ff', '#a65cff'], speed: 0.08, up: 0.25, life: [0.3, 0.6], size: [0.008, 0.016] });
        break;
      }
      case 'barbaro':
        if (Math.sin(t * 9) > 0.97) smoke.emit({ at: local(0, 0.02, 0.05), spread: [0.25, 0, 0.15], count: 3, color: ['#8a6a48'], speed: 0.15, life: [0.5, 0.9], size: [0.05, 0.1], grow: 1.5, drag: 2 });
        break;
    }
  }

  // --------------------------------------------------------------- pointer

  function updatePointer(e: PointerEvent) {
    const r = focus.getBoundingClientRect();
    const s = canvas.getBoundingClientRect();
    pointer.set(
      THREE.MathUtils.clamp((e.clientX - (r.left + r.width / 2)) / (s.width / 2), -1, 1),
      THREE.MathUtils.clamp((e.clientY - (r.top + r.height / 2)) / (s.height / 2), -1, 1),
    );
    ndc.set(((e.clientX - s.left) / s.width) * 2 - 1, -((e.clientY - s.top) / s.height) * 2 + 1);
  }

  function hitModel() {
    if (!shown || !shown.fit.visible) return false;
    raycaster.setFromCamera(ndc, camera);
    box.setFromObject(shown.fit.children[0]);
    return raycaster.ray.intersectsBox(box);
  }

  section.addEventListener('pointermove', (e) => {
    updatePointer(e);
    if (!dragging) return;
    const dx = e.clientX - dragging.x;
    if (Math.abs(dx) + Math.abs(e.clientY - dragging.y) > 6) dragging.moved = true;
    dragVelocity = dx * 0.012;
    dragYaw += dragVelocity;
    dragging.x = e.clientX;
    dragging.y = e.clientY;
    lastDrag = performance.now();
  });
  section.addEventListener('pointerleave', () => ndc.set(-10, -10));

  canvas.addEventListener('pointerdown', (e) => {
    updatePointer(e);
    // On touch, only grab when the finger lands on the model, so the page
    // still scrolls everywhere else.
    if (e.pointerType !== 'mouse' && !hitModel()) return;
    dragging = { x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('is-dragging');
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    const wasClick = !dragging.moved;
    dragging = null;
    canvas.classList.remove('is-dragging');
    canvas.releasePointerCapture(e.pointerId);
    if (wasClick && hitModel()) attack();
  });
  canvas.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    attack();
  });

  bindPicker(select);

  // ---------------------------------------------------------------- loop

  function tick() {
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 1 / 20);
    const t = clock.elapsedTime;
    const ease = 1 - Math.exp(-dt * 6);

    // Drag with inertia, then drift back to facing the camera.
    if (!dragging) {
      dragYaw += dragVelocity;
      dragVelocity *= Math.exp(-dt * 5);
      if (performance.now() - lastDrag > 2500) {
        const home = Math.round(dragYaw / (Math.PI * 2)) * Math.PI * 2;
        dragYaw += (home - dragYaw) * (1 - Math.exp(-dt * 2));
      }
    }

    hovering = !dragging && !busy && hitModel();
    canvas.classList.toggle('is-hover', hovering);
    hover += ((hovering ? 1 : 0) - hover) * ease;

    // The whole body leans towards the cursor; there's no rig for the eyes.
    const followYaw = pointer.x * 0.45;
    const followPitch = pointer.y * 0.12;
    turn.rotation.y += (dragYaw + followYaw - turn.rotation.y) * ease;
    turn.rotation.x += (followPitch - turn.rotation.x) * ease;

    // Combat stance on hover, plus a slow idle breath.
    const breath = Math.sin(t * 1.8) * 0.006;
    const stance = shown?.id;
    turn.position.y = breath;
    turn.scale.setScalar(1 + hover * 0.035);
    turn.rotation.z = stance === 'esqueleto' ? Math.sin(t * 5) * 0.07 * hover : 0;
    if (stance === 'arqueira') turn.rotation.y += hover * 0.25 * ease;
    if (stance === 'barbaro') turn.position.y -= hover * 0.02;
    eyes.intensity = stance === 'pekka' ? hover * 2.5 + (1 - Math.min(1, Math.hypot(pointer.x, pointer.y))) * 0.6 : 0;
    ring.material.opacity = 0.18 + hover * 0.35 + flash.intensity * 0.04;
    rim.intensity = 3 + hover * 2 + flash.intensity * 0.3;

    hoverEffects(t);
    glow.update(dt);
    smoke.update(dt);

    shake *= Math.exp(-dt * 7);
    camera.position.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, CAMERA_Z);

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  new ResizeObserver(layout).observe(section);

  // Models start downloading when the section gets close, after the loader.
  const start = () => {
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        select(current);
        configs.forEach((_, i) => load(i));
      }
    }, { rootMargin: '100% 0px' }).observe(section);
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) {
        clock.getDelta();
        requestAnimationFrame(tick);
      }
    }).observe(section);
  };
  setTint(configs[0]);
  ready.then(start);
}

// ---------------------------------------------------------------- helpers

function randomInSphere(radius: number) {
  const v = new THREE.Vector3();
  do v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  while (v.lengthSq() > 1);
  return v.multiplyScalar(radius);
}

function readTexture(texture: THREE.Texture | null | undefined) {
  const image = texture?.image as CanvasImageSource & { width: number; height: number } | undefined;
  if (!image) return null;
  const size = 512;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.canvas.width = ctx.canvas.height = size;
  ctx.drawImage(image, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

function groundDecal(texture: THREE.Texture, size: number, blending: THREE.Blending) {
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, blending });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.renderOrder = -1;
  return mesh;
}

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function radialTexture(color: string, inner = 0) {
  return canvasTexture((ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * inner * 0.5, s / 2, s / 2, s / 2);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

function ringTexture() {
  return canvasTexture((ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Jagged lines radiating from the centre, for the ground cracks. */
function crackTexture() {
  return canvasTexture((ctx, s) => {
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 6;
    for (let i = 0; i < 9; i++) {
      let a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
      let x = s / 2;
      let y = s / 2;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        a += (Math.random() - 0.5) * 0.9;
        const len = s * (0.04 + Math.random() * 0.05);
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        ctx.lineTo(x, y);
        ctx.lineWidth = Math.max(0.6, 3 - k * 0.5);
      }
      ctx.stroke();
    }
  });
}

function makeArrow() {
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.32, 6), new THREE.MeshBasicMaterial({ color: '#d9c49a' }));
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.05, 8), new THREE.MeshBasicMaterial({ color: '#e8ffe0' }));
  tip.position.y = 0.18;
  group.add(shaft, tip);
  group.rotation.z = -Math.PI / 2;
  group.visible = false;
  return group;
}

function makeBomb() {
  const group = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.07, 24, 16), new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.35, metalness: 0.3 }));
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6), new THREE.MeshStandardMaterial({ color: '#8a6a48' }));
  fuse.position.set(0.03, 0.08, 0);
  fuse.rotation.z = -0.5;
  group.add(ball, fuse);
  group.visible = false;
  return group;
}
