import gsap from 'gsap';

// How long the loader lasts. The video is sped up to fit, whatever its length.
const DURATION_S = 5;

export function runLoader() {
  const root = document.getElementById('loader');
  if (!root) return;

  const video = root.querySelector<HTMLVideoElement>('.loader__video')!;
  const fill = root.querySelector<HTMLElement>('.loader__fill')!;
  const pct = root.querySelector<HTMLElement>('.loader__pct')!;
  const bar = root.querySelector<HTMLElement>('.loader__bar')!;
  const copy = root.querySelector<HTMLElement>('.loader__copy-text')!;
  const steps: string[] = JSON.parse(root.dataset.steps!);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  let shown = 0;
  let stepIndex = 0;
  let done = false;

  let swap: gsap.core.Timeline | undefined;

  const setStep = (i: number) => {
    if (i === stepIndex) return;
    stepIndex = i;
    if (reduceMotion) {
      copy.textContent = steps[i];
      return;
    }
    // Steps can change faster than the swap animation; never leave text half-faded.
    swap?.kill();
    swap = gsap.timeline()
      .to(copy, { yPercent: -100, opacity: 0, duration: 0.25, ease: 'power2.in' })
      .add(() => { copy.textContent = steps[i]; })
      .fromTo(copy, { yPercent: 100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.35, ease: 'back.out(2)' });
  };

  const tick = () => {
    const target = useFallback
      ? Math.min((performance.now() - start) / (DURATION_S * 1000), 1)
      : video.duration ? video.currentTime / video.duration : 0;

    // Hold at 99% until the site has finished loading.
    const capped = siteReady ? target : Math.min(target, 0.99);
    shown += (capped - shown) * 0.18;
    if (capped - shown < 0.001) shown = capped;

    const value = Math.round(shown * 100);
    fill.style.clipPath = `inset(0 ${100 - shown * 100}% 0 0 round 999px)`;
    pct.textContent = `${value}%`;
    bar.setAttribute('aria-valuenow', String(value));

    // Spread the first steps across the load; the last one only shows at 100%.
    const i = shown >= 1 ? steps.length - 1 : Math.min(Math.floor(shown * (steps.length - 1)), steps.length - 2);
    setStep(i);

    if (shown >= 1 && !done) {
      done = true;
      finish();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  function finish() {
    const reveal = () => {
      root!.remove();
      document.body.classList.remove('is-loading');
    };
    // Signal the hero to start its entrance while the loader fades away.
    document.dispatchEvent(new CustomEvent('loader:done'));

    if (reduceMotion) {
      gsap.to(root, { opacity: 0, duration: 0.3, delay: 0.4, onComplete: reveal });
      return;
    }
    gsap.timeline({ delay: 0.3, onComplete: reveal })
      .to(root!.querySelector('.loader__bottom'), { y: 24, opacity: 0, duration: 0.4, ease: 'power2.in' })
      .to(root!.querySelector('.loader__logo'), { y: -24, opacity: 0, duration: 0.4, ease: 'power2.in' }, '<')
      .to(video, { scale: 1.08, duration: 0.9, ease: 'power2.inOut' }, '<')
      .to(root, { opacity: 0, duration: 0.7, ease: 'power2.out' }, '-=0.5');
  }
}
