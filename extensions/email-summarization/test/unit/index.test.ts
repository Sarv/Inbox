import type {
  EmailForSummary,
  EmailRecord,
  EmailSummarizationExports,
  ExtensionContext,
  ExtensionWorkflow,
} from '@sarvinbox/core/extension-sdk';
import { describe, expect, it } from 'vitest';


import {
  DEFAULT_MIN_LENGTH,
  FLOOR_MIN_LENGTH,
  activate,
  bodyOf,
  isLongEnough,
  resolveMinLength,
  toSummaryInput,
} from '../../src/index';
import { TABLE_KEY } from '../../src/summary-cache';

const NOW_SECONDS = Math.floor(Date.UTC(2026, 0, 15, 9, 0, 0) / 1000);

/** This workflow reads nothing from the execution context. */
const NO_CONTEXT = {} as never;

const GOOD_ANSWER = JSON.stringify({
  summary: 'The renewal is due on Friday.',
  key_points: ['Renewal date is Friday'],
  action_items: ['Confirm the seat count'],
  confidence: 0.8,
});

function record(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'msg-1',
    subject: 'Renewal',
    fromAddress: 'dana@example.com',
    fromName: 'Dana',
    toAddress: 'me@example.com',
    date: NOW_SECONDS,
    cleanBody: 'The renewal is due on Friday. Please confirm the seat count.',
    rawBody: '',
    ...overrides,
  } as unknown as EmailRecord;
}

function summaryInput(overrides: Partial<EmailForSummary> = {}): EmailForSummary {
  return {
    id: 'msg-1',
    subject: 'Renewal',
    fromAddress: 'dana@example.com',
    fromName: 'Dana',
    toAddress: 'me@example.com',
    date: NOW_SECONDS,
    body: 'The renewal is due on Friday.',
    ...overrides,
  };
}

interface Harness {
  workflow: ExtensionWorkflow;
  exports: EmailSummarizationExports;
  completions: number;
  prompts: string[];
  saved: () => Record<string, unknown> | undefined;
  errors: unknown[][];
  /** Tear down, which flushes the cache, then report what reached storage. */
  workflowFlush: () => Promise<void>;
  teardown: () => void;
}

interface HarnessOptions {
  settings?: Record<string, unknown>;
  stored?: unknown;
  /** Answers returned in order; the last one repeats. */
  answers?: string[];
  aiAvailable?: boolean;
  withAI?: boolean;
  completeError?: Error;
}

function activateHarness(options: HarnessOptions = {}): Harness {
  const settings = options.settings ?? {};
  const answers = options.answers ?? [GOOD_ANSWER];
  const errors: unknown[][] = [];
  const prompts: string[] = [];
  let completions = 0;
  let workflow: ExtensionWorkflow | undefined;
  let saved: Record<string, unknown> | undefined;

  const ai = {
    isAvailable: () => options.aiAvailable !== false,
    complete: async ({ userPrompt }: { userPrompt: string }) => {
      if (options.completeError) throw options.completeError;
      prompts.push(userPrompt);
      const answer = answers[Math.min(completions, answers.length - 1)];
      completions += 1;
      return answer;
    },
    categorize: async () => ({ category: '', categories: [], confidence: 0 }),
    generateReplySuggestions: async () => [],
    summarize: async () => '',
    extractActionItems: async () => [],
  };

  const context = {
    manifest: { id: 'email-summarization' },
    storagePath: '/tmp/email-summarization',
    registerWorkflow: (registered: ExtensionWorkflow) => {
      workflow = registered;
    },
    unregisterWorkflow: () => undefined,
    events: { on: () => () => undefined, once: () => undefined, emit: () => undefined },
    storage: {
      get: async (key: string) => (key === TABLE_KEY ? options.stored : undefined),
      set: async (key: string, value: unknown) => {
        if (key === TABLE_KEY) saved = value as Record<string, unknown>;
      },
      delete: async () => undefined,
      keys: async () => [],
      clear: async () => undefined,
    },
    ...(options.withAI === false ? {} : { ai }),
    settings: {
      get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
      update: async () => undefined,
      has: (key: string) => key in settings,
    },
    ui: { notify: async () => undefined, dismiss: async () => undefined },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => errors.push(args),
    },
    exports: {},
    subscriptions: [] as (() => void)[],
  } as unknown as ExtensionContext;

  activate(context);
  if (!workflow) throw new Error('activate did not register a workflow');

  return {
    workflow,
    exports: context.exports as unknown as EmailSummarizationExports,
    get completions() {
      return completions;
    },
    prompts,
    saved: () => saved,
    errors,
    workflowFlush: async () => {
      for (const unsubscribe of context.subscriptions) unsubscribe();
      // The dispose the subscription kicked off is a floating promise; one turn
      // of the microtask queue is enough for it to have written.
      await Promise.resolve();
      await Promise.resolve();
    },
    teardown: () => {
      for (const unsubscribe of context.subscriptions) unsubscribe();
    },
  };
}

