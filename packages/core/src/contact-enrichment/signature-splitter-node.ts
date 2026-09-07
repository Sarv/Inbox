/**
 * NODE-ONLY. Do not import from the renderer, and do not re-export from
 * `contact-enrichment/index.ts`.
 *
 * email-reply-parser calls `require('module')`, which Vite cannot bundle for a
 * browser target — pulling it into the shared module blanks the window with
 * "Dynamic require of 'module' is not supported". So it lives here and is
 * registered at main-process startup via {@link installNodeSignatureSplitter}.
 * The renderer simply never installs one and falls back to the local delimiter
 * heuristics, which is the behaviour it had all along.
 */

import EmailReplyParser from 'email-reply-parser';

import { setExtractorSignatureSplitter } from './signal-extractor';
import { setSignatureSplitter } from './zones';

/**
 * Signature fragments via email-reply-parser (GitHub's parser, ported).
 *
 * Preferred over the local heuristics for two reasons: it is the proven
 * implementation, and it returns EVERY signature fragment rather than only the
 * last, so an email carrying two sign-offs yields both and each can be
 * attributed to its own author.
 */
export function splitSignaturesWithParser(text: string): string[] {
  const parsed = new EmailReplyParser().read(text);
  return parsed
    .getFragments()
    .filter((f) => f.isSignature() && !f.isQuoted())
    .map((f) => f.getContent().trim())
    .filter(Boolean);
}

/**
 * Visible (non-quoted, non-signature) text of a message.
 *
 * Useful anywhere a thread is rendered per-message — a chat-style view wants
 * only what this author actually wrote, not the history they quoted.
 */
export function visibleTextWithParser(text: string): string {
  return new EmailReplyParser().read(text).getVisibleText().trim();
}

/** Register the parser as the shared signature splitter. Call once, in main. */
export function installNodeSignatureSplitter(): void {
  setSignatureSplitter(splitSignaturesWithParser);
  setExtractorSignatureSplitter(splitSignaturesWithParser);
}
