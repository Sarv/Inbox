import {
  FIRST_SPLIT_BACKOFF_BASE_SECONDS,
  FIRST_SPLIT_VERSION,
  firstSplitKeyFor,
  type FirstSplitKey,
  type FirstSplitPart,
  type FirstSplitSaveRequest,
} from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FirstSplitRepository,
  validateFirstSplitSave,
  type FirstSplitWriteInput,
} from '../../../src/repositories/first-split-repository';
import { ThreadRepository } from '../../../src/repositories/thread-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';

// What breaks if this file fails: the first-email split cache's storage. A
// write that merges instead of replacing grows the cache for ever; a failure
// that overwrites a good split strips a thread's history from the chat view
// the next time the provider blips; a retry count that does not follow the
// policy turns the background scheduler into a paid-API retry storm; a row
// that outlives its thread is an orphan nobody ever reads again. Real SQLite,
// the production schema.

const NOW = 1_800_000_000;

const OWN: FirstSplitPart = {
  role: 'own', fromAddress: 'a@x.test', fromName: 'A', date: 1_700_000_000, dateApprox: false,
  body: '<p>Latest words</p>', fallback: false,
};
const QUOTE: FirstSplitPart = {
  role: 'quote', fromAddress: 'b@x.test', fromName: null, date: 1_699_999_000, dateApprox: true,
  body: '<p>Earlier words</p>', fallback: false,
};

const KEY: FirstSplitKey = firstSplitKeyFor('t1', { id: 'e1', messageId: '<first@x.test>' }, '<p>body</p>');
const OTHER_KEY: FirstSplitKey = firstSplitKeyFor('t1', { id: 'e0', messageId: '<earlier@x.test>' }, '<p>earlier</p>');

const input = (over: Partial<FirstSplitWriteInput> = {}): FirstSplitWriteInput => ({
  status: 'ok',
  parts: JSON.stringify([OWN, QUOTE]),
  errorKind: null,
  quoteCount: 1,
  modelUsed: 'openai:gpt-x',
  ...over,
});
const failure = (status: 'transient' | 'failed' | 'skipped', errorKind: string | null = 'network'): FirstSplitWriteInput =>
  input({ status, parts: null, errorKind });

