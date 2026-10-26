// Replaces {{key}} with values from src/config.ts (VARS) in text, inline code, code blocks and links.
// Docs stay plain Markdown (readable by humans, Gemini and llms-full.txt) while facts live in one place.
import { VARS } from '../config.ts';

const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const sub = (s) => s.replace(re, (m, k) => (k in VARS ? String(VARS[k]) : m));

function walk(node) {
  if (typeof node.value === 'string' && (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code')) node.value = sub(node.value);
  if (typeof node.url === 'string') node.url = sub(node.url);
  if (typeof node.meta === 'string') node.meta = sub(node.meta);
  if (node.children) node.children.forEach(walk);
}

export function remarkVars() {
  return (tree) => walk(tree);
}
