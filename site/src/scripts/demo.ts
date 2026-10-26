// Terminal-log demo: two AIs in a room. Lines carry data-g (group index); a group appears every ~1.1 s,
// then read messages are struck through and the cleanup line shows. Loops while in view; static under reduced motion.
const el = document.querySelector<HTMLElement>('[data-demo]');
if (el) {
  const lines = Array.from(el.querySelectorAll<HTMLElement>('.ln'));
  const groups = Math.max(...lines.map((l) => Number(l.dataset.g ?? 0))) + 1;
  const gone = Array.from(el.querySelectorAll<HTMLElement>('.ln[data-msg]'));
  const cleaned = el.querySelector<HTMLElement>('[data-cleaned]');
  const cursor = el.querySelector<HTMLElement>('.term-cursor');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let token = 0;
  let running = false;

  const reset = () => {
    lines.forEach((l) => l.classList.remove('show', 'gone'));
    cleaned?.classList.remove('show');
  };

  const run = async () => {
    if (running) return;
    running = true;
    const my = ++token;
    const alive = () => my === token;
    while (alive()) {
      reset();
      await sleep(500);
      for (let g = 0; g < groups && alive(); g++) {
        lines.filter((l) => Number(l.dataset.g) === g).forEach((l) => l.classList.add('show'));
        await sleep(1250);
      }
      if (!alive()) break;
      await sleep(600);
      for (const m of gone) { if (!alive()) break; m.classList.add('gone'); await sleep(180); }
      cleaned?.classList.add('show');
      await sleep(3600);
    }
    running = false;
  };

  if (reduce) {
    lines.forEach((l) => l.classList.add('show'));
    cleaned?.classList.add('show');
    cursor?.remove();
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) run();
        else { token++; running = false; }
      });
    }, { threshold: 0.3 });
    io.observe(el);
  }
}
