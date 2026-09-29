import { describe, expect, it } from 'vitest';

import {
  FIRST_SPLIT_BACKOFF_CAP_SECONDS,
  FIRST_SPLIT_MAX_ATTEMPTS,
  FIRST_SPLIT_VERSION,
  firstMemberKeyOf,
  firstSplitBackoffSeconds,
  firstSplitKeyFor,
  firstSplitStateFor,
  isFirstSplitCurrent,
  isSameFirstSplitKey,
  isUsableSplit,
  nextFailureState,
  parseFirstSplitParts,
  shouldReplace,
  sourceFingerprintOf,
  type FirstSplitKey,
  type FirstSplitPart,
  type FirstSplitRow,
} from '../../../src/utils/first-split';

// What breaks if this file fails: the first-email split cache. A wrong key
// serves one email's quoted history in another email's slot; a wrong replace
// rule lets a failed re-split destroy a good one; a wrong retry rule turns the
// 45-second background scheduler into a paid-API retry storm.

const NOW = 1_800_000_000;

const PART: FirstSplitPart = {
  role: 'own', fromAddress: 'a@x.com', fromName: 'A', date: 1_700_000_000, dateApprox: false,
  body: '<p>Hello</p>', fallback: false,
};
const QUOTE: FirstSplitPart = { ...PART, role: 'quote', fromAddress: 'b@x.com', fromName: null, dateApprox: true };
const PARTS_JSON = JSON.stringify([PART, QUOTE]);

const KEY: FirstSplitKey = firstSplitKeyFor('t1', { id: 'e1', messageId: '<Abc@Host>' }, '<p>body</p>');

const rowFor = (key: FirstSplitKey, over: Partial<FirstSplitRow> = {}): FirstSplitRow => ({
  threadId: key.threadId,
  firstKey: key.firstKey,
  firstEmailId: key.firstEmailId,
  sourceFingerprint: key.fingerprint,
  splitVersion: FIRST_SPLIT_VERSION,
  status: 'ok',
  quoteCount: 2,
  parts: PARTS_JSON,
  errorKind: null,
  attempts: 0,
  nextRetryAt: null,
  modelUsed: 'openai:gpt',
  updatedAt: NOW,
  ...over,
});

describe('first-email key', () => {
  // Breaks: servers, clients and our storage disagree about brackets and case,
  // so the same first email reads as a different one and every split is stale.
  it('is equal for <ABC@h>, abc@h and " <abc@H> "', () => {
    const a = firstMemberKeyOf({ id: 'x', messageId: '<ABC@h>' });
    expect(firstMemberKeyOf({ id: 'y', messageId: 'abc@h' })).toBe(a);
    expect(firstMemberKeyOf({ id: 'z', messageId: ' <abc@H> ' })).toBe(a);
    expect(a).toBe('abc@h');
  });

  // Breaks: two Message-ID-less emails share the key '' and one's split is
  // served for the other.
  it("falls back to 'id:<row id>' without a Message-ID", () => {
    expect(firstMemberKeyOf({ id: 'row-7', messageId: '' })).toBe('id:row-7');
    expect(firstMemberKeyOf({ id: 'row-8', messageId: null })).toBe('id:row-8');
    expect(firstMemberKeyOf({ id: 'row-9' })).toBe('id:row-9');
  });

  it('carries the thread, first email and fingerprint', () => {
    expect(KEY).toEqual({
      threadId: 't1', firstKey: 'abc@host', firstEmailId: 'e1', fingerprint: sourceFingerprintOf('<p>body</p>'),
    });
  });
});

