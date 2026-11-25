import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What the background AI did, stamped on the email's own row through the one
// shared action logger (logUserAction), read back by the list's AI icon, taken
// off again by Undo, and counted for the AI section. Real account databases.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  current: 'acct-a' as string | null,
  byId: new Map<string, unknown>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
}));
vi.mock('../../../../electron/shared', () => ({
  getCurrentAccountId: () => h.current,
  requireStorage: () => {
    const active = h.current ? h.byId.get(h.current) : null;
    if (!active) throw new Error('Storage not initialized');
    return active;
  },
  getSyncEngine: () => null,
  getStorageFor: (id: string) => h.byId.get(id) ?? null,
  getSyncEngineFor: () => null,
  getAllAccountRuntimes: () => [],
  getAccountIdForStorage: (storage: unknown) => [...h.byId].find(([, value]) => value === storage)?.[0] ?? null,
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) } }),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  resolveAccountIdentity: () => ({ email: 'me@me.test', name: 'Me', aliases: ['me@me.test'] }),
  readRegistryAccounts: () => [{ id: 'acct-a' }, { id: 'acct-b' }],
}));
vi.mock('../../../../electron/services/agent-config-store', () => ({ saveAgentConfig: vi.fn(), loadAgentConfig: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getIntelligence: vi.fn(() => null),
  getUnifiedPipeline: vi.fn(() => null),
  setPipelineUserProfile: vi.fn(),
  getPipelineAIConfig: vi.fn(() => null),
}));

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { logUserAction, registerAgentHandlers } from '../../../../electron/ipc/agent-handlers';
import { recordAiActions } from '../../../../electron/services/ai-action-record';
import { openTestAccount, type TestAccount } from '../../../helpers/account-storage';

registerAgentHandlers();

let dir = '';
let a: TestAccount;
let b: TestAccount;
const stamp = async (account: TestAccount, id: string) => (await account.storage.getEmail(id))?.aiActions;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-ai-actions-'));
  a = await openTestAccount(dir, 'a');
  b = await openTestAccount(dir, 'b');
  await a.add('t1', { id: 'm1', subject: 'Weekly deals' });
  await a.add('t2', { id: 'm2', subject: 'Invoice' });
  await b.add('t1', { id: 'm1', subject: 'Same id, other account' });
  h.current = 'acct-a';
  h.byId = new Map<string, unknown>([['acct-a', a.storage], ['acct-b', b.storage]]);
  h.sent = [];
});

afterEach(async () => {
  await a.close();
  await b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the background AI stamps what it did on the email', () => {
  // Breaks: the pipeline's automatic read/archive/draft leaves no AI icon on the email.
  it('stamps an automatic action, in the account that owns the email', async () => {
    await logUserAction('m1', 'read', { source: 'agent_auto' }, a.storage);
    expect(await stamp(a, 'm1')).toEqual([expect.objectContaining({ kind: 'read', auto: true })]);
    expect(await stamp(b, 'm1')).toBeUndefined();
    expect(h.sent).toEqual([{ channel: 'emails:ai-actions-updated', payload: { emailId: 'm1', accountId: 'acct-a', aiActions: [expect.objectContaining({ kind: 'read' })] } }]);
  });

  // Breaks: a drafted reply shows as sent, or an automatically sent reply as only drafted.
  it('tells a drafted reply from a sent one', async () => {
    await logUserAction('m1', 'reply', { source: 'agent_auto' }, a.storage);
    await logUserAction('m2', 'reply', { source: 'agent_auto', actionValue: 'auto-sent' }, a.storage);
    expect((await stamp(a, 'm1'))?.map(action => action.kind)).toEqual(['draft']);
    expect((await stamp(a, 'm2'))?.map(action => action.kind)).toEqual(['sent']);
  });

  // Breaks: the user's own clicks, or an Inbox Agent change (recorded where
  // its change set applies, with the right approved/automatic flag), are
  // stamped a second time here as automatic AI actions.
  it.each(['user', 'agent_approved', 'rule', 'system'] as const)('leaves a %s action alone', async (source) => {
    await logUserAction('m1', 'read', { source }, a.storage);
    expect(await stamp(a, 'm1')).toBeUndefined();
    expect(h.sent).toEqual([]);
  });

  // Breaks: opening or ignoring an email counts as something the AI did to it.
  it('leaves an action that changes nothing alone', async () => {
    await logUserAction('m1', 'open', { source: 'agent_auto' }, a.storage);
    expect(await stamp(a, 'm1')).toBeUndefined();
  });

  // Breaks: undoing an automatic action from the Activity log leaves its AI icon behind.
  it('takes the stamp off when the action is undone', async () => {
    await logUserAction('m1', 'read', { source: 'agent_auto' }, a.storage);
    const actions = (await h.handlers.get('agent:getAgentActions')!({} as never, 10)) as { data: Array<{ id: string; emailId: string }> };
    const logged = actions.data.find(action => action.emailId === 'm1')!;
    const undone = (await h.handlers.get('agent:undoAction')!({} as never, logged.id)) as { success: boolean };
    expect(undone.success).toBe(true);
    expect(await stamp(a, 'm1')).toBeUndefined();
    expect(h.sent.at(-1)).toEqual({ channel: 'emails:ai-actions-updated', payload: { emailId: 'm1', accountId: 'acct-a', aiActions: [] } });
  });

  // Breaks: the AI section's counts disagree with what the list shows.
  it('counts what it stamped for the AI section', async () => {
    await logUserAction('m1', 'read', { source: 'agent_auto' }, a.storage);
    await logUserAction('m2', 'read', { source: 'agent_auto' }, a.storage);
    await logUserAction('m2', 'archive', { source: 'agent_auto' }, a.storage);
    const counts = (await h.handlers.get('agent:getAiActionCounts')!({} as never)) as { success: boolean; data: { byKind: Record<string, number>; emails: number } };
    expect(counts.success).toBe(true);
    expect(counts.data.byKind).toMatchObject({ read: 2, archive: 1, draft: 0 });
    expect(counts.data.emails).toBe(2);
  });
});

describe('recording never breaks the change it describes', () => {
  let logs: CapturedLogs;
  beforeEach(() => { logs = captureLogs({ setLogSink, setLogLevel, getLogLevel }); });
  afterEach(() => { logs.stop(); });

  // Breaks: a database error while stamping throws into the mail action that
  // already happened, or its log line names the emails it was about.
  it('swallows a failing store and logs only the kind and a count', () => {
    const SENTINEL = 'SENTINEL-email-id-7f3a';
    const failing = { getRepositories: () => ({ agent: {
      recordAiActions: () => { throw Object.assign(new Error(`SQLITE_FULL while writing ${SENTINEL}`), { code: 'SQLITE_FULL' }); },
      forgetAiActions: () => [], getAiActionsRaw: () => null,
    } }) };
    expect(() => recordAiActions(failing, [SENTINEL], 'archive', { auto: true })).not.toThrow();
    const written = logs.lines.join('\n');
    expect(written).toContain('could not record an AI action');
    expect(written).toContain('SQLITE_FULL');
    expect(written).not.toContain(SENTINEL);
    expect(h.sent).toEqual([]);
  });
});
