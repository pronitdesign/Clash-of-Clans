import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// How quickly the video catches up with the scroll position (0–1 per frame).
// Lower is smoother but lags more behind the scrollbar.
const EASE = 0.1;

export function initScrollStory() {
  const section = document.getElementById('gameplay');
  if (!section) return;

  const video = section.querySelector<HTMLVideoElement>('.story__video')!;
  const cards = section.querySelectorAll<HTMLElement>('.story-card');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  scrubVideo(section, video);
  playCardsInView(cards);

  if (!reduceMotion) {
    cards.forEach((card) => {
      gsap.fromTo(
        card,
        { y: 160, autoAlpha: 0, scale: 0.94 },
        {
          y: 0,
          autoAlpha: 1,
          scale: 1,
          ease: 'none',
          scrollTrigger: { trigger: card, start: 'top 100%', end: 'top 60%', scrub: 0.6 },
        },
      );
    });
  }
}

function scrubVideo(section: HTMLElement, video: HTMLVideoElement) {
  let progress = 0;
  let current = 0;

  ScrollTrigger.create({
    trigger: section,
    start: 'top top',
    end: 'bottom bottom',
    onUpdate: (self) => (progress = self.progress),
  });

  // The whole file is downloaded up front and played from memory, so a seek
  // never waits on the network. The file is encoded with every frame as a
  // keyframe, which is what lets any point in the 20s be shown without jumps.
  const load = async () => {
    const mobile = matchMedia('(max-width: 768px)').matches;
    const src = (mobile ? video.dataset.srcMobile : video.dataset.src)!;
    try {
      const blob = await (await fetch(src)).blob();
      video.src = URL.createObjectURL(blob);
    } catch {
      video.src = src;
      video.preload = 'auto';
    }
  };

  video.addEventListener('loadedmetadata', () => {
    const tick = () => {
      // Stop just short of the end: seeking to the exact duration can show a black frame.
      const target = progress * (video.duration - 0.05);
      current += (target - current) * EASE;
      // Only ask for a new frame once the previous seek has finished, so seeks
      // never pile up and the video stays in step with the scroll.
      if (!video.seeking && Math.abs(video.currentTime - current) > 1 / 60) {
        video.currentTime = current;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { once: true });

  // Let the loader and the hero video finish first so this download doesn't
  // compete with them.
  if (document.getElementById('loader')) {
    document.addEventListener('loader:done', load, { once: true });
  } else {
    load();
  }
}

function playCardsInView(cards: NodeListOf<HTMLElement>) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target.querySelector('video')!;
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    }
  }, { rootMargin: '200px 0px' });
  cards.forEach((card) => observer.observe(card));
}
