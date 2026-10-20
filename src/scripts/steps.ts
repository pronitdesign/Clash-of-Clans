import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// How much a card shrinks for each card stacked on top of it.
const SHRINK = 0.05;
// How dark a card gets for each card stacked on top of it.
const SHADE = 0.25;
// Size of the whole section when it starts entering.
const ENTER_SCALE = 0.86;
// Corner radius at the start of the entrance.
const radius = () => (innerWidth < 768 ? 48 : 96);

export function initSteps() {
  const section = document.getElementById('como-jogar');
  if (!section) return;

  const cards = [...section.querySelectorAll<HTMLElement>('.step-card')];
  const last = cards[cards.length - 1];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  playVideosInView(cards);
  if (reduceMotion) return;

  // The whole section enters as a smaller card with big rounded corners and
  // grows to fill the screen. Scaled from the top so it stays attached to the
  // section above; the high scrub value is what makes it feel smooth.
  gsap.fromTo(
    section,
    { scale: ENTER_SCALE, '--radius': () => `${radius()}px` },
    {
      scale: 1,
      '--radius': '0px',
      transformOrigin: '50% 0%',
      ease: 'power1.inOut',
      scrollTrigger: { trigger: section, start: 'top bottom', end: 'top 15%', scrub: 1.2, invalidateOnRefresh: true },
    },
  );

  // Every card but the last shrinks from the moment the next card starts
  // covering it until the last card has settled. Cards lower in the stack get
  // covered by more cards, so they end up smaller and darker.
  cards.slice(0, -1).forEach((card, i) => {
    const covering = cards.length - 1 - i;
    gsap.to(card, {
      scale: 1 - SHRINK * covering,
      '--shade': SHADE * covering,
      ease: 'none',
      scrollTrigger: {
        trigger: cards[i + 1],
        start: 'top bottom',
        endTrigger: last,
        end: () => `top ${getComputedStyle(last).top}`,
        scrub: 0.6,
        invalidateOnRefresh: true,
      },
    });
  });
}

function playVideosInView(cards: HTMLElement[]) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target.querySelector('video');
      if (!video) continue;
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    }
  }, { rootMargin: '200px 0px' });
  cards.forEach((card) => observer.observe(card));
}
