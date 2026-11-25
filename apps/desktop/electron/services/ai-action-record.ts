import { createLogger, errorDiagnostic, parseAiActions, type AiAction, type AiActionKind } from '@sarvinbox/core';

import { getAccountIdForStorage, getMainWindow } from '../shared';

const logger = createLogger('ai-action-record');

/** The account database methods this needs (AgentRepository in storage-node). */
export interface AiActionStore {
  recordAiActions(emailIds: readonly string[], action: AiAction): string[];
  forgetAiActions(emailIds: readonly string[], kind: AiActionKind): string[];
  getAiActionsRaw(emailId: string): string | null;
}

/** An account's AgentRepository, from the storage object the caller already holds. */
export function aiActionStoreOf(storage: unknown): AiActionStore | undefined {
  try {
    return (storage as { getRepositories?: () => { agent?: AiActionStore } }).getRepositories?.().agent;
  } catch { return undefined; }
}

/** Tell the open list which rows now carry a different AI record. */
function announce(store: AiActionStore, ids: readonly string[], accountId: string | null): void {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  for (const emailId of ids) {
    window.webContents.send('emails:ai-actions-updated', { emailId, accountId, aiActions: parseAiActions(store.getAiActionsRaw(emailId)) });
  }
}

function accountOf(storage: unknown, accountId?: string | null): string | null {
  if (accountId) return accountId;
  try { return getAccountIdForStorage(storage as never) ?? null; } catch { return null; }
}

/**
 * Stamp what the AI just did on each email's own row and redraw those rows.
 *
 * Never throws: the change itself already happened, and a mail action must not
 * fail because its record could not be written. A failure is logged as its
 * class only (no ids, no mail).
 */
export function recordAiActions(storage: unknown, emailIds: readonly string[], kind: AiActionKind, options: { auto: boolean; accountId?: string | null; nowMs?: number }): void {
  if (!emailIds.length) return;
  const store = aiActionStoreOf(storage);
  if (!store) return;
  try {
    const written = store.recordAiActions(emailIds, { kind, at: Math.floor((options.nowMs ?? Date.now()) / 1000), auto: options.auto });
    announce(store, written, accountOf(storage, options.accountId));
  } catch (error) {
    logger.warn('[AIActions] could not record an AI action', { kind, count: emailIds.length, ...errorDiagnostic(error) });
  }
}

/** Take an undone AI action back off each email's row. Never throws, as above. */
export function forgetAiActions(storage: unknown, emailIds: readonly string[], kind: AiActionKind, options: { accountId?: string | null } = {}): void {
  if (!emailIds.length) return;
  const store = aiActionStoreOf(storage);
  if (!store) return;
  try {
    announce(store, store.forgetAiActions(emailIds, kind), accountOf(storage, options.accountId));
  } catch (error) {
    logger.warn('[AIActions] could not remove an undone AI action', { kind, count: emailIds.length, ...errorDiagnostic(error) });
  }
}
