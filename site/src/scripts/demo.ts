// "Two AIs in a room" animation. Pure DOM + timers; honours prefers-reduced-motion.
const el = document.querySelector<HTMLElement>('[data-demo]');
if (el) {
  const msgs = Array.from(el.querySelectorAll<HTMLElement>('[data-step]'));
  const pairs = Array.from(el.querySelectorAll<HTMLElement>('[data-pair]'));
  const whoA = el.querySelector<HTMLElement>('[data-who="a"]');
  const whoB = el.querySelector<HTMLElement>('[data-who="b"]');
  const stateA = whoA?.querySelector<HTMLElement>('.state');
  const stateB = whoB?.querySelector<HTMLElement>('.state');
  const cleaned = el.querySelector<HTMLElement>('[data-cleaned]');
  const session = el.querySelector<HTMLElement>('[data-session]');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let running = false;
  let token = 0;

  const setFloor = (who: 'a' | 'b' | null) => {
    whoA?.classList.toggle('has-floor', who === 'a');
    whoB?.classList.toggle('has-floor', who === 'b');
    if (stateA) stateA.textContent = who === 'a' ? 'speaking' : who === 'b' ? 'waiting' : 'idle';
    if (stateB) stateB.textContent = who === 'b' ? 'speaking' : who === 'a' ? 'waiting' : 'idle';
  };

  const resetAll = () => {
    msgs.forEach((m) => m.classList.remove('show', 'gone'));
    pairs.forEach((p) => p.classList.remove('show', 'show2'));
    cleaned?.classList.remove('show');
    if (session) session.textContent = 'session open';
    setFloor(null);
  };

  const showAllStatic = () => {
    msgs.forEach((m) => m.classList.add('show'));
    pairs[pairs.length - 1]?.classList.add('show', 'show2');
    setFloor(null);
    if (stateA) stateA.textContent = 'online';
    if (stateB) stateB.textContent = 'online';
  };

  const run = async () => {
    if (running) return;
    running = true;
    const my = ++token;
    const alive = () => my === token;
    while (alive()) {
      resetAll();
      await sleep(500);
      for (let i = 0; i < msgs.length && alive(); i++) {
        const m = msgs[i];
        const who = m.classList.contains('b') ? 'b' : 'a';
        setFloor(who);
        pairs.forEach((p) => p.classList.remove('show', 'show2'));
        pairs[i]?.classList.add('show');
        await sleep(450);
        m.classList.add('show');
        await sleep(700);
        pairs[i]?.classList.add('show2');
        await sleep(1500);
        // the previous message has now been read by everyone, so it is cleaned up
        if (i > 0) msgs[i - 1].classList.add('gone');
      }
      if (!alive()) break;
      if (session) session.textContent = 'session closed';
      setFloor(null);
      await sleep(1200);
      msgs.forEach((m) => m.classList.add('gone'));
      cleaned?.classList.add('show');
      await sleep(3200);
    }
    running = false;
  };

  if (reduce) {
    showAllStatic();
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) run();
        else { token++; running = false; }
      });
    }, { threshold: 0.35 });
    io.observe(el);
  }
}
