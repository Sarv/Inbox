/**
 * What the model is asked, and how tightly.
 *
 * Two rules shape these prompts. The output must be JSON with a fixed shape,
 * because the result is rendered into a typed structure and prose would have to
 * be guessed at. And the model is told, explicitly, not to answer beyond what
 * the mail says — a summary that invents a deadline is worse than no summary,
 * because it reads exactly like one that did not.
 */

import type { AICompletionOptions, EmailForSummary } from '@sarvinbox/core/extension-sdk';

/** Enough for a paragraph, a handful of points and a few actions. */
export const MAX_SUMMARY_TOKENS = 700;

const GROUND_RULES = [
  'Use only what the message text says. Never infer, guess or fill gaps.',
  'If something is not stated, leave it out rather than approximating it.',
  'Write plainly, in the third person, with no preamble and no sign-off.',
  'Reply with a single JSON object and nothing else - no prose, no code fences.',
].join('\n');

export const EMAIL_SYSTEM_PROMPT = [
  'You summarize a single email for someone deciding whether to read it.',
  '',
  GROUND_RULES,
  '',
  'Shape:',
  '{',
  '  "summary": "two or three sentences",',
  '  "key_points": ["short factual point", "..."],',
  '  "action_items": ["something the reader is asked to do", "..."],',
  '  "confidence": 0.0 to 1.0',
  '}',
  '',
  'key_points holds at most five entries. action_items holds only things asked',
  'of the READER; use an empty array when the message asks for nothing.',
  'confidence is how well the text supported the summary - lower it when the',
  'message is truncated, mostly boilerplate, or in a language you read poorly.',
].join('\n');

export const THREAD_SYSTEM_PROMPT = [
  'You summarize an email thread for someone catching up on it.',
  '',
  GROUND_RULES,
  '',
  'Messages are given oldest first, separated by a line of three dashes.',
  'Say where the conversation has GOT TO, not what each message said in turn.',
  '',
  'Shape:',
  '{',
  '  "summary": "three or four sentences on the state of the conversation",',
  '  "key_points": ["what was decided or established", "..."],',
  '  "participants": ["Name <address>", "..."],',
  '  "action_items": ["outstanding thing, and who owes it", "..."],',
  '  "confidence": 0.0 to 1.0',
  '}',
  '',
  'key_points holds at most six entries. Where an action has an owner, name',
  'them. Where the thread is settled, use an empty action_items array rather',
  'than inventing a next step.',
].join('\n');

/** The request for one message. */
export function buildEmailPrompt(rendered: string): AICompletionOptions {
  return {
    systemPrompt: EMAIL_SYSTEM_PROMPT,
    userPrompt: `Summarize this email:\n\n${rendered}`,
    maxTokens: MAX_SUMMARY_TOKENS,
  };
}

/** The request for a thread, with the subject given once up front. */
export function buildThreadPrompt(rendered: string, emails: readonly EmailForSummary[]): AICompletionOptions {
  const subject = emails.find((email) => email.subject?.trim())?.subject?.trim() ?? '(no subject)';
  return {
    systemPrompt: THREAD_SYSTEM_PROMPT,
    userPrompt: [
      `Thread subject: ${subject}`,
      `Messages: ${emails.length}`,
      '',
      rendered,
    ].join('\n'),
    maxTokens: MAX_SUMMARY_TOKENS,
  };
}
