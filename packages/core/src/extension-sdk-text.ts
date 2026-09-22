/**
 * Mail text helpers for extensions — a SEPARATE entry point on purpose.
 *
 * These are the app's own implementations and extensions should reuse them: a
 * second HTML-to-text pass drifts on entities and block spacing, and a second
 * quote-marker list is the worst kind of duplication, both copies returning a
 * plausible string while they diverge.
 *
 * But unlike everything in `extension-sdk.ts`, they carry dependencies
 * (`html-to-text`, and `@sarv-in/mailguard/quote`), and those dependencies are
 * CommonJS — which esbuild cannot tree-shake, because a CJS module's exports are
 * only known at runtime. Re-exporting them from the main SDK entry therefore
 * charged every extension for them whether it imported them or not: measured at
 * +107 KB on `vip-scoring`, which does no text processing at all.
 *
 * So they live behind `@sarvinbox/core/extension-sdk-text`. Importing this
 * module is how an extension says it wants that weight; importing the main SDK
 * entry can never hand it one by accident.
 *
 * The subpath is spelled flat (`-text`) rather than nested (`/text`) because
 * Vite 5 — which is what an extension's vitest run resolves through — fails to
 * resolve a deep export subpath under a key that is itself an export, while
 * Node resolves it fine. The tests would have failed where the built extension
 * worked, so the name matches the file instead.
 */

export { htmlToPlainText, type HtmlToPlainTextOptions } from './utils/html-text';
export { QUOTE_MARKERS, stripQuotedTail } from './utils/quoted-text';