describe('resolveMinLength', () => {
  // Regression: a NaN or negative threshold from a hand-edited settings file
  // would summarize every one-line acknowledgement in the mailbox.
  it('falls back and floors an unusable value', () => {
    expect(resolveMinLength(3_000)).toBe(3_000);
    expect(resolveMinLength(undefined)).toBe(DEFAULT_MIN_LENGTH);
    expect(resolveMinLength('2000')).toBe(DEFAULT_MIN_LENGTH);
    expect(resolveMinLength(Number.NaN)).toBe(DEFAULT_MIN_LENGTH);
    expect(resolveMinLength(0)).toBe(FLOOR_MIN_LENGTH);
    expect(resolveMinLength(-500)).toBe(FLOOR_MIN_LENGTH);
  });
});

describe('bodyOf', () => {
  // Regression: cleanBody is empty both before the body is fetched AND on
  // HTML-only mail written before the parser fix. Without the fall back those
  // messages can never be summarized.
  it('prefers the cleaned body and falls back to the raw one', () => {
    expect(bodyOf({ cleanBody: 'clean', rawBody: '<p>raw</p>' } as EmailRecord)).toBe('clean');
    expect(bodyOf({ cleanBody: '   ', rawBody: '<p>raw</p>' } as EmailRecord)).toBe('<p>raw</p>');
    expect(bodyOf({ cleanBody: '', rawBody: '' } as EmailRecord)).toBe('');
    expect(bodyOf({} as EmailRecord)).toBe('');
  });
});

describe('isLongEnough', () => {
  // Regression: summarizing four sentences into three spends an AI call for no
  // reader.
  it('measures the body that would actually be summarized', () => {
    expect(isLongEnough({ cleanBody: 'x'.repeat(500), rawBody: '' } as EmailRecord, 400)).toBe(true);
    expect(isLongEnough({ cleanBody: 'x'.repeat(399), rawBody: '' } as EmailRecord, 400)).toBe(false);
    expect(isLongEnough({ cleanBody: '', rawBody: 'y'.repeat(500) } as EmailRecord, 400)).toBe(true);
  });
});

describe('toSummaryInput', () => {
  // Regression: the IPC contract is a fixed shape. A missing field arriving as
  // undefined ends up rendered as "undefined" in the prompt.
  it('fills every field of the contract', () => {
    const input = toSummaryInput(record({ subject: undefined, fromName: undefined } as Partial<EmailRecord>));
    expect(input).toEqual({
      id: 'msg-1',
      subject: '',
      fromAddress: 'dana@example.com',
      fromName: null,
      toAddress: 'me@example.com',
      date: NOW_SECONDS,
      body: 'The renewal is due on Friday. Please confirm the seat count.',
    });
  });
});

describe('activate', () => {
  // Regression: the app's Summarize control reaches this extension through
  // getExtensionExports. Without both functions on context.exports the IPC
  // handler reports "extension not available" and the button does nothing.
  it('exposes the summarization contract on context.exports', () => {
    const harness = activateHarness();
    expect(typeof harness.exports.summarizeEmail).toBe('function');
    expect(typeof harness.exports.summarizeThread).toBe('function');
    harness.teardown();
  });

  // Regression: the body is fetched after the message arrives, so a workflow
  // without requiresBody only ever sees an empty one.
  it('registers a body-stage workflow', () => {
    const harness = activateHarness();
    expect(harness.workflow.id).toBe('summarize-email');
    expect(harness.workflow.requiresBody).toBe(true);
    expect(harness.workflow.requiresAI).toBe(true);
    harness.teardown();
  });
});

