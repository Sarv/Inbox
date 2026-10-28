import type { SendEmailOptions } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const mailbox = () => ({
    getEmailsByMessageIds: vi.fn(),
    actions: [] as Array<{ emailId: string; actionType: string; source: string; actionValue: string }>,
    repo: { getActionsByEmail: vi.fn(), getPendingDecisions: vi.fn() },
    getRepositories() { return { agent: this.repo }; },
  });
  return {
    a: mailbox(), b: mailbox(), active: 'acct-a', logUserAction: vi.fn(),
    client: { config: { from: 'me@example.test', host: 'smtp.example.test' }, isConnected: () => true, getConfig: () => ({}), sendEmail: vi.fn() },
  };
});

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {}, app: { getPath: () => '/tmp' } }));
vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.active === 'acct-a' ? h.a : h.b,
  getStorageFor: (id: string) => id === 'acct-b' ? h.b : id === 'acct-a' ? h.a : null,
  getCurrentAccountId: () => h.active,
  getSmtpClient: () => h.client, getSmtpClientFor: () => h.client,
  setSmtpClient: vi.fn(), setSmtpClientFor: vi.fn(), getMainWindow: () => null,
  getSyncEngine: () => null, getSyncEngineFor: () => null,
  getAccountIdForStorage: (storage: unknown) => storage === h.a ? 'acct-a' : 'acct-b',
}));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({ getPipelineUserName: () => 'Me' }));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ registryAccountEmail: () => 'me@example.test' }));
vi.mock('../../../../electron/services/oauth-service', () => ({ getAccessTokenForMailHost: vi.fn() }));
vi.mock('../../../../electron/services/pgp-service', () => ({ sendTransformFor: vi.fn() }));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: vi.fn(), drainOutbox: vi.fn(), getOutboxQueueForAccount: vi.fn(),
  drainOutboxForAccount: vi.fn(), notifyOutboxChanged: vi.fn(),
}));
vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: h.logUserAction }));
vi.mock('../../../../electron/ipc/draft-handlers', () => ({ deleteDraftsForThread: vi.fn() }));
vi.mock('../../../../electron/ipc/follow-up-handlers', () => ({ recordFollowUpForSend: vi.fn() }));
vi.mock('../../../../electron/services/local-calendar-invitations', () => ({
  getLocalCalendarInvitationService: () => ({ assertResponseDelivery: vi.fn() }),
  CalendarInvitationValidationError: class extends Error {},
}));

import { sendEmailFromMain } from '../../../../electron/ipc/smtp-handlers';

const options: SendEmailOptions = {
  to: ['client@example.test'], subject: 'Re: Proposal', body: 'The updated quote is attached.', inReplyTo: '<original@example.test>',
};

beforeEach(() => {
  h.active = 'acct-a';
  h.client.sendEmail.mockReset().mockResolvedValue({ success: true, messageId: '<sent@example.test>' });
  for (const storage of [h.a, h.b]) {
    storage.actions = [];
    storage.getEmailsByMessageIds.mockReset().mockResolvedValue([{ id: 'original', messageId: '<original@example.test>', fromAddress: 'client@example.test', threadId: 'thread-1' }]);
    storage.repo.getPendingDecisions.mockReset().mockResolvedValue([]);
    storage.repo.getActionsByEmail.mockReset().mockImplementation(async (id: string) => storage.actions.filter(action => action.emailId === id));
  }
  h.logUserAction.mockReset().mockImplementation(async (emailId: string, actionType: string, actionOptions: { source: string; actionValue: string }, storage: typeof h.a) => {
    storage.actions.push({ emailId, actionType, ...actionOptions });
  });
});

describe('successful manual replies provide mailbox-local engagement evidence', () => {
  it('records a reply only after SMTP accepts it and identifies the original sender in the sending mailbox', async () => {
    expect(await sendEmailFromMain(options)).toMatchObject({ success: true });
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('original', 'reply', {
      source: 'user', threadId: 'thread-1', senderAddress: 'client@example.test', actionValue: JSON.stringify({ sentMessageId: 'sent@example.test' }),
    }, h.a);
    expect(h.client.sendEmail.mock.invocationCallOrder[0]).toBeLessThan(h.logUserAction.mock.invocationCallOrder[0]);
  });

  it('retains the explicitly named account when the active mailbox changes during SMTP submission', async () => {
    let accept!: (result: unknown) => void;
    h.client.sendEmail.mockReturnValueOnce(new Promise(resolve => { accept = resolve; }));
    const pending = sendEmailFromMain({ ...options, accountId: 'acct-b' });
    h.active = 'acct-b';
    accept({ success: true, messageId: '<sent@example.test>' });
    await pending;
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('original', 'reply', expect.objectContaining({ source: 'user' }), h.b);
    expect(h.a.actions).toEqual([]);
  });

  it('keeps an unscoped send in its original mailbox if the active account changes while sending', async () => {
    let accept!: (result: unknown) => void;
    h.client.sendEmail.mockReturnValueOnce(new Promise(resolve => { accept = resolve; }));
    const pending = sendEmailFromMain(options);
    h.active = 'acct-b';
    accept({ success: true, messageId: '<sent@example.test>' });
    await pending;
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('original', 'reply', expect.objectContaining({ source: 'user' }), h.a);
  });

  it('records reply-all without treating CC recipients as separate inbound senders', async () => {
    await sendEmailFromMain({ ...options, cc: ['team@example.test'] });
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('original', 'reply_all', expect.objectContaining({ senderAddress: 'client@example.test' }), h.a);
  });

  it('does not teach from a failed/queued attempt but records a later successful outbox retry once', async () => {
    h.client.sendEmail.mockResolvedValueOnce({ success: false, transient: true, error: 'offline' });
    expect(await sendEmailFromMain(options)).toMatchObject({ success: false, transient: true });
    expect(h.logUserAction).not.toHaveBeenCalled();
    await sendEmailFromMain(options);
    await sendEmailFromMain(options);
    expect(h.logUserAction).toHaveBeenCalledOnce();
  });

  it('does not mistake an autonomous agent send for the user replying', async () => {
    expect(await sendEmailFromMain(options, { source: 'agent_auto' })).toMatchObject({ success: true });
    expect(h.logUserAction).not.toHaveBeenCalled();
  });

  it('does not trust a provenance flag supplied inside the mail payload', async () => {
    await sendEmailFromMain({ ...options, source: 'agent_auto' } as SendEmailOptions);
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('original', 'reply', expect.objectContaining({ source: 'user' }), h.a);
  });

  it.each(['fresh message', 'missing parent', 'wrong parent', 'failed history lookup'])('does not fabricate a reply event for %s', async condition => {
    if (condition === 'missing parent') h.a.getEmailsByMessageIds.mockResolvedValue([]);
    if (condition === 'wrong parent') h.a.getEmailsByMessageIds.mockResolvedValue([{ id: 'wrong', messageId: '<different@example.test>', fromAddress: 'other@example.test' }]);
    if (condition === 'failed history lookup') h.a.repo.getActionsByEmail.mockRejectedValue(new Error('database unavailable'));
    const result = await sendEmailFromMain(condition === 'fresh message' ? { ...options, inReplyTo: undefined } : options);
    expect(result.success).toBe(true);
    expect(h.logUserAction).not.toHaveBeenCalled();
  });

  it('serializes concurrent completion of the same SMTP Message-ID to avoid duplicate engagement', async () => {
    await Promise.all([sendEmailFromMain(options), sendEmailFromMain(options)]);
    expect(h.logUserAction).toHaveBeenCalledOnce();
  });
});
