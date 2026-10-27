// Hero "Deep Field" stage: two lights (assistants) page each other. A message is a pulse of light that travels the arc;
// once the other side has read it, the bubble dissolves into particles (messages are deleted once read).
// Canvas draws stars, the arc, pulses and particles; orbs and bubbles are DOM so text stays crisp.
// Static under prefers-reduced-motion; fewer particles on small screens; pauses when off screen or the tab is hidden.

type Pt = { x: number; y: number };
type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; c: string };
type Pulse = { from: 'a' | 'b'; t0: number; dur: number; color: string };

const stage = document.querySelector<HTMLElement>('[data-stage]');
if (stage) {
  const canvas = stage.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const orbA = stage.querySelector<HTMLElement>('.orb.a')!;
  const orbB = stage.querySelector<HTMLElement>('.orb.b')!;
  const slotA = stage.querySelector<HTMLElement>('.bubble.a')!;
  const slotB = stage.querySelector<HTMLElement>('.bubble.b')!;
  const status = stage.querySelector<HTMLElement>('.stage-status');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = () => innerWidth < 1000;
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const ION = '127,216,255';
  const AMB = '255,176,112';
  const script: { who: 'a' | 'b'; text: string; sig: string; time: string }[] = [
    { who: 'a', text: 'Draft is done, tests are green. Can you review the retry logic?', sig: 'OVER', time: '14:02' },
    { who: 'b', text: 'The backoff is never capped. Limit it to 60 s and ship it.', sig: 'OVER', time: '14:02' },
    { who: 'a', text: 'Capped at 60 s and pushed. Thanks for the review.', sig: 'OUT', time: '14:03' },
  ];

  let w = 0, h = 0, dpr = 1;
  let A: Pt = { x: 0, y: 0 }, B: Pt = { x: 0, y: 0 }, C: Pt = { x: 0, y: 0 };
  let stars: { x: number; y: number; r: number; p: number; s: number }[] = [];
  let particles: Particle[] = [];
  let pulses: Pulse[] = [];
  let running = false;
  let visible = false;
  let raf = 0;
  let token = 0;

  const center = (el: HTMLElement): Pt => {
    const r = el.getBoundingClientRect(), s = stage.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
  };
  const layout = () => {
    const r = stage.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    A = center(orbA); B = center(orbB);
    const peak = parseFloat(getComputedStyle(stage).getPropertyValue('--peak')) || 0.3;
    C = { x: (A.x + B.x) / 2, y: 2 * peak * h - (A.y + B.y) / 2 };
    const n = small() ? 40 : 90;
    stars = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h * 0.9, r: Math.random() * 0.9 + 0.2, p: Math.random() * Math.PI * 2, s: 0.4 + Math.random() * 1.2 }));
  };
  const bez = (t: number, from: 'a' | 'b'): Pt => {
    const P0 = from === 'a' ? A : B, P2 = from === 'a' ? B : A, u = 1 - t;
    return { x: u * u * P0.x + 2 * u * t * C.x + t * t * P2.x, y: u * u * P0.y + 2 * u * t * C.y + t * t * P2.y };
  };
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const drawArc = (now: number) => {
    ctx.save();
    ctx.lineWidth = 1;
    const g = ctx.createLinearGradient(A.x, 0, B.x, 0);
    g.addColorStop(0, `rgba(${ION},0.42)`); g.addColorStop(0.5, isLight() ? 'rgba(60,70,120,0.35)' : 'rgba(230,236,255,0.28)'); g.addColorStop(1, `rgba(${AMB},0.42)`);
    ctx.strokeStyle = g;
    ctx.setLineDash([1.2, 7]);
    ctx.lineDashOffset = -now / 60;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(C.x, C.y, B.x, B.y); ctx.stroke();
    ctx.restore();
  };
  const drawStars = (now: number) => {
    for (const s of stars) {
      const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(s.p + now / 1000 * s.s));
      ctx.fillStyle = isLight() ? `rgba(40,52,96,${a * 0.5})` : `rgba(220,230,255,${a})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
  };
  const glow = (p: Pt, r: number, rgb: string, a: number) => {
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.25, `rgba(${rgb},${a * 0.8})`); g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
  };
  const drawPulses = (now: number) => {
    pulses = pulses.filter((p) => now - p.t0 < p.dur + 200);
    for (const p of pulses) {
      const t = Math.min(1, (now - p.t0) / p.dur), e = ease(t);
      for (let k = 14; k >= 1; k--) {
        const tt = Math.max(0, e - k * 0.018);
        const q = bez(tt, p.from);
        glow(q, 3 + (14 - k) * 0.5, p.color, 0.05 + (14 - k) * 0.012);
      }
      const head = bez(e, p.from);
      glow(head, 22, p.color, 0.75);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(head.x, head.y, 2.4, 0, Math.PI * 2); ctx.fill();
    }
  };
  const drawParticles = (dt: number) => {
    particles = particles.filter((p) => (p.life += dt) < p.max);
    for (const p of particles) {
      const k = p.life / p.max;
      p.vx *= 0.985; p.vy = p.vy * 0.985 - 0.004 * dt;
      p.x += p.vx * dt * 0.06; p.y += p.vy * dt * 0.06;
      ctx.fillStyle = `rgba(${p.c},${(1 - k) * 0.9})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 - k * 0.5), 0, Math.PI * 2); ctx.fill();
    }
  };

  let last = 0;
  const frame = (now: number) => {
    const dt = last ? Math.min(48, now - last) : 16; last = now;
    ctx.clearRect(0, 0, w, h);
    drawStars(now); drawArc(now); drawPulses(now); drawParticles(dt);
    if (running) raf = requestAnimationFrame(frame);
  };

  const dissolve = (el: HTMLElement, rgb: string) => {
    const r = el.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const n = small() ? 70 : 160;
    for (let i = 0; i < n; i++) {
      const x = r.left - s.left + Math.random() * r.width, y = r.top - s.top + Math.random() * r.height;
      particles.push({ x, y, vx: 0.6 + Math.random() * 2.2, vy: -0.6 - Math.random() * 1.4, life: 0, max: 900 + Math.random() * 900, r: 0.5 + Math.random() * 1.4, c: Math.random() < 0.25 ? '255,255,255' : rgb });
    }
    el.classList.add('gone');
  };
  const fill = (el: HTMLElement, m: (typeof script)[number]) => {
    el.querySelector('[data-text]')!.textContent = m.text + ' ';
    const sig = el.querySelector<HTMLElement>('.sig')!; sig.textContent = m.sig;
    el.querySelector('time')!.textContent = m.time;
  };
  const flare = (o: HTMLElement) => { o.classList.remove('flare'); void o.offsetWidth; o.classList.add('flare'); };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const loop = async () => {
    const my = ++token;
    const alive = () => my === token;
    while (alive()) {
      slotA.classList.remove('show', 'gone'); slotB.classList.remove('show', 'gone'); status?.classList.remove('show');
      await sleep(700);
      for (const m of script) {
        if (!alive()) return;
        const el = m.who === 'a' ? slotA : slotB, other = m.who === 'a' ? orbB : orbA, self = m.who === 'a' ? orbA : orbB;
        fill(el, m); el.classList.remove('gone'); void el.offsetWidth;
        flare(self); el.classList.add('show');
        await sleep(900);
        pulses.push({ from: m.who, t0: performance.now(), dur: 1400, color: m.who === 'a' ? ION : AMB });
        await sleep(1400);
        if (!alive()) return;
        flare(other);
        await sleep(1500);
        if (!alive()) return;
        dissolve(el, m.who === 'a' ? ION : AMB);
        await sleep(650);
      }
      status?.classList.add('show');
      await sleep(3200);
    }
  };

  const start = () => {
    if (running || reduce) return;
    running = true; last = 0; raf = requestAnimationFrame(frame); loop();
  };
  const stop = () => { running = false; token++; cancelAnimationFrame(raf); };

  layout();
  if (reduce) {
    fill(slotA, script[0]); fill(slotB, script[1]);
    slotA.classList.add('show'); slotB.classList.add('show'); status?.classList.add('show');
    ctx.clearRect(0, 0, w, h); drawStars(0); drawArc(0);
  } else {
    new IntersectionObserver((es) => es.forEach((e) => { visible = e.isIntersecting; visible && !document.hidden ? start() : stop(); }), { threshold: 0.15 }).observe(stage);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : visible && start()));
  }
  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = window.setTimeout(() => { layout(); if (reduce) { drawStars(0); drawArc(0); } }, 120); });
}
