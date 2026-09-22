/**
 * The public SDK for Sarv Inbox extensions.
 *
 * This package is the ONLY thing a third-party extension should depend on. It
 * is published to npm on its own so an extension can be built outside this
 * repository, and it is deliberately tiny: the app's own package
 * (`@sarvinbox/core`) is a build-time dependency here and is inlined into the
 * output, so installing the SDK never pulls IMAP, SQLite, AI or the rest of the
 * client down with it.
 *
 * An extension is loaded by path with `require()` from a folder that has no
 * `node_modules` beside it, so it must be bundled into one self-contained
 * CommonJS file. Everything it imports as a VALUE is therefore copied into that
 * bundle, and the helpers re-exported here are chosen on that basis: pure, no
 * dependencies of their own, and genuinely worth sharing rather than
 * re-implementing (the tag encoding and the sent-folder rules in particular are
 * subtle enough that a second copy would drift and be quietly wrong).
 *
 * Helpers that carry dependencies live behind `@sarvinbox/extension-sdk/text`
 * instead, because those dependencies are CommonJS and no bundler can
 * tree-shake them back out of an extension that never calls them.
 */
/**
 * Imported by RELATIVE PATH into `@sarvinbox/core`'s source, not by its package
 * name, and that is deliberate. The package name resolves through core's
 * `exports` map to its BUILT `dist/*.d.ts`, which rollup-plugin-dts then treats
 * as an external module and leaves as a dangling `export * from
 * '@sarvinbox/core/extension-sdk'` in the published types — unresolvable on any
 * machine that does not have this repository. Pointing at the `.ts` source
 * makes the declaration builder inline every type instead, which is the whole
 * point of this package.
 */
export * from '../../core/src/extension-sdk';
