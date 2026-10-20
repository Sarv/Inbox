import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConnectionSlice, teardownStoreEnv } from './connection-slice-harness';

// CASA M-5: when the server of a STARTTLS account will not encrypt, main
// refuses the connect with code STARTTLS_UNAVAILABLE and a message saying what
// to change. What breaks if this file fails: the user sees "Disconnected" and
// nothing else (the message only reached console.warn), the banner stays up
// after the account is fixed, or callers cannot tell this refusal from a blip.

const REFUSAL = 'The incoming mail server mail.x.com did not agree to encrypt this session (STARTTLS), so Sarv Inbox stopped before sending your password.';
const config = { host: 'mail.x.com', port: 143, username: 'me@x.com', security: 'starttls', secure: false };

const api = (connect: () => Promise<unknown>) => ({
  imap: { connect: vi.fn(connect), removeSyncProgressListener: vi.fn(), onSyncProgress: vi.fn() },
  secureCreds: { set: vi.fn(async () => undefined), get: vi.fn(async () => null) },
});
const stubs = () => ({ loadFolders: vi.fn(async () => undefined), syncEmails: vi.fn(async () => undefined), setSyncStatus: vi.fn() });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  teardownStoreEnv();
  vi.restoreAllMocks();
});

describe('connect() — a refused STARTTLS', () => {
  it('keeps the message for the banner and tags the thrown error', async () => {
    const { state } = await loadConnectionSlice(stubs(), api(async () => ({ success: false, error: REFUSAL, code: 'STARTTLS_UNAVAILABLE' })));
    const error = await state.connect(config).catch((e: unknown) => e as Error & { code?: string });
    expect(error).toMatchObject({ message: REFUSAL, code: 'STARTTLS_UNAVAILABLE' });
    expect(state.connectionSecurityIssue).toBe(REFUSAL);
    expect(state.needsReauth).toBe(false);
  });

  // Any other failure is not this banner's business.
  it('leaves the issue alone for other failures', async () => {
    const { state } = await loadConnectionSlice(stubs(), api(async () => ({ success: false, error: 'connect ECONNREFUSED' })));
    await state.connect(config).catch(() => undefined);
    expect(state.connectionSecurityIssue ?? null).toBeNull();
  });

  // The fix (None, or a trustworthy network) connects: the banner must go.
  it('clears it on a successful connect', async () => {
    let refuse = true;
    const { state } = await loadConnectionSlice(stubs(), api(async () => (refuse
      ? { success: false, error: REFUSAL, code: 'STARTTLS_UNAVAILABLE' }
      : { success: true })));
    await state.connect(config).catch(() => undefined);
    expect(state.connectionSecurityIssue).toBe(REFUSAL);
    refuse = false;
    await state.connect({ ...config, security: 'none' });
    expect(state.connectionSecurityIssue).toBeNull();
    expect(state.connected).toBe(true);
  });
});

describe('connect() — a refused STARTTLS while another account was connected', () => {
  // Switching from a connected account to one whose server refuses: nothing
  // else resets `connected`. Breaks: the banner (gated on !connected) never
  // shows, and the account sits on "Reconnecting…" with no reason.
  it('marks the account not connected', async () => {
    const { state } = await loadConnectionSlice({ ...stubs(), connected: true, connectionStatus: 'reconnecting' },
      api(async () => ({ success: false, error: REFUSAL, code: 'STARTTLS_UNAVAILABLE' })));
    await state.connect(config).catch(() => undefined);
    expect(state.connected).toBe(false);
    expect(state.connectionStatus).toBe('disconnected');
  });
});

