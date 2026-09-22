import { defineConfig } from 'tsup';

/**
 * `@sarvinbox/core` is inlined, not referenced.
 *
 * Core is a private workspace package that is not published to npm, so a
 * published SDK that merely re-exported from it would fail to resolve on any
 * machine but this one — at runtime AND in the type declarations. Bundling it
 * in (`noExternal` for the JS, `dts.resolve` for the `.d.ts`) makes the output
 * self-contained: `EmailRecord`, `ExtensionContext` and the tag helpers are
 * written into `dist/` with no dangling import left behind.
 *
 * The two real dependencies stay external so npm installs them normally; they
 * are only reachable through the `/text` entry point.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/text.ts'],
  format: ['cjs', 'esm'],
  dts: { resolve: true },
  noExternal: [/^@sarvinbox\/core/],
  external: ['html-to-text', '@sarv-in/mailguard'],
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
