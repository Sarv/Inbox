/**
 * Thread Summary — Sarv Inbox extension.
 *
 * Answers "what is this, and what does it want from me" for a long message or a
 * whole thread: a short paragraph, the points, and anything that reads like it
 * needs doing.
 *
 * Two ways in, one implementation. The app already has a Summarize control that
 * calls `extension:summarizeThread` over IPC; this extension is what that
 * handler resolves, through `context.exports`. The workflow is the same thing
 * run ahead of time for mail long enough to be worth it — off by default,
 * because it spends an AI call per message and only the reader knows whether
 * that is worth it.
 *
 * Everything is keyed by the hash of the text the model was shown, so the two
 * paths share one cache and neither ever pays twice for the same content.
 */

import type {
  EmailForSummary,
  EmailRecord,
  EmailSummarizationExports,
  EmailSummaryResult,
  ExtensionContext,
  ExtensionWorkflowResult,
  ThreadSummaryResult,
} from '@sarvinbox/core/extension-sdk';
import { createSingleFlight } from '@sarvinbox/core/extension-sdk';

import { parseEmailSummary, parseThreadSummary } from './parse';
import { buildEmailPrompt, buildThreadPrompt } from './prompt';
import { TABLE_KEY, contentKey, createSummaryCache, type SummaryCache } from './summary-cache';
import { participants, renderMessage, renderThread } from './thread-text';

const WORKFLOW_ID = 'summarize-email';

const SETTING_ENABLED = 'email-summarization.enabled';
const SETTING_AUTO = 'email-summarization.autoSummarize';
const SETTING_MIN_LENGTH = 'email-summarization.minLength';

/** Shortest message worth an AI call when nothing is configured. */
export const DEFAULT_MIN_LENGTH = 1_500;

/**
 * A message shorter than this is never auto-summarized whatever the setting
 * says. Summarizing four sentences into three is a cost with no reader.
 */
export const FLOOR_MIN_LENGTH = 400;

/** Clamp a configured minimum length, ignoring anything unusable. */
export function resolveMinLength(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) return DEFAULT_MIN_LENGTH;
  return Math.max(FLOOR_MIN_LENGTH, Math.floor(configured));
}

/**
 * The body this record actually has.
 *
 * `cleanBody` is the parsed, reply-stripped text and is what should be
 * summarized. It is empty on rows whose body has not been fetched yet, and
 * empty on HTML-only mail written before the parser fix — hence the fall back
 * to `rawBody`, which the text pipeline converts.
 */
export function bodyOf(email: Pick<EmailRecord, 'cleanBody' | 'rawBody'>): string {
  const clean = typeof email.cleanBody === 'string' ? email.cleanBody.trim() : '';
  if (clean !== '') return clean;
  return typeof email.rawBody === 'string' ? email.rawBody : '';
}

/** An email record in the shape the summarization contract speaks. */
export function toSummaryInput(email: EmailRecord): EmailForSummary {
  return {
    id: email.id,
    subject: email.subject ?? '',
    fromAddress: email.fromAddress ?? '',
    fromName: email.fromName ?? null,
    toAddress: email.toAddress ?? '',
    date: email.date,
    body: bodyOf(email),
  };
}

/** Is this message long enough to be worth summarizing unprompted? */
export function isLongEnough(email: Pick<EmailRecord, 'cleanBody' | 'rawBody'>, minLength: number): boolean {
  return bodyOf(email).length >= minLength;
}