describe('source fingerprint', () => {
  // Breaks: the fingerprint moves between runs of the same bytes (every split
  // stale on every open) or misses a re-healed body (a split of the old body
  // shown over the new one).
  it('is stable and changes whenever the body changes', () => {
    expect(sourceFingerprintOf('<p>body</p>')).toBe(sourceFingerprintOf('<p>body</p>'));
    expect(sourceFingerprintOf('<p>body</p>')).not.toBe(sourceFingerprintOf('<p>body!</p>'));
    expect(sourceFingerprintOf('<p>body</p>')).not.toBe(sourceFingerprintOf('<p>Body</p>'));
    expect(sourceFingerprintOf('<p>body</p>')).toMatch(/^11:[0-9a-f]{8}$/);
  });

  it('treats a missing body as empty', () => {
    expect(sourceFingerprintOf(null)).toBe(sourceFingerprintOf(''));
    expect(sourceFingerprintOf(undefined)).toBe('0:811c9dc5');
  });
});

describe('isFirstSplitCurrent / isUsableSplit', () => {
  // Breaks: serving a stale split — another version's shape, another first
  // email's history, or a split of a body that has since been re-healed.
  it('accepts only the same version, thread, first key and fingerprint', () => {
    const row = rowFor(KEY);
    expect(isFirstSplitCurrent(row, KEY)).toBe(true);
    expect(isUsableSplit(row, KEY)).toBe(true);
    expect(isUsableSplit(rowFor(KEY, { splitVersion: FIRST_SPLIT_VERSION + 1 }), KEY)).toBe(false);
    expect(isUsableSplit(rowFor(KEY, { firstKey: 'other@h' }), KEY)).toBe(false);
    expect(isUsableSplit(rowFor(KEY, { sourceFingerprint: '1:00000000' }), KEY)).toBe(false);
    expect(isUsableSplit(rowFor(KEY, { threadId: 't2' }), KEY)).toBe(false);
    expect(isFirstSplitCurrent(null, KEY)).toBe(false);
    expect(isFirstSplitCurrent(rowFor(KEY), null)).toBe(false);
    expect(isUsableSplit(undefined, KEY)).toBe(false);
  });

  // The row id is not part of validity: a resync that re-creates the row keeps
  // the same message and the same split.
  it('does not depend on the first email row id', () => {
    expect(isUsableSplit(rowFor(KEY, { firstEmailId: 'recreated' }), KEY)).toBe(true);
  });

  // Breaks: a non-success row, or one whose parts cannot be read, is shown as
  // a split and the first slot renders nothing (history stripped).
  it('rejects non-success statuses, malformed JSON and a blank part', () => {
    for (const status of ['skipped', 'transient', 'failed'] as const) {
      expect(isUsableSplit(rowFor(KEY, { status }), KEY)).toBe(false);
    }
    expect(isUsableSplit(rowFor(KEY, { status: 'partial' }), KEY)).toBe(true);
    expect(isUsableSplit(rowFor(KEY, { parts: '[{"role":' }), KEY)).toBe(false);
    expect(isUsableSplit(rowFor(KEY, { parts: JSON.stringify([{ ...PART, body: '   ' }]) }), KEY)).toBe(false);
    expect(isUsableSplit(rowFor(KEY, { parts: null }), KEY)).toBe(false);
  });
});

describe('parseFirstSplitParts', () => {
  it('returns the parts of a well-formed row', () => {
    expect(parseFirstSplitParts(PARTS_JSON)).toEqual([PART, QUOTE]);
  });

  // Breaks: a corrupt or hand-edited row crashes the first slot, or a part
  // with no usable date/body renders as an empty bubble.
  it('rejects every malformed shape', () => {
    const bad: unknown[] = [
      null, undefined, '', 'not json', '{}', '[]', '"a string"', '[null]', '[1]',
      JSON.stringify([{ ...PART, role: 'other' }]),
      JSON.stringify([{ ...PART, fromAddress: 3 }]),
      JSON.stringify([{ ...PART, fromName: 3 }]),
      JSON.stringify([{ ...PART, date: 0 }]),
      JSON.stringify([{ ...PART, date: -1 }]),
      JSON.stringify([{ ...PART, date: '2025-01-01' }]),
      JSON.stringify([{ ...PART, dateApprox: 'yes' }]),
      JSON.stringify([{ ...PART, body: '' }]),
      JSON.stringify([{ ...PART, body: 5 }]),
      JSON.stringify([{ ...PART, fallback: 1 }]),
    ];
    for (const json of bad) expect(parseFirstSplitParts(json as string)).toBeNull();
  });

  // Breaks: two parts both take the first email's own id and one bubble
  // silently replaces the other.
  it('rejects more than one own part', () => {
    expect(parseFirstSplitParts(JSON.stringify([PART, PART]))).toBeNull();
    expect(parseFirstSplitParts(JSON.stringify([QUOTE, QUOTE]))).toHaveLength(2);
  });
});

