// React Bits ShinyText for hero eyebrows. Server-renders plain text in the theme's ink (readable before and
// without JS); after hydration the shine uses the resolved theme colours.
import { useEffect, useState } from 'react';
import ShinyText from '../reactbits/ShinyText';
import { readVars, useTheme } from './env';

export default function EyebrowShine({ text }: { text: string }) {
  const theme = useTheme();
  const [colors, setColors] = useState<[string, string] | null>(null);
  useEffect(() => {
    if (!theme) return;
    const [ink2, ink] = readVars(['--ink-2', '--ink']);
    setColors([ink2 || '#aab1c5', theme === 'light' ? '#076d9f' : ink || '#ffffff']);
  }, [theme]);
  if (!colors) return <span className="eyebrow-text">{text}</span>;
  return <ShinyText text={text} color={colors[0]} shineColor={colors[1]} speed={3.2} delay={1.6} shineWidth={18} glow={0} className="eyebrow-text" />;
}
