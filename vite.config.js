import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { localApiPlugin } from './server/local-api.mjs';

// The ONE place the version comes from. package.json -> __APP_VERSION__.
// SAR 1.0 required updating it in seven places by hand (SPEC §2.6).
const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));

// A <meta name="theme-color"> cannot reference a CSS custom property, so the
// value would otherwise be a second copy of --rail living in index.html — the
// exact duplication tokens.css exists to prevent. Read it from the token file
// at build time instead, so there is still only one source.
function tokenValue(name) {
  const css = readFileSync('./src/tokens.css', 'utf8');
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`tokens.css: --${name} not found (needed for theme-color)`);
  return m[1].trim();
}

export default defineConfig(({ mode }) => ({
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  // Deployed under a path, not a domain root: vanguard.bingobuyin.com/sar2/
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [localApiPlugin(loadEnv(mode, process.cwd(), 'SAR_')), {
    name: 'sar-inject-tokens',
    transformIndexHtml(html) {
      return html
        .replace(/%THEME_COLOR%/g, tokenValue('rail'))
        .replace(/%APP_VERSION%/g, version);
    },
  }],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
}));