describe('firstSplitStateFor — every branch', () => {
  it('usable for a current success', () => {
    expect(firstSplitStateFor(rowFor(KEY), KEY, NOW)).toBe('usable');
    expect(firstSplitStateFor(rowFor(KEY, { status: 'partial' }), KEY, NOW)).toBe('usable');
  });

  // Breaks: a missing, stale or unreadable row is treated as done and the
  // thread is never split again.
  it('miss for no row, a stale row, or unreadable parts', () => {
    expect(firstSplitStateFor(null, KEY, NOW)).toBe('miss');
    expect(firstSplitStateFor(rowFor(KEY, { firstKey: 'moved@h' }), KEY, NOW)).toBe('miss');
    expect(firstSplitStateFor(rowFor(KEY, { parts: 'garbage' }), KEY, NOW)).toBe('miss');
    expect(firstSplitStateFor(rowFor(KEY, { status: 'future' as never }), KEY, NOW)).toBe('miss');
  });

  it('skipped for a skipped row', () => {
    expect(firstSplitStateFor(rowFor(KEY, { status: 'skipped', parts: null }), KEY, NOW)).toBe('skipped');
  });

  // Breaks: a transient failure retried before its backoff (storm), never
  // retried (stuck), or retried forever.
  it('due / retry-later / failed for a transient row', () => {
    const transient = (over: Partial<FirstSplitRow>) =>
      rowFor(KEY, { status: 'transient', parts: null, attempts: 1, ...over });
    expect(firstSplitStateFor(transient({ nextRetryAt: NOW - 1 }), KEY, NOW)).toBe('due');
    expect(firstSplitStateFor(transient({ nextRetryAt: NOW }), KEY, NOW)).toBe('due');
    expect(firstSplitStateFor(transient({ nextRetryAt: null }), KEY, NOW)).toBe('due');
    expect(firstSplitStateFor(transient({ nextRetryAt: NOW + 60 }), KEY, NOW)).toBe('retry-later');
    expect(firstSplitStateFor(transient({ attempts: FIRST_SPLIT_MAX_ATTEMPTS, nextRetryAt: NOW - 1 }), KEY, NOW))
      .toBe('failed');
  });

  // Breaks: a provider-wide 4xx (bad model name, bad request shape) is recorded
  // as permanent per thread and never retried after the user fixes the
  // provider.
  it('failed-retryable only for a 4xx under a different provider signature', () => {
    const failed = (over: Partial<FirstSplitRow>) =>
      rowFor(KEY, { status: 'failed', parts: null, errorKind: 'client', modelUsed: 'openai:gpt', ...over });
    expect(firstSplitStateFor(failed({}), KEY, NOW, 'anthropic:claude')).toBe('failed-retryable');
    expect(firstSplitStateFor(failed({}), KEY, NOW, 'openai:gpt')).toBe('failed');
    expect(firstSplitStateFor(failed({}), KEY, NOW, null)).toBe('failed');
    expect(firstSplitStateFor(failed({}), KEY, NOW)).toBe('failed');
    expect(firstSplitStateFor(failed({ modelUsed: null }), KEY, NOW, 'anthropic:claude')).toBe('failed');
    expect(firstSplitStateFor(failed({ errorKind: 'unusable' }), KEY, NOW, 'anthropic:claude')).toBe('failed');
    expect(firstSplitStateFor(failed({ errorKind: null }), KEY, NOW, 'anthropic:claude')).toBe('failed');
  });
});

