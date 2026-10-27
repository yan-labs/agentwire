// React Bits SpotlightCard tuned to Deep Field: ion light, the site's own glass surface (set in base.css).
import type { ReactNode } from 'react';
import SpotlightCard from '../reactbits/SpotlightCard';
import { useTheme } from './env';

export default function GlowCard({ children, className = '', id }: { children?: ReactNode; className?: string; id?: string }) {
  const theme = useTheme() ?? 'dark';
  return (
    <SpotlightCard
      id={id}
      className={`glow-card ${className}`}
      theme={theme}
      spotlightColor={theme === 'light' ? '#2aa9e6' : '#7fd8ff'}
      intensity={theme === 'light' ? 0.12 : 0.16}
      spotlightSize={320}
      softness={0.75}
      borderGlow={0.7}
      proximity={60}
      flare={false}
    >
      {children}
    </SpotlightCard>
  );
}
