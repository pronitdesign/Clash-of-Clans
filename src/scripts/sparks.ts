// Tiny particle system for the gold sparks that fly off the loading bar's tip.

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  hue: number;
}

export function createSparks(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const sparks: Spark[] = [];
  let width = 0;
  let height = 0;

  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener('resize', resize);

  const emit = (x: number, y: number, count: number, power = 1) => {
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.65) * Math.PI * 0.9 * power;
      const speed = (1.2 + Math.random() * 3.2) * power;
      sparks.push({
        x,
        y,
        vx: Math.cos(angle) * speed - 0.6,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 30 + Math.random() * 30,
        size: 1 + Math.random() * 2.4,
        hue: 38 + Math.random() * 12,
      });
    }
  };

  const draw = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life++;
      s.vy += 0.12;
      s.vx *= 0.98;
      s.x += s.vx;
      s.y += s.vy;
      const t = 1 - s.life / s.maxLife;
      if (t <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      ctx.fillStyle = `hsla(${s.hue}, 100%, ${60 + t * 30}%, ${t})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size * t, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const destroy = () => removeEventListener('resize', resize);

  return { emit, draw, destroy };
}
