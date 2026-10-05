import { createHash } from 'node:crypto';

import { getCoreDb } from './core-db';

const PREFIX = 'attachment-unscanned-warning:v1:';
let globalRevision = 0;
const accountRevisions = new Map<string, number>();

function preferenceKey(accountId: string): string {
  if (typeof accountId !== 'string' || !accountId) throw new Error('The attachment account is unavailable.');
  return `${PREFIX}${createHash('sha256').update(accountId).digest('hex')}`;
}

/** Main-only, non-secret preferences. Strict reads/writes never mistake an unreadable store for consent. */
export const unscannedWarningPreferences = {
  revision(accountId: string): string {
    const key = preferenceKey(accountId);
    return `${globalRevision}:${accountRevisions.get(key) ?? 0}`;
  },
  read(accountId: string): boolean {
    const row = getCoreDb().prepare('SELECT value FROM registry_meta WHERE key = ?').get(preferenceKey(accountId)) as
      | { value: unknown }
      | undefined;
    if (!row) return false;
    if (row.value !== '1') throw new Error('The antivirus warning preference is unreadable.');
    return true;
  },
  remember(accountId: string, expectedRevision: string): void {
    if (this.revision(accountId) !== expectedRevision) throw new Error('Antivirus warning preferences changed. Try again.');
    getCoreDb().prepare('INSERT INTO registry_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(preferenceKey(accountId), '1');
  },
  reset(accountId: string): void {
    const key = preferenceKey(accountId);
    // Invalidate pending prompts even when the store cannot complete this reset.
    accountRevisions.set(key, (accountRevisions.get(key) ?? 0) + 1);
    getCoreDb().prepare('DELETE FROM registry_meta WHERE key = ?').run(key);
  },
  resetAll(): void {
    globalRevision += 1;
    accountRevisions.clear();
    getCoreDb().prepare('DELETE FROM registry_meta WHERE key LIKE ?').run(`${PREFIX}%`);
  },
};

export function clearUnscannedWarningPreference(accountId: string): void {
  unscannedWarningPreferences.reset(accountId);
}
