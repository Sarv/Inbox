// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// One thread is extracted by exactly ONE run — every other caller joins it.
// These tests pin what a JOINER is entitled to: not just the final result, but
// the running extraction's progress. The regression they guard is the reported
// hang — a big thread the background extractor had already started, opened by
// the user, whose AI view then showed a spinner for the whole multi-minute run
// because the only party holding progress callbacks was not the party running
// the job.

const makeAICompletion = vi.fn();
/** Mutable so a test can take the provider away mid-suite (see the failure case). */
const providerRef: { value: { name: string } | null } = { value: { name: 'test-provider' } };
vi.mock('../../../../src/services/ai-service', () => ({
  makeAICompletion: (...args: unknown[]) => makeAICompletion(...args),
  getDefaultProvider: () => providerRef.value,
  loadAIFeatures: () => ({}),
}));

import { extractConversation, type ConversationProgress } from '../../../../src/services/conversation-service';

const email = (id: string, dateSec: number, body: string) => ({
  id,
  threadId: 'thread-join',
  messageId: `<${id}@x.com>`,
  subject: 'Quarterly plan',
  fromAddress: `${id}@x.com`,
  fromName: id,
  toAddress: 'me@x.com',
  date: dateSec,
  rawBody: body,
  cleanBody: body,
  tags: '',
  folderId: 'INBOX',
} as never);

const threadEmails = [
  email('alice', 1_700_000_000, '<p>Kicking off the quarterly plan.</p>'),
  email('bob', 1_700_000_600, '<p>Sounds good, I will draft it.</p>'),
];

/** A promise the test decides when to settle, standing in for the LLM. */
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

const saveConversation = vi.fn(async () => ({ success: true }));

beforeEach(() => {
  makeAICompletion.mockReset();
  saveConversation.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ai: {
      saveConversation,
      getConversation: vi.fn(async () => ({ success: true, data: null })),
    },
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('extractConversation — joining a run already in flight', () => {
  it('feeds the joiner the running extraction’s progress, and still runs the LLM once', async () => {
    // THE reported bug. The background extractor owns the run (it passes no
    // onProgress at all); the user opens that thread and switches to AI view.
    // Before the fix the joiner got silence until the run ended — an empty
    // pane behind a spinner for as long as the thread took.
    const gate = deferred();
    makeAICompletion.mockImplementation(async () => {
      await gate.promise;
      throw new Error('LLM unavailable'); // heuristic fallback — deterministic output
    });

    // Caller 1: the background batch listener — no onProgress.
    const background = extractConversation('thread-join', threadEmails, 'me@x.com', {
      cachedHint: { row: null },
    });
    await Promise.resolve();

    // Caller 2: the UI, mid-run.
    const progress: ConversationProgress[] = [];
    const ui = extractConversation('thread-join', threadEmails, 'me@x.com', {
      cachedHint: { row: null },
      onProgress: (update) => progress.push(update),
    });

    // The replayed snapshot lands synchronously on subscribe — the UI knows the
    // size of the job before the next LLM round-trip completes.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].total).toBe(2);

    gate.release();
    const [backgroundResult, uiResult] = await Promise.all([background, ui]);

    // Same run: one result object, and the thread was extracted once.
    expect(uiResult).toBe(backgroundResult);
    expect(uiResult.messages).toHaveLength(2);
    expect(makeAICompletion).toHaveBeenCalledTimes(2); // one per email, not four
    expect(saveConversation).toHaveBeenCalledTimes(1);

    // Progress ran to completion, not just the replayed snapshot.
    expect(progress[progress.length - 1].done).toBe(2);
    expect(progress.some(p => p.messages.length > 0)).toBe(true);
  });

  it('stops feeding a joiner once its own join resolves', async () => {
    // A leaked listener would outlive the view that registered it and repaint a
    // thread the user has already closed.
    const gate = deferred();
    makeAICompletion.mockImplementation(async () => {
      await gate.promise;
      throw new Error('LLM unavailable');
    });

    const background = extractConversation('thread-join', threadEmails, 'me@x.com', {
      cachedHint: { row: null },
    });
    await Promise.resolve();
    const progress: ConversationProgress[] = [];
    const ui = extractConversation('thread-join', threadEmails, 'me@x.com', {
      cachedHint: { row: null },
      onProgress: (update) => progress.push(update),
    });

    gate.release();
    await Promise.all([background, ui]);
    const countAtResolve = progress.length;

    // A fresh run on the same thread must not reach the previous joiner.
    const second = deferred();
    makeAICompletion.mockImplementation(async () => {
      await second.promise;
      throw new Error('LLM unavailable');
    });
    const later = extractConversation('thread-join', threadEmails, 'me@x.com', {
      cachedHint: { row: null },
    });
    second.release();
    await later;

    expect(progress).toHaveLength(countAtResolve);
  });

  it('releases the in-flight slot when the run fails, so the next caller re-runs', async () => {
    // A rejected run that stayed registered would wedge the thread forever:
    // every later open would join an already-rejected promise and the view
    // could never recover, not even on an explicit retry.
    makeAICompletion.mockRejectedValue(new Error('LLM unavailable'));
    providerRef.value = null;

    await expect(
      extractConversation('thread-fail', threadEmails, 'me@x.com', { cachedHint: { row: null } }),
    ).rejects.toThrow('No AI provider configured');

    providerRef.value = { name: 'test-provider' };
    const progress: ConversationProgress[] = [];
    const retry = await extractConversation('thread-fail', threadEmails, 'me@x.com', {
      cachedHint: { row: null },
      onProgress: (update) => progress.push(update),
    });

    expect(retry.messages).toHaveLength(2);
    expect(progress.length).toBeGreaterThan(0);
  });
});