export function activate(context: ExtensionContext): void {
  const cache: SummaryCache = createSummaryCache({
    load: () => context.storage.get(TABLE_KEY),
    save: (table) => context.storage.set(TABLE_KEY, table),
    onError: (error) => context.log.error('Summary cache storage failed', error),
  });

  // One in-flight call per content key. The workflow summarizing on arrival and
  // the reader clicking Summarize a second later hash to the same key; without
  // this they are two AI calls for one answer.
  const inFlight = createSingleFlight<unknown>();

  const isEnabled = (): boolean => context.settings.get<boolean>(SETTING_ENABLED, true) !== false;

  /**
   * Run `compute` unless the answer is already known.
   *
   * `null` is cached alongside a real result on purpose: a model that could not
   * summarize this text will not summarize it on the next click either, and
   * retrying costs the same call for the same nothing.
   */
  async function cached<T>(key: string, compute: () => Promise<T | null>): Promise<T | null> {
    await cache.ready;

    const hit = cache.get<T | null>(key);
    if (hit !== undefined) return hit;

    const result = (await inFlight.run(key, async () => await compute())) as T | null;
    cache.set(key, result ?? null);
    return result;
  }

  function requireAI(): NonNullable<ExtensionContext['ai']> {
    const ai = context.ai;
    // `ai` is absent when the permission was refused, and unavailable when no
    // provider is configured. Both are told apart from a failed summary so the
    // reader is not left thinking the model had nothing to say.
    if (!ai) throw new Error('Summarization needs the ai:use permission');
    if (!ai.isAvailable()) throw new Error('No AI provider is configured');
    return ai;
  }

  async function summarizeEmail(email: EmailForSummary): Promise<EmailSummaryResult> {
    if (!isEnabled()) throw new Error('Summarization is turned off');
    if (!email || typeof email !== 'object') throw new Error('No email to summarize');

    const rendered = renderMessage(email);
    const result = await cached<EmailSummaryResult>(contentKey(`email:${rendered}`), async () => {
      const completion = await requireAI().complete(buildEmailPrompt(rendered));
      return parseEmailSummary(completion);
    });

    // The contract returns a result, not a maybe: the caller is a button the
    // reader just pressed, and it needs something to say.
    if (!result) throw new Error('The model did not return a usable summary');
    return result;
  }

  async function summarizeThread(emails: EmailForSummary[]): Promise<ThreadSummaryResult | null> {
    if (!isEnabled()) throw new Error('Summarization is turned off');
    if (!Array.isArray(emails) || emails.length === 0) return null;

    // A thread of one renders and summarizes fine — the prompt asks where the
    // conversation has got to, and for one message that is what it says.
    const rendered = renderThread(emails);
    if (rendered.trim() === '') return null;

    const known = participants(emails);
    return await cached<ThreadSummaryResult>(contentKey(`thread:${rendered}`), async () => {
      const completion = await requireAI().complete(buildThreadPrompt(rendered, emails));
      return parseThreadSummary(completion, known);
    });
  }

  const exported: EmailSummarizationExports = { summarizeEmail, summarizeThread };
  context.exports = exported as unknown as Record<string, unknown>;

  context.registerWorkflow({
    id: WORKFLOW_ID,
    name: 'Summarize long mail',
    description: 'Summarizes a long message as it arrives so opening it is instant',
    priority: 30,
    requiresAI: true,
    // The body is fetched after the message arrives, so the arrival pass sees
    // nothing to summarize. This workflow runs twice per message and is
    // idempotent: the second pass hits the cache the first one could not fill.
    requiresBody: true,

    shouldProcess: (email: EmailRecord): boolean => {
      if (!isEnabled()) return false;
      if (context.settings.get<boolean>(SETTING_AUTO, false) !== true) return false;
      return isLongEnough(email, resolveMinLength(context.settings.get<number>(SETTING_MIN_LENGTH)));
    },

    process: async (email: EmailRecord): Promise<ExtensionWorkflowResult> => {
      try {
        const summary = await summarizeEmail(toSummaryInput(email));
        // The summary is not returned as a modification: there is no column on
        // the email record to hold one. It lives in this extension's cache,
        // which is what the Summarize control reads — so the work done here
        // shows up as an instant answer rather than as a stored field.
        return {
          success: true,
          metadata: {
            summarized: true,
            confidence: summary.confidence,
            keyPoints: summary.key_points.length,
            actionItems: summary.action_items?.length ?? 0,
          },
        };
      } catch (error) {
        context.log.error('Summarization failed', error);
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  });

  // Whatever was summarized must reach disk when the app closes; the flush
  // interval means the last few are otherwise still in memory.
  context.subscriptions.push(() => {
    void cache.dispose();
  });
}
