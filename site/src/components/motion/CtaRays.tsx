// React Bits LightRays over the closing CTA band. Desktop + dark + motion allowed only, loaded lazily.
import { lazy, Suspense } from 'react';
import { useRichMotion, useTheme } from './env';

const LightRays = lazy(() => import('../reactbits/LightRays'));

export default function CtaRays() {
  const rich = useRichMotion(1000);
  const theme = useTheme();
  if (!rich || theme !== 'dark') return null;
  return (
    <div className="cta-rays" aria-hidden="true">
      <Suspense fallback={null}>
        <LightRays
          raysOrigin="top-center"
          raysColor="#bfe6ff"
          raysSpeed={0.6}
          lightSpread={0.55}
          rayLength={1.6}
          intensity={0.8}
          glow={0.45}
          haze={0.2}
          followMouse={false}
          cursorShadow={false}
          clickPulse={false}
          fadeDistance={0.9}
          opacity={0.85}
          maxDevicePixelRatio={1.5}
        />
      </Suspense>
    </div>
  );
}
