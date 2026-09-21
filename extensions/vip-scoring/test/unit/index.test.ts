import type {
  EmailRecord,
  EmailSyncedEvent,
  ExtensionContext,
  ExtensionWorkflow,
} from '@sarvinbox/core/extension-sdk';
import { describe, it, expect } from 'vitest';


import { DEFAULT_THRESHOLD, VIP_TAG, activate, resolveThreshold } from '../../src/index';
import { TABLE_KEY } from '../../src/profile-store';

const NOW_SECONDS = Math.floor(Date.now() / 1000);

interface Harness {
  workflow: ExtensionWorkflow;
  emit: (event: EmailSyncedEvent) => void;
  saved: () => Record<string, unknown> | undefined;
  errors: unknown[][];
}

function activateHarness(
  settings: Record<string, unknown> = {},
  stored: unknown = undefined
): Harness {
  const errors: unknown[][] = [];
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  let workflow: ExtensionWorkflow | undefined;
  let saved: Record<string, unknown> | undefined;

  const context = {
    manifest: { id: 'vip-scoring' },
    storagePath: '/tmp/vip-scoring',
    registerWorkflow: (registered: ExtensionWorkflow) => {
      workflow = registered;
    },
    unregisterWorkflow: () => undefined,
    events: {
      on: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler]);
        return () => undefined;
      },
      once: () => undefined,
      emit: () => undefined,
    },
    storage: {
      get: async (key: string) => (key === TABLE_KEY ? stored : undefined),
      set: async (key: string, value: unknown) => {
        if (key === TABLE_KEY) saved = value as Record<string, unknown>;
      },
      delete: async () => undefined,
      keys: async () => [],
      clear: async () => undefined,
    },
    settings: {
      get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
      update: async () => undefined,
      has: (key: string) => key in settings,
    },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => errors.push(args),
    },
    subscriptions: [],
  } as unknown as ExtensionContext;

  activate(context);
  if (!workflow) throw new Error('activate did not register a workflow');

  return {
    workflow,
    emit: (event) => handlers.get('email:synced')?.forEach((handler) => handler(event)),
    saved: () => saved,
    errors,
  };
}

function makeEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'email-1',
    fromAddress: 'ada@example.com',
    toAddress: 'me@example.com',
    tags: '|INBOX|',
    date: NOW_SECONDS,
    receivedDate: NOW_SECONDS,
    ...overrides,
  } as unknown as EmailRecord;
}

function syncedEvent(overrides: Partial<EmailSyncedEvent> = {}): EmailSyncedEvent {
  return {
    type: 'email:synced',
    email: makeEmail(),
    folder: 'INBOX',
    isNew: true,
    timestamp: Date.now(),
    ...overrides,
  } as EmailSyncedEvent;
}

const NO_CONTEXT = {} as never;

/** A sender with enough answered, direct, recent mail to clear the threshold. */
function strongHistory(): Record<string, unknown> {
  return {
    'ada@example.com': {
      received: 8,
      replied: 6,
      sent: 4,
      starred: 1,
      direct: 8,
      firstSeen: Date.now() - 1000,
      lastSeen: Date.now(),
    },
  };
}

describe('resolveThreshold', () => {
  // Regression: a corrupted settings value must not be able to mark every
  // sender a VIP (threshold 0) or none at all (a string, which compares false).
  it.each([
    ['missing', undefined],
    ['a string', '0.8'],
    ['NaN', Number.NaN],
    ['above one', 2],
    ['negative', -1],
  ])('falls back to the default for %s', (_label, value) => {
    expect(resolveThreshold(value)).toBe(DEFAULT_THRESHOLD);
  });

  it('honours an in-range value', () => {
    expect(resolveThreshold(0.8)).toBe(0.8);
  });
});

describe('vip-scoring learning', () => {
  // Regression: `email:synced` also fires when an existing message is
  // re-synced. Counting those inflates every counter by however many times the
  // mailbox has been swept — unbounded, and invisible until scores are wrong.
  it('ignores a message that is not new', async () => {
    const harness = activateHarness();
    harness.emit(syncedEvent({ isNew: false }));
    await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(harness.saved()).toBeUndefined();
  });

  // Regression: a disabled extension must stop learning too, not just stop
  // acting — otherwise turning it off still writes a profile table.
  it('does not learn while disabled', async () => {
    const harness = activateHarness({ 'vip-scoring.enabled': false });
    harness.emit(syncedEvent());
    await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(harness.saved()).toBeUndefined();
  });

  // Regression: a malformed header must never break the sync that delivered
  // it. The observation is dropped; the message still arrives.
  it('survives a message it cannot read', () => {
    const harness = activateHarness();
    expect(() => harness.emit(syncedEvent({ email: undefined as never }))).not.toThrow();
    expect(harness.errors).toHaveLength(1);
  });
});

describe('vip-scoring workflow', () => {
  // Regression: a sender we have never seen has no score. Tagging on an
  // absent profile would mark the first message from everyone as a VIP.
  it('does nothing for an unknown sender', async () => {
    const harness = activateHarness();
    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result).toEqual({ success: true });
  });

  // Regression: the feature itself — a sender with real history gets tagged.
  it('tags mail from a sender with strong history', async () => {
    const harness = activateHarness({}, strongHistory());
    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result.labelsToAdd).toEqual([VIP_TAG]);
    expect(result.metadata?.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
  });

  // Regression: raising the threshold must actually suppress the tag.
  it('respects a raised threshold', async () => {
    const harness = activateHarness({ 'vip-scoring.threshold': 0.99 }, strongHistory());
    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result.labelsToAdd).toBeUndefined();
  });

  // Regression: a user who wants the scoring without the relabelling must not
  // have their mail quietly tagged anyway.
  it('omits the tag when tagging is turned off', async () => {
    const harness = activateHarness({ 'vip-scoring.tagVipMail': false }, strongHistory());
    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result.labelsToAdd).toBeUndefined();
    expect(result.success).toBe(true);
  });

  // Regression: an automated address can accumulate huge volume. It must never
  // be promoted, whatever the table says about it.
  it('never tags an unreachable sender', async () => {
    const harness = activateHarness({}, {
      'no-reply@example.com': strongHistory()['ada@example.com'],
    });
    const result = await harness.workflow.process(
      makeEmail({ fromAddress: 'no-reply@example.com' }),
      NO_CONTEXT
    );

    expect(result.labelsToAdd).toBeUndefined();
  });

  // Regression: a disabled extension must not even be asked to score.
  it('is skipped entirely when disabled', async () => {
    const harness = activateHarness({ 'vip-scoring.enabled': false });
    expect(await harness.workflow.shouldProcess(makeEmail())).toBe(false);
  });

  // Regression: a record with no sender cannot be scored; asking anyway costs
  // a table lookup on every such message.
  it('is skipped when the record has no sender', async () => {
    const harness = activateHarness();
    expect(await harness.workflow.shouldProcess(makeEmail({ fromAddress: '' }))).toBe(false);
  });

  // Regression: learning must reach the table the workflow reads, or the
  // extension can observe a thousand messages and still score everyone zero.
  it('scores using what it just learned', async () => {
    const harness = activateHarness({ 'vip-scoring.threshold': 0.1 });
    for (let index = 0; index < 4; index++) {
      harness.emit(syncedEvent({ email: makeEmail({ id: `email-${index}`, tags: '|INBOX|answered|' }) }));
    }
    const result = await harness.workflow.process(makeEmail(), NO_CONTEXT);

    expect(result.labelsToAdd).toEqual([VIP_TAG]);
  });
});