function newDb(): Database.Database {
  const db = newMigratedDb();
  for (const id of ['t1', 't2']) {
    db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
                VALUES (?, 's', 'e1', 'e1', ?)`).run(id, NOW);
  }
  return db;
}

const rowCount = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM first_email_splits').get() as { c: number }).c;

describe('validateFirstSplitSave', () => {
  const request = (over: Partial<FirstSplitSaveRequest> = {}): FirstSplitSaveRequest => ({
    key: KEY, status: 'ok', parts: [OWN, QUOTE], errorKind: null, quoteCount: 1, modelUsed: 'm', ...over,
  });

  // Breaks: an "ok" row that can never be shown (no parts, a blank body)
  // blocks every real retry, because shouldReplace treats ok as final.
  it('refuses a success without readable parts, and an unknown status', () => {
    expect(validateFirstSplitSave(request({ parts: null }))).toBeNull();
    expect(validateFirstSplitSave(request({ parts: [] }))).toBeNull();
    expect(validateFirstSplitSave(request({ status: 'partial', parts: [{ ...OWN, body: '   ' }] }))).toBeNull();
    expect(validateFirstSplitSave(request({ parts: [OWN, { ...OWN }] }))).toBeNull();
    expect(validateFirstSplitSave(request({ parts: [OWN, null as never, 'x' as never] }))).toBeNull();
    expect(validateFirstSplitSave(request({ status: 'done' as never }))).toBeNull();
    expect(validateFirstSplitSave(null)).toBeNull();
  });

  // Breaks: renderer-side extras (ids, DOM leftovers) get persisted, and the
  // table's CHECK rejects a failure that happened to carry parts.
  it('stores only the part fields, and no parts for a non-success', () => {
    const ok = validateFirstSplitSave(request({ parts: [{ ...OWN, id: 'e1', extra: 1 } as FirstSplitPart] }));
    expect(JSON.parse(ok!.parts!)).toEqual([OWN]);
    const failed = validateFirstSplitSave(request({ status: 'transient', parts: [OWN], errorKind: 'timeout' }));
    expect(failed).toEqual({ status: 'transient', parts: null, errorKind: 'timeout', quoteCount: 1, modelUsed: 'm' });
  });

  // Breaks: a garbage quote count (negative, fractional, NaN) steering the
  // eligibility rules, or '' stored where the readers test for null.
  it('records an unusable quote count as unknown, and blank strings as null', () => {
    for (const quoteCount of [-1, 1.5, Number.NaN, undefined, null]) {
      expect(validateFirstSplitSave(request({ quoteCount }))!.quoteCount).toBeNull();
    }
    expect(validateFirstSplitSave(request({ quoteCount: 0 }))!.quoteCount).toBe(0);
    const blank = validateFirstSplitSave(request({ status: 'skipped', parts: null, errorKind: '', modelUsed: '' }))!;
    expect(blank.errorKind).toBeNull();
    expect(blank.modelUsed).toBeNull();
  });
});

describe('FirstSplitRepository', () => {
  let db: Database.Database;
  let repo: FirstSplitRepository;

  beforeEach(() => {
    db = newDb();
    repo = new FirstSplitRepository(() => db);
  });
  afterEach(() => db.close());

  // Breaks: the read/write round trip every other rule rests on — a field
  // dropped or mis-mapped, or a row stamped with a stale split version.
  it('reads back what it wrote, camel-cased and stamped with the current version', () => {
    expect(repo.getSync('t1')).toBeNull();
    expect(repo.saveSync(KEY, input(), NOW)).toEqual({ applied: true, status: 'ok' });
    expect(repo.getSync('t1')).toEqual({
      threadId: 't1', firstKey: KEY.firstKey, firstEmailId: 'e1', sourceFingerprint: KEY.fingerprint,
      splitVersion: FIRST_SPLIT_VERSION, status: 'ok', quoteCount: 1, parts: JSON.stringify([OWN, QUOTE]),
      errorKind: null, attempts: 0, nextRetryAt: null, modelUsed: 'openai:gpt-x', updatedAt: NOW,
    });
  });

  // Breaks: the cache that only ever grew — one row per run instead of one
  // per thread; and a merge that keeps the old row's fields under a new result.
  it('a second save replaces the whole row: still exactly one row, nothing merged', () => {
    repo.saveSync(KEY, input({ quoteCount: 4, modelUsed: 'old' }), NOW);
    repo.saveSync(KEY, input({ quoteCount: null, modelUsed: null, parts: JSON.stringify([OWN]) }), NOW + 5);
    expect(rowCount(db)).toBe(1);
    expect(repo.getSync('t1')).toMatchObject({
      quoteCount: null, modelUsed: null, parts: JSON.stringify([OWN]), updatedAt: NOW + 5,
    });
  });

  // Breaks: a failed or skipped re-split destroys a good one — the thread's
  // history disappears from the AI view the next time the provider blips.
  it('keeps an ok/partial row against a failure or skip for the SAME key', () => {
    // partial first: ok replaces partial, while partial never replaces ok.
    for (const good of ['partial', 'ok'] as const) {
      repo.saveSync(KEY, input({ status: good }), NOW);
      for (const status of ['transient', 'failed', 'skipped'] as const) {
        expect(repo.saveSync(KEY, failure(status), NOW + 1)).toEqual({ applied: false, reason: 'kept' });
      }
      expect(repo.getSync('t1')).toMatchObject({ status: good, attempts: 0 });
    }
    // partial never downgrades ok either.
    repo.saveSync(KEY, input(), NOW);
    expect(repo.saveSync(KEY, input({ status: 'partial' }), NOW)).toEqual({ applied: false, reason: 'kept' });
  });

  // Breaks: a thread whose first email changed is stuck on the old answer.
  it('lets a failure for a DIFFERENT key replace the row', () => {
    repo.saveSync(KEY, input(), NOW);
    expect(repo.saveSync(OTHER_KEY, failure('transient'), NOW + 1)).toEqual({ applied: true, status: 'transient' });
    expect(repo.getSync('t1')).toMatchObject({ firstKey: OTHER_KEY.firstKey, firstEmailId: 'e0', status: 'transient', parts: null });
  });

  // Breaks: the retry policy — no backoff is a retry storm, no reset makes a
  // new first email inherit an exhausted count, no escalation re-pays for an
  // answer that will never parse.
  it('counts attempts and backs off per core policy, escalating a second unparseable answer', () => {
    expect(repo.saveSync(KEY, failure('transient'), NOW)).toEqual({ applied: true, status: 'transient' });
    expect(repo.getSync('t1')).toMatchObject({ attempts: 1, nextRetryAt: NOW + FIRST_SPLIT_BACKOFF_BASE_SECONDS });

    repo.saveSync(KEY, failure('transient', 'rate_limit'), NOW + 400);
    expect(repo.getSync('t1')).toMatchObject({ attempts: 2, nextRetryAt: NOW + 400 + 2 * FIRST_SPLIT_BACKOFF_BASE_SECONDS });

    // A new first email starts over.
    repo.saveSync(OTHER_KEY, failure('transient'), NOW + 500);
    expect(repo.getSync('t1')).toMatchObject({ attempts: 1, firstKey: OTHER_KEY.firstKey });

    repo.saveSync(OTHER_KEY, failure('transient', 'unparseable'), NOW + 600);
    expect(repo.saveSync(OTHER_KEY, failure('transient', 'unparseable'), NOW + 700)).toEqual({ applied: true, status: 'failed' });
    expect(repo.getSync('t1')).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null, errorKind: 'unparseable' });
  });

  // Breaks: a success after failures inherits the failure bookkeeping, and the
  // scheduler keeps treating a split thread as due.
  it('a success clears attempts and the retry time', () => {
    repo.saveSync(KEY, failure('transient'), NOW);
    repo.saveSync(KEY, input(), NOW + 1);
    expect(repo.getSync('t1')).toMatchObject({ status: 'ok', attempts: 0, nextRetryAt: null });
  });

  // Breaks: orphan rows — a split outliving its thread is never read again and
  // never cleaned.
  it('cascades away with its thread (ThreadRepository.delete and the rebuild orphan sweep)', async () => {
    repo.saveSync(KEY, input(), NOW);
    repo.saveSync({ ...KEY, threadId: 't2' }, input(), NOW);
    const threads = new ThreadRepository(() => db);

    await threads.delete('t1');
    expect(repo.getSync('t1')).toBeNull();
    expect(repo.getSync('t2')).not.toBeNull();

    // t2 has no emails: the rebuild's "drop threads nothing references" sweep takes it.
    await threads.rebuild();
    expect(repo.getSync('t2')).toBeNull();
    expect(rowCount(db)).toBe(0);
  });

  // Breaks: a body re-heal leaving the stale split in place (deleteSync), or
  // Clear Cache leaving rows / misreporting the count (clearAll).
  it('deleteSync removes one row; clearAll removes every row and says how many', () => {
    repo.saveSync(KEY, input(), NOW);
    repo.saveSync({ ...KEY, threadId: 't2' }, failure('skipped', null), NOW);
    expect(repo.deleteSync('t1')).toBe(true);
    expect(repo.deleteSync('t1')).toBe(false);
    expect(repo.clearAll()).toEqual({ removed: 1, splits: 0 });
    expect(repo.clearAll()).toEqual({ removed: 0, splits: 0 });
    expect(rowCount(db)).toBe(0);
  });

  // Breaks: Clear Cache telling the user it cleared hundreds of "splits" when
  // most rows were the scheduler's bookkeeping — `skipped` (no quoted history),
  // `transient` and `failed`. Only `ok`/`partial` rows are splits; every row
  // still goes.
  it('clearAll counts only ok/partial rows as splits, and removes the bookkeeping rows too', () => {
    for (const id of ['t3', 't4', 't5']) {
      db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
                  VALUES (?, 's', 'e1', 'e1', ?)`).run(id, NOW);
    }
    repo.saveSync(KEY, input(), NOW);
    repo.saveSync({ ...KEY, threadId: 't2' }, input({ status: 'partial' }), NOW);
    repo.saveSync({ ...KEY, threadId: 't3' }, failure('skipped', null), NOW);
    repo.saveSync({ ...KEY, threadId: 't4' }, failure('transient'), NOW);
    repo.saveSync({ ...KEY, threadId: 't5' }, failure('failed', 'unparseable'), NOW);
    expect(rowCount(db)).toBe(5);

    expect(repo.clearAll()).toEqual({ removed: 5, splits: 2 });
    expect(rowCount(db)).toBe(0);
  });

  // Breaks: two accounts sharing one cache. Thread ids are derived from
  // headers, so the SAME thread id exists in both accounts' databases.
  it('keeps the same thread id in two account databases independent', () => {
    const other = newDb();
    const otherRepo = new FirstSplitRepository(() => other);
    repo.saveSync(KEY, input(), NOW);
    otherRepo.saveSync(KEY, failure('transient'), NOW);

    expect(repo.getSync('t1')).toMatchObject({ status: 'ok' });
    expect(otherRepo.getSync('t1')).toMatchObject({ status: 'transient' });
    otherRepo.clearAll();
    expect(repo.getSync('t1')).toMatchObject({ status: 'ok' });
    other.close();
  });
});
