// React Bits Galaxy behind the home hero. Desktop + dark theme + motion allowed only; the chunk is fetched
// lazily so phones never download it. While it runs, the hero canvas (field.ts) stops drawing its own stars.
import { lazy, Suspense, useEffect, useState } from 'react';
import { useRichMotion, useTheme } from './env';

const Galaxy = lazy(() => import('../reactbits/Galaxy'));

export default function HeroGalaxy() {
  const rich = useRichMotion(1000);
  const theme = useTheme();
  const on = rich && theme === 'dark';
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    if (on) root.dataset.galaxy = 'on';
    else delete root.dataset.galaxy;
    const t = window.setTimeout(() => setShown(on), 60);
    return () => window.clearTimeout(t);
  }, [on]);
  if (!on) return null;
  return (
    <div className={`hero-galaxy${shown ? ' is-on' : ''}`} aria-hidden="true">
      <Suspense fallback={null}>
        <Galaxy
          transparent
          mouseInteraction={false}
          mouseRepulsion={false}
          clickWarp={false}
          starColors={['#7fd8ff', '#ffb070', '#eef1f8', '#cfe9ff']}
          density={1}
          starSize={0.9}
          glowIntensity={0.28}
          twinkleIntensity={0.45}
          saturation={0.55}
          flareIntensity={0.6}
          starSpeed={0.18}
          speed={0.55}
          rotationSpeed={0.025}
          layers={4}
          focal={[0.5, 0.42]}
          dpr={1.5}
        />
      </Suspense>
    </div>
  );
}