describe('nextFailureState', () => {
  const OTHER: FirstSplitKey = { ...KEY, fingerprint: '9:deadbeef' };
  const prevTransient = (attempts: number, key = KEY) =>
    rowFor(key, { status: 'transient', parts: null, attempts, nextRetryAt: NOW - 1 });

  // Breaks: a failing provider is hammered every 45 s instead of backing off.
  it('backs off 300 s doubling per attempt', () => {
    expect(nextFailureState(null, KEY, { status: 'transient', errorKind: 'rate_limit' }, NOW))
      .toEqual({ status: 'transient', attempts: 1, nextRetryAt: NOW + 300 });
    expect(nextFailureState(prevTransient(1), KEY, { status: 'transient', errorKind: 'network' }, NOW))
      .toEqual({ status: 'transient', attempts: 2, nextRetryAt: NOW + 600 });
    expect(nextFailureState(prevTransient(3), KEY, { status: 'transient', errorKind: 'timeout' }, NOW))
      .toEqual({ status: 'transient', attempts: 4, nextRetryAt: NOW + 2400 });
  });

  // Breaks: the delay grows past any useful horizon (days between retries).
  it('caps the delay at 6 hours', () => {
    expect(firstSplitBackoffSeconds(8)).toBe(FIRST_SPLIT_BACKOFF_CAP_SECONDS);
    expect(firstSplitBackoffSeconds(40)).toBe(21_600);
    expect(firstSplitBackoffSeconds(0)).toBe(300);
    expect(firstSplitBackoffSeconds(1.9)).toBe(300);
  });

  // Breaks: a model that cannot produce parseable output is paid for on every
  // retry forever.
  it('escalates to failed on the second unparseable answer IN A ROW', () => {
    const first = nextFailureState(null, KEY, { status: 'transient', errorKind: 'unparseable' }, NOW);
    expect(first).toEqual({ status: 'transient', attempts: 1, nextRetryAt: NOW + 300 });
    const prevUnparseable = rowFor(KEY, { status: 'transient', parts: null, errorKind: 'unparseable', ...first });
    expect(nextFailureState(prevUnparseable, KEY, { status: 'transient', errorKind: 'unparseable' }, NOW))
      .toEqual({ status: 'failed', attempts: 2, nextRetryAt: null });
  });

  // Breaks: ONE answer whose outputs all failed the checks (the model skipped
  // or invented a message — not deterministic) made the thread permanently
  // failed, while an unparseable answer got a retry for exactly that reason.
  // A second bad answer in a row — of either kind — is the verdict.
  it('gives an unusable answer one retry, and escalates the second bad answer in a row', () => {
    const first = nextFailureState(null, KEY, { status: 'transient', errorKind: 'unusable' }, NOW);
    expect(first).toEqual({ status: 'transient', attempts: 1, nextRetryAt: NOW + 300 });
    const prevUnusable = rowFor(KEY, { status: 'transient', parts: null, errorKind: 'unusable', ...first });
    expect(nextFailureState(prevUnusable, KEY, { status: 'transient', errorKind: 'unusable' }, NOW))
      .toEqual({ status: 'failed', attempts: 2, nextRetryAt: null });
    expect(nextFailureState(prevUnusable, KEY, { status: 'transient', errorKind: 'unparseable' }, NOW).status)
      .toBe('failed');
    const prevUnparseable = rowFor(KEY, { status: 'transient', parts: null, errorKind: 'unparseable', attempts: 1 });
    expect(nextFailureState(prevUnparseable, KEY, { status: 'transient', errorKind: 'unusable' }, NOW).status)
      .toBe('failed');
    // A deterministic `unusable` (nothing to send) arrives as failed already.
    expect(nextFailureState(null, KEY, { status: 'failed', errorKind: 'unusable' }, NOW).status).toBe('failed');
  });

  // Breaks: a network/rate-limit blip followed by ONE malformed answer stops
  // automatic splitting for that thread for good — a transient condition
  // treated as permanent. The unparseable answer was never retried.
  it('keeps a first unparseable answer transient after a different transient failure', () => {
    for (const earlier of ['rate_limit', 'timeout', 'network', null] as const) {
      const previous = rowFor(KEY, { status: 'transient', parts: null, errorKind: earlier, attempts: 1 });
      expect(nextFailureState(previous, KEY, { status: 'transient', errorKind: 'unparseable' }, NOW), String(earlier))
        .toEqual({ status: 'transient', attempts: 2, nextRetryAt: NOW + 600 });
    }
  });

  // Breaks: an unparseable answer on a row whose previous unparseable was for
  // ANOTHER first email / body escalates on an answer it never retried.
  it('does not escalate across keys', () => {
    const stale = rowFor(OTHER, { status: 'transient', parts: null, errorKind: 'unparseable', attempts: 1 });
    expect(nextFailureState(stale, KEY, { status: 'transient', errorKind: 'unparseable' }, NOW))
      .toEqual({ status: 'transient', attempts: 1, nextRetryAt: NOW + 300 });
  });

  // Breaks: a manual "Try again" on a failed row (attempts carried over) that
  // hits a network error is written as out of attempts and never retried
  // automatically, although the banner promises it will be.
  it('restarts the count after a failed row, so a manual retry that blips is auto-retryable', () => {
    const failed = rowFor(KEY, { status: 'failed', parts: null, errorKind: 'client', attempts: 4 });
    const next = nextFailureState(failed, KEY, { status: 'transient', errorKind: 'network' }, NOW);
    expect(next).toEqual({ status: 'transient', attempts: 1, nextRetryAt: NOW + 300 });
    const written = rowFor(KEY, { status: 'transient', parts: null, errorKind: 'network', ...next });
    expect(firstSplitStateFor(written, KEY, NOW + 300)).toBe('due');
    // A previous unparseable that ended in `failed` does not make the manual
    // retry's own first unparseable answer permanent either.
    const failedUnparseable = rowFor(KEY, { status: 'failed', parts: null, errorKind: 'unparseable', attempts: 2 });
    expect(nextFailureState(failedUnparseable, KEY, { status: 'transient', errorKind: 'unparseable' }, NOW).status)
      .toBe('transient');
  });

  // Breaks: skipped or success rows leak their attempt count into a later failure.
  it('restarts the count after a skipped or usable row', () => {
    for (const status of ['skipped', 'ok', 'partial'] as const) {
      const previous = rowFor(KEY, { status, attempts: 3 });
      expect(nextFailureState(previous, KEY, { status: 'transient', errorKind: 'server' }, NOW).attempts, status)
        .toBe(1);
    }
  });

  // Breaks: the MAX_ATTEMPTS cap stops working once attempts only count
  // consecutive transient failures — a broken provider retried forever.
  it('still stops automatic retries after FIRST_SPLIT_MAX_ATTEMPTS consecutive transients', () => {
    let previous: FirstSplitRow | null = null;
    for (let i = 1; i <= FIRST_SPLIT_MAX_ATTEMPTS; i++) {
      const next = nextFailureState(previous, KEY, { status: 'transient', errorKind: 'rate_limit' }, NOW);
      expect(next.attempts).toBe(i);
      previous = rowFor(KEY, { status: 'transient', parts: null, errorKind: 'rate_limit', ...next });
    }
    expect(firstSplitStateFor(previous, KEY, NOW + FIRST_SPLIT_BACKOFF_CAP_SECONDS)).toBe('failed');
  });

  // Breaks: a new first email (or a re-healed body) inherits the old one's
  // attempt count and is never tried.
  it('resets the count for a new key', () => {
    expect(nextFailureState(prevTransient(4, OTHER), KEY, { status: 'transient', errorKind: 'server' }, NOW))
      .toEqual({ status: 'transient', attempts: 1, nextRetryAt: NOW + 300 });
  });

  // Breaks: a 4xx is retried on the backoff schedule (a paid call that will
  // fail the same way every time).
  it('records a permanent failure with no retry time', () => {
    expect(nextFailureState(prevTransient(2), KEY, { status: 'failed', errorKind: 'client' }, NOW))
      .toEqual({ status: 'failed', attempts: 3, nextRetryAt: null });
  });
});

