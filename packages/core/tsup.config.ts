import { defineConfig } from 'tsup';

export default defineConfig({
  // `extension-sdk` is a SECOND entry point on purpose: extensions bundle
  // everything they import, so they need a door that does not open onto the
  // whole package. `extension-sdk-text` is a THIRD, for the helpers that carry
  // CommonJS dependencies no bundler can tree-shake away. See both files.
  // `pgp` is a FOURTH, so openpgp.js loads only where it is imported (src/pgp.ts).
  entry: ['src/index.ts', 'src/extension-sdk.ts', 'src/extension-sdk-text.ts', 'src/pgp.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
