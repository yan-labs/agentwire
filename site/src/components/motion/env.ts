// Shared gates for the React Bits islands: theme, desktop-only WebGL, reduced motion, data saver.
import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const readTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** Current site theme; follows the header toggle (it flips <html data-theme>). */
export function useTheme(): Theme | null {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    setTheme(readTheme());
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/** True only where heavy WebGL backgrounds are worth it: wide screens, motion allowed, no data saver. */
export function useRichMotion(minWidth = 1000): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minWidth}px) and (prefers-reduced-motion: no-preference)`);
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    const update = () => setOk(mq.matches && !saveData);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [minWidth]);
  return ok;
}

/** Resolve CSS custom properties to concrete colours (components that parse colours cannot take var()). */
export function readVars(names: string[]): string[] {
  const cs = getComputedStyle(document.documentElement);
  return names.map((n) => cs.getPropertyValue(n).trim());
}