describe('selectAccount — refusals belong to the account they happened on', () => {
  // Breaks: account A's refusal stays in the store after switching to B; when B
  // later drops, the banner blames A's server and sends the user to B's settings.
  it("clears the previous account's incoming and sending refusals", async () => {
    const { account } = await import('./connection-slice-harness');
    const { state } = await loadConnectionSlice({
      accounts: [account('acct-a'), account('acct-b')],
      activeAccountId: 'acct-a',
      connectionSecurityIssue: 'The incoming mail server imap.a did not agree.',
      smtpSecurityIssue: 'The outgoing mail server smtp.a did not agree.',
      loadFolders: vi.fn(async () => {}), loadLabels: vi.fn(async () => {}), loadQuota: vi.fn(),
      startIdle: vi.fn(async () => {}), syncSingleFolder: vi.fn(async () => {}),
    }, {
      accounts: { setActive: vi.fn(async () => undefined) },
      imap: { isConnected: vi.fn(async () => ({ success: true, data: true })) },
    });

    await state.selectAccount('acct-b');

    expect(state.connectionSecurityIssue).toBeNull();
    expect(state.smtpSecurityIssue).toBeNull();
  });
});

describe('connectSmtp() — a refused STARTTLS on the sending server', () => {
  const SMTP_REFUSAL = 'The outgoing mail server smtp.x.com did not agree to encrypt this session (STARTTLS).';
  const smtp = { host: 'smtp.x.com', port: 587, username: 'me@x.com', password: 'pw', security: 'starttls', secure: false };

  // Startup and lazy send swallow this error. Breaks: mail waits in the Outbox
  // with no reason shown — or the banner stays after sending works again.
  it('keeps the message for the banner, and clears it once sending connects', async () => {
    let refuse = true;
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-a' }, {
      smtp: { connect: vi.fn(async () => (refuse ? { success: false, error: SMTP_REFUSAL, code: 'STARTTLS_UNAVAILABLE' } : { success: true })) },
      secureCreds: { set: vi.fn(async () => undefined) },
    });

    await expect(state.connectSmtp(smtp)).rejects.toThrow(SMTP_REFUSAL);
    expect(state.smtpSecurityIssue).toBe(SMTP_REFUSAL);

    refuse = false;
    await state.connectSmtp({ ...smtp, security: 'none' });
    expect(state.smtpSecurityIssue).toBeNull();
  });

  it('leaves it alone for other failures', async () => {
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-a' }, {
      smtp: { connect: vi.fn(async () => ({ success: false, error: 'Invalid login' })) },
    });
    await state.connectSmtp(smtp).catch(() => undefined);
    expect(state.smtpSecurityIssue ?? null).toBeNull();
  });
});

describe('addAccount — a refused new account rolls back cleanly', () => {
  // The probe passed but the connect was refused. Breaks: the rollback restores
  // the previous account but keeps the NEW account's refusal (and a
  // "disconnected" status), so the banner later blames the wrong server.
  it("restores the previous account's connection state, refusal included", async () => {
    const { state } = await loadConnectionSlice({
      ...stubs(),
      connected: true, connectionStatus: 'connected', connectionSecurityIssue: null,
      smtpSecurityIssue: 'The outgoing mail server smtp.prev did not agree.',
    }, {
      imap: { probeCredentials: vi.fn(async () => ({ success: true })), connect: vi.fn(async () => ({ success: false, error: REFUSAL, code: 'STARTTLS_UNAVAILABLE' })),
        removeSyncProgressListener: vi.fn(), onSyncProgress: vi.fn() },
      accounts: { setActive: vi.fn(async () => ({ success: true })) },
      secureCreds: { set: vi.fn(async () => undefined), get: vi.fn(async () => null) },
    });

    await expect(state.addAccount({ ...config, password: 'pw' })).rejects.toThrow(REFUSAL);

    expect(state.connected).toBe(true);
    expect(state.connectionStatus).toBe('connected');
    expect(state.connectionSecurityIssue).toBeNull();
    expect(state.smtpSecurityIssue).toBe('The outgoing mail server smtp.prev did not agree.');
  });
});

