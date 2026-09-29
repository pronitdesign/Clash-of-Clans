import gsap from 'gsap';

export function playHeroIntro() {
  const hero = document.getElementById('inicio');
  if (!hero) return;

  const video = hero.querySelector<HTMLVideoElement>('.hero__video')!;
  const items = hero.querySelectorAll<HTMLElement>('[data-hero-in]');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Hidden while the loader is on screen, so nothing flashes before the intro.
  gsap.set(items, { autoAlpha: 0 });

  const start = () => {
    video.play().catch(() => {});

    if (reduceMotion) {
      gsap.to(items, { autoAlpha: 1, duration: 0.4, delay: 0.5 });
      return;
    }
    gsap.timeline({ delay: 0.6 })
      .fromTo(video, { scale: 1.12 }, { scale: 1, duration: 2.2, ease: 'power3.out' }, 0)
      .fromTo(
        items,
        { autoAlpha: 0, y: 32 },
        { autoAlpha: 1, y: 0, duration: 0.9, ease: 'power3.out', stagger: 0.09 },
        0.2,
      );
  };

  if (document.getElementById('loader')) {
    document.addEventListener('loader:done', start, { once: true });
  } else {
    start();
  }
}
