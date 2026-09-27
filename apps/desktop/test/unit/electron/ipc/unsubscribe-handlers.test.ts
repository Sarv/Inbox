import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The unsubscribe IPC boundary.
 *
 * What breaks if this suite goes red is not a button — it is the rule that
 * makes the button safe. The renderer sends a message id and a ROUTE; the main
 * process resolves that route against the message's OWN stored headers. Let a
 * URL cross this boundary, or let a route resolve against a header that never
 * declared it, and a click inside a crafted email becomes an unauthenticated
 * POST from the reader's network to an address the attacker chose.
 *
 * Also pinned: the multi-account read (an All-Inboxes message must be read from
 * ITS account's database), and that every failure path answers rather than
 * throwing — this handler is driven by a user action with a dialog in front of it.
 */

const ONE_CLICK_HEADER = '<https://brand.example/u/abc>, <mailto:leave@brand.example>';
const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  emails: new Map<string, Record<string, unknown>>(),
  otherEmails: new Map<string, Record<string, unknown>>(),
  openExternal: vi.fn(async (_url: string) => undefined),
  // The result type is spelled out so a test can hand back a failure with a
  // null status (a request that never got an answer) without widening it.
  postOneClick: vi.fn(
    async (_url: string, _body: string): Promise<{ ok: boolean; status: number | null; error?: string }> =>
      ({ ok: true, status: 200 }),
  ),
  enqueueAndSend: vi.fn(async (_options: Record<string, unknown>) => ({ status: 'success' })),
  otherEnqueueAndSend: vi.fn(async (_options: Record<string, unknown>) => ({ status: 'success' })),
  notified: 0,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  shell: { openExternal: (url: string) => h.openExternal(url) },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => ({ getEmail: async (id: string) => h.emails.get(id) ?? null }),
  getStorageFor: (id: string) =>
    id === 'acct-2' ? { getEmail: async (emailId: string) => h.otherEmails.get(emailId) ?? null } : null,
  getCurrentAccountId: () => 'acct-1',
}));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: () => ({ enqueueAndSend: h.enqueueAndSend }),
  getOutboxQueueForAccount: () => ({ enqueueAndSend: h.otherEnqueueAndSend }),
  notifyOutboxChanged: () => { h.notified += 1; },
}));
vi.mock('../../../../electron/services/unsubscribe-service', () => ({
  postOneClick: (url: string, body: string) => h.postOneClick(url, body),
}));

import { registerUnsubscribeHandlers } from '../../../../electron/ipc/unsubscribe-handlers';

registerUnsubscribeHandlers();
const run = (emailId: string, route: string, accountId?: string) =>
  h.handlers.get('unsubscribe:run')!(null, emailId, route, accountId);

beforeEach(() => {
  h.emails.clear();
  h.otherEmails.clear();
  h.notified = 0;
  vi.clearAllMocks();
  h.postOneClick.mockResolvedValue({ ok: true, status: 200 });
  h.emails.set('bulk-1', {
    id: 'bulk-1',
    listUnsubscribe: ONE_CLICK_HEADER,
    listUnsubscribePost: ONE_CLICK_BODY,
  });
});

describe('unsubscribe:run', () => {
  it('posts the one-click request to the address the sender published', async () => {
    expect(await run('bulk-1', 'one-click')).toEqual({ success: true, route: 'one-click' });
    expect(h.postOneClick).toHaveBeenCalledWith('https://brand.example/u/abc', ONE_CLICK_BODY);
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  // THE regression. A message with no List-Unsubscribe-Post offers a PAGE, and
  // posting to it anyway is a write the sender never agreed to receive. The
  // route is refused, never quietly downgraded to the page.
  it('refuses one-click on a message that never declared it', async () => {
    h.emails.set('page-only', { id: 'page-only', listUnsubscribe: ONE_CLICK_HEADER, listUnsubscribePost: null });

    const result = await run('page-only', 'one-click');
    expect(result.success).toBe(false);
    expect(h.postOneClick).not.toHaveBeenCalled();
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('opens the sender page in the browser and says the reader is not done yet', async () => {
    h.emails.set('page-only', { id: 'page-only', listUnsubscribe: ONE_CLICK_HEADER, listUnsubscribePost: null });

    expect(await run('page-only', 'page')).toEqual({ success: true, route: 'page', needsBrowser: true });
    expect(h.openExternal).toHaveBeenCalledWith('https://brand.example/u/abc');
  });

  it('sends a mailto unsubscribe through the outbox', async () => {
    h.emails.set('list-1', { id: 'list-1', listUnsubscribe: '<mailto:leave@brand.example?subject=stop>' });

    expect(await run('list-1', 'mailto')).toEqual({ success: true, route: 'mailto' });
    expect(h.enqueueAndSend).toHaveBeenCalledWith({
      to: ['leave@brand.example'],
      subject: 'stop',
      body: 'unsubscribe',
      accountId: undefined,
    });
    // The Outbox screen has to learn about the new row, or it shows a stale list.
    expect(h.notified).toBe(1);
  });

  // Multi-account: an All-Inboxes message belongs to another account's DB, and
  // its unsubscribe mail must go out from THAT account, not the active one.
  it('reads and sends from the owning account', async () => {
    h.otherEmails.set('bulk-2', { id: 'bulk-2', listUnsubscribe: '<mailto:leave@other.example>' });

    expect(await run('bulk-2', 'mailto', 'acct-2')).toEqual({ success: true, route: 'mailto' });
    expect(h.otherEnqueueAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['leave@other.example'], accountId: 'acct-2' }),
    );
    expect(h.enqueueAndSend).not.toHaveBeenCalled();
  });

  it('refuses a route the message does not offer at all', async () => {
    h.emails.set('plain', { id: 'plain', listUnsubscribe: null, listUnsubscribePost: null });

    for (const route of ['one-click', 'page', 'mailto']) {
      expect((await run('plain', route)).success).toBe(false);
    }
    expect(h.postOneClick).not.toHaveBeenCalled();
    expect(h.enqueueAndSend).not.toHaveBeenCalled();
  });

  // Nothing but the three known routes reaches the resolver, and an id that is
  // not a string never reaches storage.
  it('rejects a malformed request without touching storage', async () => {
    expect((await run('bulk-1', 'DELETE')).success).toBe(false);
    expect((await run('', 'one-click')).success).toBe(false);
    expect((await run(null as unknown as string, 'one-click')).success).toBe(false);
    expect(h.postOneClick).not.toHaveBeenCalled();
  });

  it('answers rather than throwing when the message is gone', async () => {
    expect(await run('missing', 'one-click')).toEqual({ success: false, error: 'Email not found' });
  });

  // A transient network failure is reported to the reader, and nothing is
  // recorded as done — clicking again has to stay safe.
  it('passes a failed POST back as the reason it failed', async () => {
    h.postOneClick.mockResolvedValue({ ok: false, status: null, error: 'ETIMEDOUT' });
    expect(await run('bulk-1', 'one-click')).toEqual({ success: false, error: 'ETIMEDOUT' });
  });

  it('answers rather than throwing when the outbox rejects the mail', async () => {
    h.emails.set('list-1', { id: 'list-1', listUnsubscribe: '<mailto:leave@brand.example>' });
    h.enqueueAndSend.mockRejectedValue(new Error('SendQueue not initialized'));

    expect(await run('list-1', 'mailto')).toEqual({ success: false, error: 'SendQueue not initialized' });
  });
});
