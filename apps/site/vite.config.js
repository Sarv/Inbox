import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: GitHub Pages serves a project site under /Inbox/, and
  // a custom domain serves it at /. Relative paths work under both.
  base: './',
  server: {
    // main.js imports the app icon from ../desktop/public rather than keeping a
    // second copy of it.
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'node',
    // Same as every other suite in the repo (see the root vitest.config.ts).
    pool: 'forks',
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js', 'scripts/theme-subset.mjs'],
    },
  },
});
