// A fake of main's `ai:firstSplit:get/save`, per account, built on the SAME
// core rules main uses (key, isSameFirstSplitKey, shouldReplace,
// nextFailureState) — so a store/job test exercises the real write policy
// rather than a stub that accepts anything.
import type { EmailRecord } from '@sarvinbox/core';
import {
  FIRST_SPLIT_VERSION,
  firstSplitKeyFor,
  isSameFirstSplitKey,
  nextFailureState,
  shouldReplace,
  type FirstSplitGetResult,
  type FirstSplitKey,
  type FirstSplitRow,
  type FirstSplitSaveRequest,
  type FirstSplitSaveResult,
} from '@sarvinbox/core/first-split';

import type { FirstSplitBridge } from '../../../../../src/services/first-split/store';
import { ROSTER } from '../../components/email-detail/looped-in-fixture';

interface Thread {
  source: EmailRecord | null;
  memberCount: number;
  distinctSenders: number;
  row: FirstSplitRow | null;
}

export interface FakeBridge extends FirstSplitBridge {
  /** Put a thread in an account's "database". */
  seed(accountId: string, threadId: string, source: EmailRecord | null, options?: Partial<Thread>): void;
  /** The stored row. */
  row(accountId: string, threadId: string): FirstSplitRow | null;
  /** Change the first email's stored body (a re-heal) or swap the first email. */
  setSource(accountId: string, threadId: string, source: EmailRecord | null): void;
  /** Every save request, with the account it was sent to. */
  readonly saves: Array<{ accountId: string; request: FirstSplitSaveRequest; result: FirstSplitSaveResult }>;
  readonly gets: Array<{ accountId: string; threadId: string }>;
}

export function createFakeBridge(now = 1_800_000_000): FakeBridge {
  const db = new Map<string, Thread>();
  const at = (accountId: string, threadId: string) => `${accountId}|${threadId}`;
  const saves: FakeBridge['saves'] = [];
  const gets: FakeBridge['gets'] = [];
  const keyOf = (threadId: string, thread: Thread): FirstSplitKey | null =>
    thread.source ? firstSplitKeyFor(threadId, thread.source, thread.source.rawBody) : null;

  return {
    saves,
    gets,
    seed(accountId, threadId, source, options = {}) {
      db.set(at(accountId, threadId), { source, memberCount: 2, distinctSenders: 2, row: null, ...options });
    },
    row: (accountId, threadId) => db.get(at(accountId, threadId))?.row ?? null,
    setSource(accountId, threadId, source) {
      db.get(at(accountId, threadId))!.source = source;
    },
    async get(accountId, threadId, options) {
      gets.push({ accountId, threadId });
      const thread = db.get(at(accountId, threadId));
      if (!thread) return { success: false, error: `Unknown account ${accountId}` };
      const key = keyOf(threadId, thread);
      const data: FirstSplitGetResult = {
        row: thread.row,
        current: key ? { ...key, memberCount: thread.memberCount, distinctSenders: thread.distinctSenders } : null,
        ...(options?.withSource ? { source: thread.source, roster: ROSTER } : {}),
      };
      return { success: true, data };
    },
    async save(accountId, request) {
      const thread = db.get(at(accountId, request.key.threadId));
      let result: FirstSplitSaveResult;
      const current = thread ? keyOf(request.key.threadId, thread) : null;
      if (!thread || !current || !isSameFirstSplitKey(current, request.key)) {
        result = { applied: false, reason: 'stale' };
      } else if (!shouldReplace(thread.row, current, request.status)) {
        result = { applied: false, reason: 'kept' };
      } else {
        const failure = request.status === 'transient' || request.status === 'failed'
          ? nextFailureState(thread.row, current, { status: request.status, errorKind: (request.errorKind ?? null) as never }, now)
          : null;
        const status = failure?.status ?? request.status;
        thread.row = {
          threadId: current.threadId,
          firstKey: current.firstKey,
          firstEmailId: current.firstEmailId,
          sourceFingerprint: current.fingerprint,
          splitVersion: FIRST_SPLIT_VERSION,
          status,
          quoteCount: request.quoteCount ?? null,
          parts: request.parts ? JSON.stringify(request.parts) : null,
          errorKind: request.errorKind ?? null,
          attempts: failure?.attempts ?? 0,
          nextRetryAt: failure?.nextRetryAt ?? null,
          modelUsed: request.modelUsed ?? null,
          updatedAt: now,
        };
        result = { applied: true, status };
      }
      saves.push({ accountId, request, result });
      return { success: true, data: result };
    },
  };
}
