/**
 * Mail text helpers — a SEPARATE entry point on purpose.
 *
 * `htmlToPlainText` and `stripQuotedTail` are the app's own implementations and
 * an extension should reuse them: a second HTML-to-text pass drifts on entities
 * and block spacing, and a second quote-marker list is the worst kind of
 * duplication, both copies returning a plausible string while they diverge.
 *
 * But they carry dependencies (`html-to-text`, `@sarv-in/mailguard/quote`) and
 * those dependencies are CommonJS, which esbuild cannot tree-shake because a
 * CJS module's exports are only known at runtime. Re-exporting them from the
 * main entry would charge EVERY extension for them — measured at +107 KB on an
 * extension that does no text processing at all.
 *
 * So importing this module is how an extension says it wants that weight, and
 * importing the main entry can never hand it one by accident.
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
export * from '../../core/src/extension-sdk-text';
