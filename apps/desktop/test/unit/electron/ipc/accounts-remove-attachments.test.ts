import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * accounts:remove and the cached attachments (CASA M-7).
 *
 * The removed account's own folder goes with its data (deleteAccountData —
 * accounts-runtime-attachments.test.ts). On top of that the handler sweeps
 * attachment folders no remaining account owns, and — when this removal took
 * the LAST account — removes every cached attachment, including the older
 * builds' plaintext cache that names no account.
 *
 * Both deletes are keyed off the account registry, so the regression to fear is
 * the one this codebase has already had: an unreadable registry that looks like
 * an empty one, licensing a delete of everything.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  registry: [] as Array<{ id: string; imapConfig: Record<string, unknown> | null }>,
  /** Per-call failure plan for readRegistryAccounts: true = that read throws. */
  readFails: [] as boolean[],
  reads: 0,
  calls: [] as string[],
  sweepFails: false,
  wipeFails: false,
  dbSweepFails: false,
  cookiesFail: false,
  dataWipeFails: false,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn), on: () => {} },
}));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  oauthIdentityOf: () => null,
  listRegistryAccounts: () => [...h.registry],
  readRegistryAccounts: () => {
    const fails = h.readFails[h.reads] ?? false;
    h.reads++;
    if (fails) throw new Error('addon failed to load');
    return [...h.registry];
  },
  removeRegistryAccount: (id: string) => {
    h.calls.push(`registry-remove:${id}`);
    h.registry = h.registry.filter((a) => a.id !== id);
  },
  upsertRegistryAccounts: () => {},
  getRegistryActiveAccountId: () => null,
  setRegistryActiveAccountId: () => {},
  getAllAppSettings: () => ({}),
  setAppSetting: () => {},
  deleteAppSetting: () => {},
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  deleteAccountData: async (id: string) => {
    h.calls.push(`wipe:${id}`);
    if (h.dataWipeFails) throw new Error('EBUSY');
  },
  cleanupOrphanedAccountDbs: ({ keepAccountIds }: { keepAccountIds: string[] }) => {
    h.calls.push(`db-sweep:${keepAccountIds.join(',')}`);
    if (h.dbSweepFails) throw new Error('EACCES');
    return [];
  },
  ensureAccountRuntime: async () => null,
  loadPrimaryAccountId: () => null,
  savePrimaryAccountId: () => {},
  accountInboxUnread: async () => 0,
  rekeyAccount: async () => {},
  legacyDbExists: () => false,
}));
vi.mock('../../../../electron/services/attachment-cache', () => ({
  cleanupOrphanedAttachmentStores: async (keep: string[], options?: { staleAfterMs?: number }) => {
    h.calls.push(`attachments-sweep:${keep.join(',')}:stale=${String(options?.staleAfterMs)}`);
    if (h.sweepFails) throw new Error('EBUSY');
    return 0;
  },
  removeAllCachedAttachments: async () => {
    h.calls.push('attachments-remove-all');
    if (h.wipeFails) throw new Error('EBUSY');
  },
}));
vi.mock('../../../../electron/services/email-content-cookies', () => ({
  // The real one never throws; it reports failure as false.
  clearEmailContentData: async () => { h.calls.push('content-clear'); return { cookies: !h.cookiesFail, cache: !h.cookiesFail }; },
}));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({ peekAntivirusScanService: () => null }));
vi.mock('../../../../electron/services/oauth-refresh-scheduler', () => ({ signOutOAuthAccount: async () => {} }));
vi.mock('../../../../electron/services/outbox-service', () => ({ rebindOutboxStorage: () => {} }));
vi.mock('../../../../electron/services/attachment-warning-preferences', () => ({
  clearUnscannedWarningPreference: () => {},
}));
vi.mock('../../../../electron/services/reputation-service', () => ({ noteAppSettingChanged: () => {} }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  disablePipelineAIIfProviderRemoved: async () => { h.calls.push('ai-revalidate'); },
}));
vi.mock('../../../../electron/shared', () => ({
  setCurrentAccount: () => {},
  hasAccountRuntime: () => false,
  getCurrentAccountId: () => null,
}));

import { registerAccountsHandlers } from '../../../../electron/ipc/accounts-handlers';

const password = (id: string) => ({ id, imapConfig: { authMethod: 'password', username: `${id}@example.com` } });
const remove = (id: string) => h.handlers.get('accounts:remove')!(null, id);
const attachmentCalls = () => h.calls.filter((call) => call.startsWith('attachments-'));

beforeEach(() => {
  h.handlers.clear();
  h.registry = [];
  h.readFails = [];
  h.reads = 0;
  h.calls.length = 0;
  h.sweepFails = false;
  h.wipeFails = false;
  h.dbSweepFails = false;
  h.cookiesFail = false;
  h.dataWipeFails = false;
  registerAccountsHandlers();
});