describe('refusals follow the active account', () => {
  const live = () => ({
    imap: { probeCredentials: vi.fn(async () => ({ success: true })), connect: vi.fn(async () => ({ success: true })),
      removeSyncProgressListener: vi.fn(), onSyncProgress: vi.fn() },
    accounts: { setActive: vi.fn(async () => ({ success: true })) },
    secureCreds: { set: vi.fn(async () => undefined), get: vi.fn(async () => null) },
  });

  // Breaks: adding account B (sending set up later) keeps account A's sending
  // refusal, so the banner tells B's user that A's server would not encrypt.
  it("an added account does not inherit the previous account's refusals", async () => {
    const { state } = await loadConnectionSlice({
      ...stubs(), loadLabels: vi.fn(async () => {}),
      activeAccountId: 'acct-a',
      smtpSecurityIssue: 'The outgoing mail server smtp.a did not agree.',
      connectionSecurityIssue: 'The incoming mail server imap.a did not agree.',
    }, live());

    await state.addAccount({ username: 'b@x.com', host: 'imap.b.com', port: 993, secure: true, password: 'pw' });

    expect(state.activeAccountId).not.toBe('acct-a');
    expect(state.smtpSecurityIssue).toBeNull();
    expect(state.connectionSecurityIssue).toBeNull();
  });

  // Breaks: removing sending leaves "your messages wait in the Outbox".
  it('removing sending drops its refusal', async () => {
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-a', smtpSecurityIssue: 'The outgoing mail server smtp.a did not agree.' },
      { smtp: { disconnect: vi.fn(async () => undefined) } });
    await state.removeSmtp();
    expect(state.smtpSecurityIssue).toBeNull();
  });

  // The user opened A (whose server refuses) and switched to the live B before
  // A's refusal came back. Breaks: A's late result marks B disconnected under
  // A's banner until the next switch.
  it("a late refusal for an account switched away from leaves the active one alone", async () => {
    const { account } = await import('./connection-slice-harness');
    let refuseA!: (r: unknown) => void;
    const { state } = await loadConnectionSlice({
      accounts: [account('acct-a', { imapConfig: config }), account('acct-b')],
      activeAccountId: 'acct-b',
      ...stubs(), loadLabels: vi.fn(async () => {}), loadQuota: vi.fn(),
      startIdle: vi.fn(async () => {}), syncSingleFolder: vi.fn(async () => {}),
    }, {
      accounts: { setActive: vi.fn(async () => undefined) },
      imap: {
        isConnected: vi.fn().mockResolvedValueOnce({ success: true, data: false }).mockResolvedValue({ success: true, data: true }),
        connect: vi.fn(() => new Promise((resolve) => { refuseA = resolve; })),
      },
      secureCreds: { set: vi.fn(async () => undefined), get: vi.fn(async () => null) },
    });

    await state.selectAccount('acct-a');          // starts A's connect, not awaited
    await state.selectAccount('acct-b');          // adopts B's live connection
    refuseA({ success: false, error: REFUSAL, code: 'STARTTLS_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(0);

    expect(state.activeAccountId).toBe('acct-b');
    expect(state.connected).toBe(true);
    expect(state.connectionStatus).toBe('connected');
    expect(state.connectionSecurityIssue).toBeNull();
  });

  // Same for sending: a refusal that lands after a switch is not the new account's.
  it('a late sending refusal after a switch is not recorded', async () => {
    let refuse!: (r: unknown) => void;
    const { state } = await loadConnectionSlice({ activeAccountId: 'acct-a' }, {
      smtp: { connect: vi.fn(() => new Promise((resolve) => { refuse = resolve; })) },
    });
    const pending = state.connectSmtp({ host: 'smtp.a.com', port: 587, username: 'a@x.com', password: 'pw', security: 'starttls' });
    await vi.advanceTimersByTimeAsync(0);
    state.activeAccountId = 'acct-b';
    refuse({ success: false, error: 'The outgoing mail server smtp.a.com did not agree.', code: 'STARTTLS_UNAVAILABLE' });
    await pending.catch(() => undefined);
    expect(state.smtpSecurityIssue ?? null).toBeNull();
  });
});
