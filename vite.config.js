import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  // Relative base, so the same build works everywhere.
  //
  // Vite defaults to '/', which emits root-absolute asset URLs like
  // /assets/index-abc.js. On Vercel and Netlify the site IS at the root, so
  // that is fine. On GitHub Pages the site lives at /<repo-name>/ — every
  // root-absolute URL 404s and you get a permanently blank page with no error
  // beyond the console. './' resolves against wherever index.html actually is,
  // which is correct on all three at once and needs no per-host switch.
  //
  // (The README used to suggest adding a "homepage" field to package.json for
  // GitHub Pages. That is a Create React App convention — Vite ignores it
  // completely, so following it produced the blank page anyway.)
  base: './',
});
