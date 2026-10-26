import { defineConfig } from 'astro/config';
import { remarkVars } from './src/plugins/remark-vars.mjs';

export default defineConfig({
  site: 'https://agents.hot',
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file', inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
  markdown: {
    remarkPlugins: [remarkVars],
    shikiConfig: {
      themes: { light: 'github-light', dark: 'poimandres' },
      defaultColor: false,
      wrap: false,
      transformers: [
        {
          name: 'code-meta',
          pre(node) {
            const raw = (this.options.meta && this.options.meta.__raw) || '';
            const m = /title="([^"]+)"/.exec(raw);
            node.properties['data-lang'] = this.options.lang;
            if (m) node.properties['data-title'] = m[1];
          },
        },
      ],
    },
  },
  vite: { build: { assetsInlineLimit: 0 } },
});
