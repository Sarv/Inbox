/**
 * Follow-up Checker Service
 *
 * Once a minute, walks every account's open follow-up reminders: one that got
 * a reply ends quietly, one whose time passed unanswered is marked due and
 * notified. Same shape as the snooze checker — fans out over every account, not
 * just the active one, so a reminder on a background account still fires.
 */

import { createLogger, type FollowUp, type FollowUpStatus } from '@sarvinbox/core';

import { getAllAccountIds, getMainWindow, getStorage, getStorageFor } from '../shared';

import { nextFollowUpStatus } from './follow-up-schedule';
import { notifyFollowUpDue } from './notification-service';

const logger = createLogger('follow-up-checker');

const CHECK_INTERVAL_MS = 60 * 1000;
/** Open reminders examined per account per pass; the rest wait for the next minute. */
const CHECK_CAP = 200;

/** The slice of SQLiteStorage the checker needs — a fake in tests. */
export interface FollowUpStore {
  listOpenFollowUps(limit?: number): Promise<FollowUp[]>;
  followUpHasReply(followUp: Pick<FollowUp, 'messageId' | 'fromAddress' | 'sentAt'>): Promise<boolean>;
  setFollowUpStatus(id: string, status: FollowUpStatus): Promise<boolean>;
}

export interface DueFollowUp extends FollowUp {
  accountId: string;
}

export interface FollowUpPassResult {
  due: DueFollowUp[];
  replied: number;
}

/**
 * One account's pass. Errors are per account: a locked or closing DB skips
 * this account for a minute and never stops the others.
 */
export async function checkFollowUpsForAccount(
  accountId: string,
  store: FollowUpStore,
  now: number,
): Promise<FollowUpPassResult> {
  const due: DueFollowUp[] = [];
  let replied = 0;
  try {
    const open = await store.listOpenFollowUps(CHECK_CAP);
    for (const followUp of open) {
      const hasReply = await store.followUpHasReply(followUp);
      const next = nextFollowUpStatus(followUp, { now, hasReply });
      // setStatus refuses an already-ended reminder, so a dismiss that lands
      // between the read and this write is never overridden.
      if (!next || !(await store.setFollowUpStatus(followUp.id, next))) continue;
      if (next === 'due') due.push({ ...followUp, status: 'due', accountId });
      else replied += 1;
    }
  } catch (error) {
    logger.warn(`[FollowUp] Check failed for account ${accountId}:`, error);
  }
  return { due, replied };
}

/** Every account's pass, merged. */
export async function checkFollowUpsAcross(
  targets: Array<{ accountId: string; store: FollowUpStore }>,
  now: number,
): Promise<FollowUpPassResult> {
  const results = await Promise.all(targets.map(({ accountId, store }) => checkFollowUpsForAccount(accountId, store, now)));
  return {
    due: results.flatMap((result) => result.due),
    replied: results.reduce((sum, result) => sum + result.replied, 0),
  };
}

/**
 * Every account's storage, tagged with its id. Before any account runtime is
 * registered (the pre-account default slot) it is the active storage, id ''.
 */
export function followUpStores<T = FollowUpStore>(): Array<{ accountId: string; store: T }> {
  const accountIds = getAllAccountIds();
  if (accountIds.length === 0) {
    // Pre-account default slot: the active storage, whatever it is.
    const storage = getStorage();
    return storage ? [{ accountId: '', store: storage as T }] : [];
  }
  return accountIds
    .map((accountId) => ({ accountId, store: getStorageFor(accountId) as T | null }))
    .filter((target): target is { accountId: string; store: T } => !!target.store);
}

/** Run one pass now: notify what fell due and tell the renderer to refresh. */
export async function runFollowUpCheck(): Promise<number> {
  const targets = followUpStores();
  if (targets.length === 0) return 0;
  const { due, replied } = await checkFollowUpsAcross(targets, Math.floor(Date.now() / 1000));
  due.forEach((followUp) => notifyFollowUpDue(followUp));
  if (due.length > 0 || replied > 0) {
    try {
      getMainWindow()?.webContents.send('follow-ups:changed', { due: due.length, replied });
    } catch {
      /* window closing */
    }
    logger.info(`[FollowUp] ${due.length} due, ${replied} replied across ${targets.length} account(s)`);
  }
  return due.length;
}

let checkInterval: NodeJS.Timeout | null = null;

export function startFollowUpChecker(): void {
  if (checkInterval) return;
  const run = () => {
    runFollowUpCheck().catch((error) => logger.warn('[FollowUp] Check pass failed:', error));
  };
  checkInterval = setInterval(run, CHECK_INTERVAL_MS);
  run();
}

export function stopFollowUpChecker(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
