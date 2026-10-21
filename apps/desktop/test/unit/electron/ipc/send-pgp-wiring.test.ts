import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the OpenPGP step is skipped on some send
// path — the OAuth-refresh retry sending the message unencrypted after the
// first attempt was encrypted — or an encrypted message's plaintext lands in
// the local Sent row, and from there in search, snippets and AI.

const h = vi.hoisted(() => ({ transform: vi.fn(), sendTransformFor: vi.fn(), assertResponseDelivery: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {},
  shell: {},
  app: { getPath: () => '/tmp' },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: vi.fn(),
  getStorage: vi.fn(() => null),
  getStorageFor: vi.fn(),
  getSyncEngine: vi.fn(() => null),
  getSyncEngineFor: vi.fn(),
  getSmtpClient: vi.fn(),
  getSmtpClientFor: vi.fn(),
  setSmtpClient: vi.fn(),
  setSmtpClientFor: vi.fn(),
  getMainWindow: vi.fn(),
  getCurrentAccountId: vi.fn(() => 'acct-1'),
  getAllAccountIds: vi.fn(() => []),
  sendToWindow: vi.fn(),
}));
vi.mock('../../../../electron/services/oauth-service', () => ({ getAccessTokenForMailHost: vi.fn(async () => 'fresh-token') }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({ getPipelineUserName: vi.fn(() => 'Me') }));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: vi.fn(),
  drainOutbox: vi.fn(),
  getOutboxQueueForAccount: vi.fn(),
  drainOutboxForAccount: vi.fn(),
  notifyOutboxChanged: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));
vi.mock('../../../../electron/services/pgp-service', () => ({ sendTransformFor: h.sendTransformFor }));
vi.mock('../../../../electron/ipc/follow-up-handlers', () => ({ recordFollowUpForSend: vi.fn() }));
vi.mock('../../../../electron/services/local-calendar-invitations', () => ({
  getLocalCalendarInvitationService: () => ({ assertResponseDelivery: h.assertResponseDelivery }),
  CalendarInvitationValidationError: class extends Error {},
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({ registryAccountEmail: () => 'recipient@sarv.com' }));

import { sendEmailFromMain, sentMirrorBody } from '../../../../electron/ipc/smtp-handlers';
import { CalendarInvitationValidationError } from '../../../../electron/services/local-calendar-invitations';
import { getSmtpClient } from '../../../../electron/shared';

const OPTIONS = { to: ['bob@example.org'], subject: 'hi', body: 'secret', pgp: { encrypt: true, sign: false } } as never;

function smtpClient(results: Array<Record<string, unknown>>, config: Record<string, unknown> = {}) {
  return {
    isConnected: () => true,
    getConfig: () => config,
    connect: vi.fn(async () => {}),
    sendEmail: vi.fn(async () => results.shift()),
  };
}

beforeEach(() => {
  h.sendTransformFor.mockReset().mockReturnValue(h.transform);
  h.assertResponseDelivery.mockReset();
});

describe('calendar RSVP delivery guard', () => {
  const response = { accountId: 'acct-1', to: ['organizer@example.com'], subject: 'Accepted', body: 'Accepted', calendarInvitationResponse: { invitationId: 'i1', sequence: 2, dtstampMs: 1234, deliveryToken: 'latest-choice' } };
  it('rechecks the exact receiving account and organizer immediately before sending', async () => {
    const client = smtpClient([{ success: false, error: 'synthetic transport result' }]);
    vi.mocked(getSmtpClient).mockReturnValue(client as never);
    await sendEmailFromMain(response);
    expect(h.assertResponseDelivery).toHaveBeenCalledExactlyOnceWith({ accountId: 'acct-1', organizer: 'organizer@example.com', accountEmail: 'recipient@sarv.com', ...response.calendarInvitationResponse });
    expect(client.sendEmail).toHaveBeenCalledOnce();
  });
  it.each([true, false])('blocks stale replies and retries unreadable state (validation=%s)', async validation => {
    const client = smtpClient([]); vi.mocked(getSmtpClient).mockReturnValue(client as never);
    h.assertResponseDelivery.mockImplementationOnce(() => { throw validation ? new CalendarInvitationValidationError('Meeting changed') : new Error('Calendar database is locked'); });
    expect(await sendEmailFromMain(response)).toMatchObject({ success: false, transient: !validation });
    expect(client.sendEmail).not.toHaveBeenCalled();
  });
  it('rejects extra recipients before the RSVP guard or transport', async () => {
    const client = smtpClient([]); vi.mocked(getSmtpClient).mockReturnValue(client as never);
    expect(await sendEmailFromMain({ ...response, bcc: ['someone@example.com'] })).toMatchObject({ success: false, transient: false });
    expect(h.assertResponseDelivery).not.toHaveBeenCalled(); expect(client.sendEmail).not.toHaveBeenCalled();
  });
  it('rechecks again after OAuth refresh so a changed invitation cannot send on retry', async () => {
    const client = smtpClient([{ success: false, error: 'Invalid credentials: token expired' }], { authMethod: 'oauth2', oauthProvider: 'sarv', username: 'recipient@sarv.com' });
    vi.mocked(getSmtpClient).mockReturnValue(client as never);
    h.assertResponseDelivery.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new CalendarInvitationValidationError('Meeting changed during token refresh'); });
    expect(await sendEmailFromMain(response)).toMatchObject({ success: false, transient: false, error: 'Meeting changed during token refresh' });
    expect(client.sendEmail).toHaveBeenCalledOnce(); expect(h.assertResponseDelivery).toHaveBeenCalledTimes(2);
  });
});

describe('sendEmailFromMain OpenPGP wiring', () => {
  // Breaks: the send's encrypt/sign request never reached the MIME transform.
  it('builds the transform from the send\'s pgp request and hands it to SMTP', async () => {
    const client = smtpClient([{ success: false, error: 'nope' }]);
    vi.mocked(getSmtpClient).mockReturnValue(client as never);
    await sendEmailFromMain(OPTIONS);
    expect(h.sendTransformFor).toHaveBeenCalledWith({ encrypt: true, sign: false });
    expect(client.sendEmail).toHaveBeenCalledWith(OPTIONS, h.transform);
  });

  // Breaks: after an OAuth token refresh the retry sent the message in plaintext.
  it('passes the same transform to the OAuth-refresh retry', async () => {
    const client = smtpClient(
      [{ success: false, error: 'Invalid credentials: token expired' }, { success: false, error: 'still' }],
      { authMethod: 'oauth2', oauthProvider: 'google', username: 'me@example.org' },
    );
    vi.mocked(getSmtpClient).mockReturnValue(client as never);
    await sendEmailFromMain(OPTIONS);
    expect(client.sendEmail).toHaveBeenCalledTimes(2);
    expect(client.sendEmail.mock.calls.every((call) => (call as unknown[])[1] === h.transform)).toBe(true);
  });
});

describe('sentMirrorBody', () => {
  // Breaks: an encrypted message's plaintext was written to the local DB.
  it('stores a placeholder for an encrypted send and the body otherwise', () => {
    expect(sentMirrorBody({ body: 'secret', htmlBody: '<p>secret</p>', pgp: { encrypt: true, sign: true } })).toEqual({
      bodyText: 'Encrypted message',
      bodyHtml: '',
    });
    expect(sentMirrorBody({ body: 'hi', htmlBody: '<p>hi</p>', pgp: { encrypt: false, sign: true } })).toEqual({
      bodyText: 'hi',
      bodyHtml: '<p>hi</p>',
    });
    expect(sentMirrorBody({ body: '' })).toEqual({ bodyText: '', bodyHtml: '' });
  });
});