describe('summarizeEmail', () => {
  // Regression: the happy path has to survive rendering, the prompt, the model's
  // fences and the parser.
  it('returns a parsed summary', async () => {
    const harness = activateHarness();
    const result = await harness.exports.summarizeEmail(summaryInput());

    expect(result.summary).toBe('The renewal is due on Friday.');
    expect(result.action_items).toEqual(['Confirm the seat count']);
    expect(result.confidence).toBe(0.8);
    harness.teardown();
  });

  // Regression: an AI call costs money and seconds. Asking twice for the same
  // text must cost once.
  it('serves the second request for the same text from the cache', async () => {
    const harness = activateHarness();
    await harness.exports.summarizeEmail(summaryInput());
    await harness.exports.summarizeEmail(summaryInput());

    expect(harness.completions).toBe(1);
    harness.teardown();
  });

  // Regression: the cache key is the content, not the id. A message whose body
  // changed must not be answered from the old summary.
  it('recomputes when the content differs', async () => {
    const harness = activateHarness();
    await harness.exports.summarizeEmail(summaryInput());
    await harness.exports.summarizeEmail(summaryInput({ body: 'Something else entirely.' }));

    expect(harness.completions).toBe(2);
    harness.teardown();
  });

  // Regression: the workflow summarizing on arrival and the reader pressing
  // Summarize a second later hash to the same key — without coalescing that is
  // two calls for one answer.
  it('coalesces concurrent requests for the same text', async () => {
    const harness = activateHarness();
    const [first, second] = await Promise.all([
      harness.exports.summarizeEmail(summaryInput()),
      harness.exports.summarizeEmail(summaryInput()),
    ]);

    expect(harness.completions).toBe(1);
    expect(first).toEqual(second);
    harness.teardown();
  });

  // Regression: a model that could not summarize this text will not summarize
  // it on the next click either. Retrying costs the same call for the same
  // nothing.
  it('remembers an unusable answer instead of retrying it', async () => {
    const harness = activateHarness({ answers: ['I am unable to help with that.'] });

    await expect(harness.exports.summarizeEmail(summaryInput())).rejects.toThrow(/usable summary/);
    await expect(harness.exports.summarizeEmail(summaryInput())).rejects.toThrow(/usable summary/);
    expect(harness.completions).toBe(1);
    harness.teardown();
  });

  // Regression: "no provider configured" and "the model had nothing to say" are
  // different problems, and only one of them is the reader's to fix.
  it('says which of the AI preconditions failed', async () => {
    const noPermission = activateHarness({ withAI: false });
    await expect(noPermission.exports.summarizeEmail(summaryInput())).rejects.toThrow(/ai:use permission/);
    noPermission.teardown();

    const noProvider = activateHarness({ aiAvailable: false });
    await expect(noProvider.exports.summarizeEmail(summaryInput())).rejects.toThrow(/No AI provider/);
    noProvider.teardown();
  });

  // Regression: a provider outage is transient. Caching it as "no summary"
  // would make the failure permanent until the cache is evicted.
  // Regression: the counterpart to the test below — a summary that succeeded
  // must reach storage on teardown, or the "nothing was written" assertion
  // there would pass for the wrong reason.
  it('writes a successful summary to storage on teardown', async () => {
    const harness = activateHarness();
    await harness.exports.summarizeEmail(summaryInput());
    await harness.workflowFlush();

    expect(Object.keys(harness.saved() ?? {})).toHaveLength(1);
  });

  it('does not cache a failed AI call', async () => {
    const harness = activateHarness({ completeError: new Error('rate limited') });

    await expect(harness.exports.summarizeEmail(summaryInput())).rejects.toThrow(/rate limited/);
    await expect(harness.exports.summarizeEmail(summaryInput())).rejects.toThrow(/rate limited/);

    // Nothing was written for that key, so the retry is a real one rather than
    // a cached failure replayed.
    await harness.workflowFlush();
    expect(harness.saved()).toBeUndefined();
    harness.teardown();
  });

  // Regression: the setting has to stop the AI call, not just hide the result.
  it('refuses when summarization is turned off', async () => {
    const harness = activateHarness({ settings: { 'email-summarization.enabled': false } });
    await expect(harness.exports.summarizeEmail(summaryInput())).rejects.toThrow(/turned off/);
    expect(harness.completions).toBe(0);
    harness.teardown();
  });
});

