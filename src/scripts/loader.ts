import gsap from 'gsap';
import { createSparks } from './sparks';

// How long the loader lasts. The video is sped up to fit, whatever its length.
const DURATION_S = 5;

export function runLoader() {
  const root = document.getElementById('loader');
  if (!root) return;

  const scene = root.querySelector<HTMLElement>('.loader__scene')!;
  const video = root.querySelector<HTMLVideoElement>('.loader__video')!;
  const logo = root.querySelector<HTMLElement>('.loader__logo')!;
  const bottom = root.querySelector<HTMLElement>('.loader__bottom')!;
  const row = root.querySelector<HTMLElement>('.loader__row')!;
  const bar = root.querySelector<HTMLElement>('.loader__bar')!;
  const fill = root.querySelector<HTMLElement>('.loader__fill')!;
  const tip = root.querySelector<HTMLElement>('.loader__tip')!;
  const copy = root.querySelector<HTMLElement>('.loader__copy')!;
  const status = root.querySelector<HTMLElement>('.loader__status')!;
  const digits = [...root.querySelectorAll<HTMLElement>('.digit')];
  const canvas = root.querySelector<HTMLCanvasElement>('.loader__sparks')!;
  const steps: string[] = JSON.parse(root.dataset.steps!);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sparks = reduceMotion ? null : createSparks(canvas);

  // The site is only "ready" once the page, fonts and hero video have loaded,
  // so the bar never hits 100% before the hero can actually be shown.
  const heroVideo = document.querySelector<HTMLVideoElement>('.hero__video');
  const heroVideoReady = new Promise<void>((resolve) => {
    if (!heroVideo || heroVideo.readyState >= 3) return resolve();
    heroVideo.addEventListener('canplaythrough', () => resolve(), { once: true });
    heroVideo.addEventListener('error', () => resolve(), { once: true });
    setTimeout(resolve, 10000); // never hold the site hostage to a slow video
  });
  let siteReady = false;
  Promise.all([
    document.readyState === 'complete'
      ? Promise.resolve()
      : new Promise((r) => addEventListener('load', r, { once: true })),
    document.fonts.ready,
    heroVideoReady,
  ]).then(() => (siteReady = true));

  let useFallback = false;
  let done = false;
  const start = performance.now();
  const enableFallback = () => (useFallback = true);
  video.addEventListener('error', enableFallback);
  const fitDuration = () => { video.playbackRate = Math.max(1, video.duration / DURATION_S); };
  if (video.readyState >= 1) fitDuration();
  else video.addEventListener('loadedmetadata', fitDuration, { once: true });
  video.play().catch(enableFallback);
  // Browsers pause muted video in background tabs; pick up where it left off.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && video.paused && !done) video.play().catch(() => {});
  });
  // Slow connections: don't leave the bar stuck at 0% while the video buffers.
  setTimeout(() => { if (video.currentTime === 0) enableFallback(); }, 3000);

  /* ---------- Depth: UI tilts toward the pointer, the video drifts the other way ---------- */

  let removePointer = () => {};
  if (!reduceMotion) {
    const tiltX = gsap.quickTo(bottom, 'rotationX', { duration: 0.8, ease: 'power3.out' });
    const tiltY = gsap.quickTo(bottom, 'rotationY', { duration: 0.8, ease: 'power3.out' });
    const driftX = gsap.quickTo(scene, 'x', { duration: 1.2, ease: 'power3.out' });
    const driftY = gsap.quickTo(scene, 'y', { duration: 1.2, ease: 'power3.out' });
    const onMove = (e: PointerEvent) => {
      const nx = e.clientX / innerWidth - 0.5;
      const ny = e.clientY / innerHeight - 0.5;
      tiltY(nx * 16);
      tiltX(-ny * 12);
      driftX(-nx * 28);
      driftY(-ny * 18);
    };
    addEventListener('pointermove', onMove);
    removePointer = () => removeEventListener('pointermove', onMove);

    // Intro: the UI swings up into place.
    gsap.from(bottom, { rotationX: 70, y: 80, opacity: 0, duration: 1.1, ease: 'expo.out' });
    gsap.from(logo, { y: -40, scale: 0.6, opacity: 0, duration: 0.9, ease: 'back.out(2)', delay: 0.1 });
  }

  /* ---------- Copy: letters flip in and out in 3D ---------- */

  const splitInto = (text: string) => {
    copy.textContent = '';
    const chars: HTMLElement[] = [];
    text.split(' ').forEach((word, w, words) => {
      const wordEl = document.createElement('span');
      wordEl.className = 'word';
      for (const letter of word) {
        const c = document.createElement('span');
        c.className = 'char';
        c.textContent = letter;
        wordEl.append(c);
        chars.push(c);
      }
      copy.append(wordEl);
      if (w < words.length - 1) copy.append(' ');
    });
    return chars;
  };

  let stepIndex = -1;
  let swap: gsap.core.Timeline | undefined;

  const setStep = (i: number) => {
    if (i === stepIndex) return;
    const first = stepIndex === -1;
    const final = i === steps.length - 1;
    stepIndex = i;
    status.textContent = steps[i];

    if (reduceMotion) {
      splitInto(steps[i]);
      copy.classList.toggle('is-final', final);
      return;
    }

    // Steps can change faster than the swap animation; never leave text half-flipped.
    swap?.kill();
    const old = [...copy.querySelectorAll<HTMLElement>('.char')];
    swap = gsap.timeline();
    if (old.length) {
      swap.to(old, {
        rotationX: 90, y: -18, opacity: 0,
        duration: 0.22, ease: 'power2.in', stagger: { each: 0.012, from: 'start' },
      });
    }
    swap.add(() => {
      const chars = splitInto(steps[i]);
      copy.classList.toggle('is-final', final);
      if (final) {
        gsap.fromTo(chars,
          { scale: 0, rotationZ: () => gsap.utils.random(-40, 40), y: 30, opacity: 0 },
          { scale: 1, rotationZ: 0, y: 0, opacity: 1, duration: 0.7, ease: 'elastic.out(1, 0.5)', stagger: 0.03 });
      } else {
        gsap.fromTo(chars,
          { rotationX: -100, y: 24, opacity: 0 },
          { rotationX: 0, y: 0, opacity: 1, duration: 0.55, ease: 'back.out(2.2)', stagger: 0.022 });
      }
    });

    if (!first) punch(final);
  };

  // Each milestone lands with a small impact: the bar thumps and sparks burst.
  const punch = (final: boolean) => {
    gsap.fromTo(row, { scale: final ? 1.08 : 1.04 }, { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.4)' });
    gsap.to(bottom, { keyframes: { x: [0, -6, 5, -3, 2, 0] }, duration: 0.35, ease: 'none' });
    emitAtTip(final ? 70 : 24, final ? 1.6 : 1.2);
  };

  /* ---------- Bar, tip glow, odometer ---------- */

  const tipPosition = () => {
    const barBox = bar.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    const inner = barBox.width - 6;
    return {
      x: barBox.left - canvasBox.left + 3 + inner * shown,
      y: barBox.top - canvasBox.top + barBox.height / 2,
      inner,
    };
  };
  const emitAtTip = (count: number, power = 1) => {
    if (!sparks) return;
    const { x, y } = tipPosition();
    sparks.emit(x, y, count, power);
  };

  const setDigits = (value: number) => {
    const places = [Math.floor(value / 100), Math.floor(value / 10) % 10, value % 10];
    digits.forEach((d, i) => {
      d.classList.toggle('is-hidden', (i === 0 && value < 100) || (i === 1 && value < 10));
      d.firstElementChild!.setAttribute('style', `transform: translateY(-${places[i] * 1.2}em)`);
    });
  };

  let shown = 0;
  let lastValue = -1;

  const tick = () => {
    const target = useFallback
      ? Math.min((performance.now() - start) / (DURATION_S * 1000), 1)
      : video.duration ? video.currentTime / video.duration : 0;

    // Hold at 99% until the site has finished loading.
    const capped = siteReady ? target : Math.min(target, 0.99);
    const prev = shown;
    shown += (capped - shown) * 0.18;
    if (capped - shown < 0.001) shown = capped;

    fill.style.clipPath = `inset(0 ${100 - shown * 100}% 0 0 round 100px)`;
    const { inner } = tipPosition();
    tip.style.transform = `translateX(${inner * shown}px)`;
    tip.style.opacity = shown > 0.005 && shown < 1 ? '1' : '0';

    const value = Math.round(shown * 100);
    if (value !== lastValue) {
      lastValue = value;
      setDigits(value);
      bar.setAttribute('aria-valuenow', String(value));
    }

    if (sparks) {
      if (shown - prev > 0.0005) emitAtTip(2);
      sparks.draw();
    }
    // Slow camera push-in while the village is built.
    if (!reduceMotion) gsap.set(scene, { scale: 1 + shown * 0.06 });

    // Spread the first steps across the load; the last one only shows at 100%.
    const i = shown >= 1 ? steps.length - 1 : Math.min(Math.floor(shown * (steps.length - 1)), steps.length - 2);
    setStep(i);

    if (shown >= 1 && !done) {
      done = true;
      finish();
    }
    // Keep drawing so the last sparks can fall away.
    if (root.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  function finish() {
    const reveal = () => {
      removePointer();
      sparks?.destroy();
      root!.remove();
      document.body.classList.remove('is-loading');
    };

    if (reduceMotion) {
      document.dispatchEvent(new CustomEvent('loader:done'));
      gsap.to(root, { opacity: 0, duration: 0.3, delay: 0.4, onComplete: reveal });
      return;
    }

    // Let "Vila concluída." land, then the UI flies at the camera and the hero takes over.
    gsap.timeline({ delay: 0.7, onComplete: reveal })
      .add(() => document.dispatchEvent(new CustomEvent('loader:done')))
      .to(bottom, { z: 420, opacity: 0, filter: 'blur(10px)', duration: 0.6, ease: 'power3.in' })
      .to(logo, { y: -60, scale: 1.2, opacity: 0, duration: 0.5, ease: 'power3.in' }, '<')
      .to(scene, { scale: 1.25, duration: 1, ease: 'power2.inOut' }, '<')
      .to(root, { opacity: 0, duration: 0.6, ease: 'power2.out' }, '-=0.5');
  }
}
