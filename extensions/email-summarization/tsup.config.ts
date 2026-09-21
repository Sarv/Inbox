import { defineConfig } from 'tsup';

/**
 * Bundle to a single CommonJS file.
 *
 * The host loads an extension with `require(entryPoint)` from wherever the
 * extension folder happens to sit — a workspace checkout in dev, an unpacked
 * resources directory in a packaged build, or a folder the user picked from
 * their Downloads. None of those have a node_modules beside them, so the entry
 * point must carry everything it needs. `@sarvinbox/core` is imported for TYPES
 * only (`import type`), which erases at compile time and leaves no require.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  // Node builtins (`node:crypto`) stay external — they are resolved by the
  // runtime, not bundled, and `noExternal` below must not try to inline them.
  platform: 'node',
  outDir: 'dist',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Nothing may be left as an external require — see above.
  noExternal: [/.*/],
});