describe('summarizeThread', () => {
  function thread(count: number): EmailForSummary[] {
    return Array.from({ length: count }, (_, index) =>
      summaryInput({
        id: `msg-${index}`,
        date: NOW_SECONDS + index * 3_600,
        body: `Message number ${index} with enough words to be worth reading.`,
        fromAddress: index % 2 === 0 ? 'dana@example.com' : 'me@example.com',
      })
    );
  }

  // Regression: the thread result carries participants, which the UI lists.
  it('returns a parsed thread summary', async () => {
    const harness = activateHarness({
      answers: [JSON.stringify({ summary: 'Still deciding.', key_points: ['Two options'], confidence: 0.6 })],
    });
    const result = await harness.exports.summarizeThread(thread(3));

    expect(result?.summary).toBe('Still deciding.');
    // Falls back to the senders we derived, because the model returned none.
    expect(result?.participants).toEqual(['Dana <dana@example.com>', 'Dana <me@example.com>']);
    harness.teardown();
  });

  // Regression: an empty or unusable thread must not reach the model at all.
  it('returns null without calling the model for nothing to summarize', async () => {
    const harness = activateHarness();

    expect(await harness.exports.summarizeThread([])).toBeNull();
    expect(await harness.exports.summarizeThread(undefined as unknown as EmailForSummary[])).toBeNull();
    expect(harness.completions).toBe(0);
    harness.teardown();
  });

  // Regression: a thread and a single message that render to the same text are
  // still different questions; sharing a cache key would serve one as the other.
  it('keys a thread apart from a single email', async () => {
    const harness = activateHarness();
    const one = [summaryInput()];

    await harness.exports.summarizeThread(one);
    await harness.exports.summarizeEmail(one[0]);

    expect(harness.completions).toBe(2);
    harness.teardown();
  });
});

describe('the auto-summarize workflow', () => {
  // Regression: an AI call per arriving message is an expense the reader did
  // not ask for, so it stays off until they do.
  it('does nothing unless autoSummarize is on', () => {
    const off = activateHarness();
    expect(off.workflow.shouldProcess?.(record({ cleanBody: 'x'.repeat(5_000) }))).toBe(false);
    off.teardown();

    const on = activateHarness({ settings: { 'email-summarization.autoSummarize': true } });
    expect(on.workflow.shouldProcess?.(record({ cleanBody: 'x'.repeat(5_000) }))).toBe(true);
    on.teardown();
  });

  // Regression: short mail is the bulk of a mailbox; summarizing it is the
  // whole cost with none of the benefit.
  it('skips a message shorter than the configured minimum', () => {
    const harness = activateHarness({
      settings: { 'email-summarization.autoSummarize': true, 'email-summarization.minLength': 2_000 },
    });

    expect(harness.workflow.shouldProcess?.(record({ cleanBody: 'x'.repeat(1_999) }))).toBe(false);
    expect(harness.workflow.shouldProcess?.(record({ cleanBody: 'x'.repeat(2_000) }))).toBe(true);
    harness.teardown();
  });

  // Regression: the master switch has to stop the workflow too, not only the
  // on-demand path.
  it('is inert when summarization is turned off', () => {
    const harness = activateHarness({
      settings: { 'email-summarization.enabled': false, 'email-summarization.autoSummarize': true },
    });
    expect(harness.workflow.shouldProcess?.(record({ cleanBody: 'x'.repeat(5_000) }))).toBe(false);
    harness.teardown();
  });

  // Regression: the work is only worth doing if the reader's later click hits
  // the cache the workflow filled. If the two hashed differently it would be
  // paid for twice.
  it('warms the cache the on-demand path reads', async () => {
    const harness = activateHarness({ settings: { 'email-summarization.autoSummarize': true } });
    const email = record();

    const result = await harness.workflow.process(email, NO_CONTEXT);
    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({ summarized: true, actionItems: 1 });

    await harness.exports.summarizeEmail(toSummaryInput(email));
    expect(harness.completions).toBe(1);
    harness.teardown();
  });

  // Regression: the summary has nowhere to persist — there is no column for it
  // on the email record — so returning it as a modification would drop it
  // silently and hide the fact that the cache is the only home it has.
  it('reports metadata rather than a modification', async () => {
    const harness = activateHarness({ settings: { 'email-summarization.autoSummarize': true } });
    const result = await harness.workflow.process(record(), NO_CONTEXT);

    expect(result.modifications).toBeUndefined();
    harness.teardown();
  });

  // Regression: a provider outage must not fail the sync that delivered the
  // message.
  it('reports a failure instead of throwing into the pipeline', async () => {
    const harness = activateHarness({
      settings: { 'email-summarization.autoSummarize': true },
      completeError: new Error('rate limited'),
    });
    const result = await harness.workflow.process(record(), NO_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('rate limited');
    expect(harness.errors).toHaveLength(1);
    harness.teardown();
  });

  // Regression: the workflow runs twice per message (arrival, then body). The
  // second pass must not pay for the summary again.
  it('is idempotent across the arrival and body passes', async () => {
    const harness = activateHarness({ settings: { 'email-summarization.autoSummarize': true } });
    const email = record();

    await harness.workflow.process(email, NO_CONTEXT);
    await harness.workflow.process(email, NO_CONTEXT);

    expect(harness.completions).toBe(1);
    harness.teardown();
  });
});