describe('shouldReplace', () => {
  const OTHER: FirstSplitKey = { ...KEY, firstKey: 'new-first@h' };

  // Breaks: a failed or skipped re-run destroys a good split for the same email.
  it('never lets a failure or skip replace a usable ok/partial for the same key', () => {
    for (const incoming of ['skipped', 'transient', 'failed'] as const) {
      expect(shouldReplace(rowFor(KEY), KEY, incoming)).toBe(false);
      expect(shouldReplace(rowFor(KEY, { status: 'partial' }), KEY, incoming)).toBe(false);
    }
  });

  // Breaks: a partial re-split downgrades a complete one.
  it('partial never replaces ok, but replaces partial and failures', () => {
    expect(shouldReplace(rowFor(KEY), KEY, 'partial')).toBe(false);
    expect(shouldReplace(rowFor(KEY, { status: 'partial' }), KEY, 'partial')).toBe(true);
    expect(shouldReplace(rowFor(KEY, { status: 'failed', parts: null }), KEY, 'partial')).toBe(true);
  });

  it('ok replaces anything', () => {
    expect(shouldReplace(rowFor(KEY), KEY, 'ok')).toBe(true);
    expect(shouldReplace(rowFor(KEY, { status: 'partial' }), KEY, 'ok')).toBe(true);
  });

  // Breaks: the stored row for a first email that is gone (or a changed body)
  // can never be overwritten, so the thread is stuck on the old answer.
  it('always replaces a row for a different key, or no row', () => {
    for (const incoming of ['skipped', 'transient', 'failed', 'partial', 'ok'] as const) {
      expect(shouldReplace(rowFor(OTHER), KEY, incoming)).toBe(true);
      expect(shouldReplace(null, KEY, incoming)).toBe(true);
    }
  });

  // Breaks: a stored success whose parts are unreadable blocks every later
  // write, so the thread can never recover.
  it('lets a failure replace a success whose parts are unreadable, and a failure replace a failure', () => {
    expect(shouldReplace(rowFor(KEY, { parts: 'garbage' }), KEY, 'transient')).toBe(true);
    expect(shouldReplace(rowFor(KEY, { status: 'transient', parts: null }), KEY, 'failed')).toBe(true);
    expect(shouldReplace(rowFor(KEY, { status: 'skipped', parts: null }), KEY, 'skipped')).toBe(true);
  });
});

describe('isSameFirstSplitKey', () => {
  // Breaks: main's save-time stale check. Comparing too little caches one
  // email's split under another's key; comparing the row id refuses every save
  // after a resync re-created the first email's row with the same message.
  it('compares thread, first email and fingerprint, never the row id', () => {
    expect(isSameFirstSplitKey(KEY, { ...KEY })).toBe(true);
    expect(isSameFirstSplitKey(KEY, { ...KEY, firstEmailId: 'e1-resynced' })).toBe(true);
    expect(isSameFirstSplitKey(KEY, { ...KEY, threadId: 't2' })).toBe(false);
    expect(isSameFirstSplitKey(KEY, { ...KEY, firstKey: 'other@h' })).toBe(false);
    expect(isSameFirstSplitKey(KEY, { ...KEY, fingerprint: '1:00000000' })).toBe(false);
  });

  // Breaks: a thread with no member (null key) reads as "unchanged" and a
  // run's result is written for nothing.
  it('is false when either side is missing', () => {
    expect(isSameFirstSplitKey(null, KEY)).toBe(false);
    expect(isSameFirstSplitKey(KEY, undefined)).toBe(false);
    expect(isSameFirstSplitKey(null, null)).toBe(false);
  });
});