describe('accounts:remove — cached attachments', () => {
  // Breaks (CASA M-7, multi-account): orphaned attachment folders (accounts
  // removed while the app was closed, ids rekeyed by a crashed move) survive a
  // removal — or the sweep is handed a keep-set missing a live account. Runs
  // after the account is gone from the registry, with the stale guard off,
  // exactly like the DB sweep beside it.
  it('sweeps orphaned folders with the remaining accounts as the keep-set', async () => {
    h.registry = [password('a1'), password('a2'), password('a3')];

    await expect(remove('a2')).resolves.toEqual({ success: true });

    // 'content-clear' added deliberately (CASA 6.6.1): removal now also clears
    // the email-content cookie jar and HTTP cache, after the data is gone. Moved
    // deliberately to last: a session store that hangs must not hold the sign-out
    // and AI revalidation (accounts-remove-signout.test.ts).
    expect(h.calls).toEqual([
      'wipe:a2',
      'registry-remove:a2',
      'db-sweep:a1,a3',
      'attachments-sweep:a1,a3:stale=0',
      'ai-revalidate',
      'content-clear',
    ]);
    expect(h.calls).not.toContain('attachments-remove-all');
  });

  // Breaks (CASA M-7): removing the last account leaves every cached attachment
  // on disk — including the older builds' PLAINTEXT cache, which names no
  // account and so is never reached by a per-account delete.
  it('removes every cached attachment when the last registered account is removed', async () => {
    h.registry = [password('a1')];

    await expect(remove('a1')).resolves.toEqual({ success: true });

    expect(attachmentCalls()).toEqual(['attachments-remove-all']);
  });

  // Breaks (data loss): an unreadable registry is read as "no accounts left"
  // and every mailbox's attachments — unsynced drafts' only copies included —
  // are deleted. CLAUDE.md: an unreadable store and an empty store are the same
  // value and opposite facts.
  it('deletes no attachments when the registry cannot be read', async () => {
    h.registry = [password('a1'), password('a2')];
    h.readFails = [true, true];

    await expect(remove('a1')).resolves.toEqual({ success: true });

    expect(attachmentCalls()).toEqual([]);
  });

  // Breaks (data loss): the registry could not be read BEFORE the removal, so
  // nobody knows whether this was the last account; the read after it answers
  // [] (the same failure, now looking like an empty list). That must not wipe.
  it('does not wipe everything when "was it registered?" could not be answered', async () => {
    h.registry = [password('a1')];
    h.readFails = [true, false];

    await expect(remove('a1')).resolves.toEqual({ success: true });

    expect(attachmentCalls()).toEqual([]);
  });

  // Breaks: an idempotent re-run (the renderer retries a removal whose first
  // attempt already finished) on an already-empty registry wipes everything —
  // the registry did not go from one account to none through THIS removal.
  it('does not wipe everything when the removed id was not registered', async () => {
    await expect(remove('gone')).resolves.toEqual({ success: true });

    expect(attachmentCalls()).toEqual([]);
  });

  // Breaks: a failed attachment sweep or wipe (a file in use on Windows) fails
  // the removal the user asked for, or skips the steps after it (OAuth sign-out,
  // AI revalidation).
  it.each([
    ['sweep', () => { h.sweepFails = true; h.registry = [password('a1'), password('a2')]; }],
    ['wipe', () => { h.wipeFails = true; h.registry = [password('a1')]; }],
  ])('still succeeds when the attachment %s throws', async (_label, arrange) => {
    arrange();

    await expect(remove('a1')).resolves.toEqual({ success: true });

    expect(h.calls).toContain('ai-revalidate');
  });

  // Changed deliberately (CASA M-7): the attachment step no longer shares the
  // DB sweep's try block, whose "nothing deleted" log was then wrong. It needs
  // only a readable registry, which this keep-set came from. Breaks: one failing
  // sweep silently skips the other.
  it('still sweeps attachment orphans when only the DB orphan sweep throws', async () => {
    h.registry = [password('a1'), password('a2')];
    h.dbSweepFails = true;

    await expect(remove('a1')).resolves.toEqual({ success: true });

    expect(attachmentCalls()).toEqual(['attachments-sweep:a2:stale=0']);
  });
});

// CASA 6.6.1. Remote images in mail leave cookies and cached bytes in the session
// email renders in; nothing else needs them, and they cannot be split by account.
describe('accounts:remove — email-content cookies and cache', () => {
  // Breaks: a removed mailbox's tracker cookies or images stay on disk because
  // others remain (multi-account), or because it was the last one.
  it.each([
    ['a non-last account', [password('a1'), password('a2')]],
    ['the last account', [password('a1')]],
  ])('clears the jar and cache when %s is removed', async (_label, registry) => {
    h.registry = registry;
    await expect(remove('a1')).resolves.toEqual({ success: true });
    expect(h.calls.filter((c) => c === 'content-clear')).toHaveLength(1);
  });

  // Neither is keyed by the registry, so an unreadable registry (which
  // rightly stops every keyed delete) is no reason to keep them; nor is an
  // idempotent re-run of an already-finished removal.
  it('clears them even when the registry is unreadable, and on a re-run', async () => {
    h.registry = [password('a1'), password('a2')];
    h.readFails = [true, true];
    await expect(remove('a1')).resolves.toEqual({ success: true });
    await expect(remove('a1')).resolves.toEqual({ success: true });
    expect(h.calls.filter((c) => c === 'content-clear')).toHaveLength(2);
  });

  // Breaks: a jar or cache that cannot be cleared fails the removal the user
  // asked for, or skips the steps after it.
  it('still succeeds, and still revalidates AI, when the clear fails', async () => {
    h.registry = [password('a1'), password('a2')];
    h.cookiesFail = true;
    await expect(remove('a1')).resolves.toEqual({ success: true });
    expect(h.calls.slice(-2)).toEqual(['ai-revalidate', 'content-clear']);
  });

  // The data goes first: the clear must never run for a removal that failed.
  it('does not clear when the account data could not be deleted', async () => {
    h.registry = [password('a1'), password('a2')];
    h.dataWipeFails = true;
    await expect(remove('a1')).resolves.toMatchObject({ success: false, error: 'EBUSY' });
    expect(h.calls).toEqual(['wipe:a1']);
  });
});
