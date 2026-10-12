import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CASA M-5: an account set to STARTTLS must REQUIRE the upgrade. ImapFlow
// checks it after CAPABILITY and before authenticating, so on a refusal nothing
// secret has been sent. What breaks if this file fails: the IMAP client stops
// asking ImapFlow to require the upgrade (a network attacker strips STARTTLS
// and reads the password or OAuth token), or the refusal reaches the user as
// "Server does not support STARTTLS" with no hint of what to do, retried as a
// generic connection failure.

let lastOptions: Record<string, unknown> | null = null;
let closed = 0;
let connectImpl: () => Promise<void> = async () => {};

class FakeFlow extends EventEmitter {
  capabilities = new Map<string, boolean>();
  constructor(opts: Record<string, unknown>) {
    super();
    lastOptions = opts;
  }
  connect(): Promise<void> { return connectImpl(); }
  close(): void { closed += 1; }
  async logout(): Promise<void> { /* not reached */ }
}

vi.mock('imapflow', () => ({ ImapFlow: FakeFlow }));

const { ImapFlowClient } = await import('../../../src/imap/imapflow-client');
const { __resetConnectionBudgets } = await import('../../../src/imap/connection-budget');
const { isStartTlsUnavailableError, isConnectionError, isAuthError, STARTTLS_UNAVAILABLE } = await import('../../../src/imap/imap-errors');

const cfg = (over: Record<string, unknown> = {}) => ({
  host: 'mail.example.org', port: 143, secure: false,
  username: 'u@example.org', password: 'pw', authMethod: 'password' as const,
  connectionTimeout: 10000, ...over,
});

/** ImapFlow's own refusal when doSTARTTLS is true and the upgrade is missing. */
const imapFlowRefusal = () => Object.assign(new Error('Server does not support STARTTLS'), { tlsFailed: true });

beforeEach(() => { __resetConnectionBudgets(); lastOptions = null; closed = 0; connectImpl = async () => {}; });
afterEach(() => { __resetConnectionBudgets(); });

describe('ImapFlowClient — connection security options', () => {
  it.each([
    ['a STARTTLS account', { security: 'starttls' }, { secure: false, doSTARTTLS: true }],
    ['a legacy secure:false account', {}, { secure: false, doSTARTTLS: true }],
    ['an SSL account', { security: 'ssl', port: 993 }, { secure: true, doSTARTTLS: undefined }],
    ["the user's explicit None", { security: 'none' }, { secure: false, doSTARTTLS: undefined }],
  ])('tells ImapFlow what %s needs', async (_label, over, expected) => {
    await new ImapFlowClient().connect(cfg(over) as never);
    expect(lastOptions).toMatchObject({ secure: expected.secure });
    expect(lastOptions?.doSTARTTLS).toBe(expected.doSTARTTLS);
  });
});

// Certificate checks for IMAP come from the same resolver as SMTP. Breaks: the
// IMAP client goes back to reading its own override (which arrived from the
// renderer and switched verification off for a saved password or an OAuth
// token), or drops the TLS 1.2 floor it used to lose on the way to ImapFlow.
describe('ImapFlowClient — certificate verification', () => {
  it.each([
    ['a default account', {}, true],
    ['an account that opted out', { allowInsecureTLS: true }, false],
    ['an OAuth account whose config opts out', { allowInsecureTLS: true, authMethod: 'oauth2', oauthProvider: 'gmail', accessToken: 't' }, true],
    ['a config carrying the old override', { tlsOptions: { rejectUnauthorized: false } }, true],
  ])('verifies for %s exactly when it should, with the TLS 1.2 floor', async (_label, over, verifies) => {
    await new ImapFlowClient().connect(cfg(over) as never);
    expect(lastOptions?.tls).toEqual({ rejectUnauthorized: verifies, minVersion: 'TLSv1.2' });
  });
});

describe('ImapFlowClient — a required STARTTLS the server will not do', () => {
  it('fails with its own code and a message saying what to change, and closes the socket', async () => {
    connectImpl = async () => { throw imapFlowRefusal(); };
    const error = await new ImapFlowClient().connect(cfg() as never).catch((e: unknown) => e as Error & { code?: string; serverResponse?: string });
    expect(error.code).toBe(STARTTLS_UNAVAILABLE);
    expect(error.message).toContain('The incoming mail server mail.example.org did not agree to encrypt');
    expect(error.message).toContain('set Connection security to None');
    expect(error.serverResponse).toBe('Server does not support STARTTLS');
    expect(isStartTlsUnavailableError(error)).toBe(true);
    expect(isConnectionError(error)).toBe(false);
    expect(isAuthError(error)).toBe(false);
    expect(closed).toBe(1);
  });

  // An OAuth refusal must not look like an expired token: no refresh, no
  // second dial with a fresh token over the same unencrypted session.
  it('does not refresh an OAuth token or retry', async () => {
    connectImpl = async () => { throw imapFlowRefusal(); };
    const resolveBearer = vi.fn(async () => 'token');
    await expect(new ImapFlowClient().connect(cfg({ authMethod: 'oauth2', oauthProvider: 'microsoft', resolveBearer }) as never))
      .rejects.toMatchObject({ code: STARTTLS_UNAVAILABLE });
    expect(resolveBearer).toHaveBeenCalledTimes(1);
    expect(resolveBearer).not.toHaveBeenCalledWith(true);
  });

  // A certificate failure after an accepted upgrade is a different problem:
  // None would not help, so it must not be told to switch.
  it('leaves other TLS failures as connection errors', async () => {
    connectImpl = async () => { throw Object.assign(new Error('self-signed certificate'), { tlsFailed: true, code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }); };
    const error = await new ImapFlowClient().connect(cfg() as never).catch((e: unknown) => e as Error & { code?: string });
    expect(error.code).toBe('CONNECTION_ERROR');
    expect(error.message).not.toContain('Connection security');
  });
});
