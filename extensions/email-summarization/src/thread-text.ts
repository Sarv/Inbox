/**
 * Turning mail into the text a model is actually shown.
 *
 * Three things have to happen before a body is worth sending anywhere. It has
 * to be plain text, because an HTML body is mostly table scaffolding and the
 * model would spend its attention on layout. The quoted tail has to go, because
 * a ten-message thread repeats message one ten times and a summary built from
 * that says the same thing ten different ways. And the whole thing has to fit a
 * budget, because bodies are attacker-controlled and unbounded.
 *
 * The HTML conversion and the quote cut are the APP's implementations, imported
 * from the SDK rather than rewritten here. A second quote-marker list is the
 * worst kind of duplication: both copies keep returning a plausible string while
 * they drift apart.
 */

import type { EmailForSummary } from '@sarvinbox/core/extension-sdk';
// The text helpers live behind their own entry point because they carry
// CommonJS dependencies that cannot be tree-shaken; importing this path is how
// an extension opts into that weight. See packages/core/src/extension-sdk-text.ts.
import { htmlToPlainText, stripQuotedTail } from '@sarvinbox/core/extension-sdk/text';

/** Longest single message included, in characters. */
export const MAX_MESSAGE_CHARS = 4_000;

/** Longest rendered thread handed to the model, in characters. */
export const MAX_THREAD_CHARS = 24_000;

/** Most messages included from one thread. */
export const MAX_THREAD_MESSAGES = 20;

/**
 * Does this body need the HTML converter?
 *
 * Deliberately crude: the converter is the expensive part, and running it on
 * text that has no markup only costs time. A single tag-shaped run is enough to
 * justify it, and a plain-text body containing a stray `<` does not match
 * because a tag name must follow.
 */
export function looksLikeHtml(body: string): boolean {
  return /<(?:[a-z][a-z0-9]*|\/[a-z])\b[^>]*>/i.test(body);
}

/** Collapse runs of whitespace, keeping paragraph breaks. */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cut to `limit` characters on a word boundary where there is one nearby. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour the word boundary if it is not throwing away real content — a
  // body with no spaces at all (a base64 blob, CJK text) must still be cut.
  return (lastSpace > limit * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Plain, unquoted, budgeted text of one message body. */
export function readableBody(body: string | null | undefined): string {
  if (typeof body !== 'string' || body.trim() === '') return '';
  const plain = looksLikeHtml(body) ? htmlToPlainText(body) : body;
  return truncate(collapseWhitespace(stripQuotedTail(plain)), MAX_MESSAGE_CHARS);
}

/** How a sender is named in the rendered thread. */
export function senderLabel(email: EmailForSummary): string {
  const name = email.fromName?.trim();
  const address = email.fromAddress?.trim() ?? '';
  if (name && address) return `${name} <${address}>`;
  return name || address || 'unknown sender';
}

/**
 * ISO-8601 UTC for a message date.
 *
 * `EmailForSummary.date` is unix SECONDS, like every other date on an email
 * record. Feeding it to `new Date()` as milliseconds dates every message to
 * January 1970, which a model will happily narrate back as fact.
 */
export function messageTimestamp(date: number): string {
  if (!Number.isFinite(date) || date <= 0) return 'unknown date';
  return new Date(date * 1000).toISOString();
}

/** One message, as the model sees it. */
export function renderMessage(email: EmailForSummary): string {
  const body = readableBody(email.body);
  return [
    `From: ${senderLabel(email)}`,
    `Date: ${messageTimestamp(email.date)}`,
    `Subject: ${email.subject?.trim() || '(no subject)'}`,
    '',
    body || '(no readable text)',
  ].join('\n');
}

/**
 * The whole thread, oldest first, within budget.
 *
 * When a thread does not fit, the OLDEST messages are dropped rather than the
 * newest. A summary is read to find out where a conversation has got to, so the
 * latest message is the one that must never be the one that was cut.
 */
export function renderThread(emails: readonly EmailForSummary[]): string {
  const ordered = [...emails].sort((left, right) => left.date - right.date);
  const recent = ordered.slice(-MAX_THREAD_MESSAGES);

  const kept: string[] = [];
  let budget = MAX_THREAD_CHARS;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const rendered = renderMessage(recent[index]);
    // +2 for the separator this block will need once it is joined.
    const cost = rendered.length + 2;
    if (cost > budget && kept.length > 0) break;
    kept.unshift(rendered);
    budget -= cost;
  }

  // A single message bigger than the whole budget still has to be summarized —
  // it is exactly the case a user reaches for a summary on — so it is cut to
  // the budget rather than dropped.
  return truncate(kept.join('\n\n---\n\n'), MAX_THREAD_CHARS);
}

/** Every distinct sender in the thread, in the order they first appear. */
export function participants(emails: readonly EmailForSummary[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const email of [...emails].sort((left, right) => left.date - right.date)) {
    const address = email.fromAddress?.trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    names.push(senderLabel(email));
  }
  return names;
}
