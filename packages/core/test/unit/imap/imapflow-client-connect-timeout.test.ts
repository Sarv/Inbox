import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression for the Gmail "Unexpected close / too many connections" STORM.
//
// ImapFlow bounds only the socket + greeting (connectionTimeout/greetingTimeout);
// the AUTHENTICATE phase after that is bounded only by the 13-minute socketTimeout.
// Near a server's per-account connection cap, AUTH stalls — and a caller's outer
// withTimeout firing would ABANDON connect() with the socket still half-open,
// holding a cap slot for up to 13 minutes and feeding the storm. ImapFlowClient
// must bound the WHOLE connect itself and FORCE-CLOSE the socket on a stall so the
// slot is released immediately. This is the single choke point every caller
// (foreground, pool, background, reconnect) goes through.

const closeSpy = vi.fn();
let connectImpl: () => Promise<void> = async () => {};

vi.mock('imapflow', () => ({
  ImapFlow: class {
    capabilities = new Map<string, boolean>();
    constructor(_opts: unknown) {}
    on() { /* event wiring not needed for these tests */ }
    connect() { return connectImpl(); }
    close() { closeSpy(); }
    removeAllListeners() { /* no-op */ }
  },
}));

// Imported AFTER the mock so it binds to the fake ImapFlow.
const { ImapFlowClient } = await import('../../../src/imap/imapflow-client');
// The connection GOVERNOR is module-level and now STATEFUL per account (it paces
// Gmail connect starts and ramps the cold-start cap), so a budget left over from
// one test would pace/ramp-block the next test's connect on a timer this file
// never advances. Reset it between tests so each connect starts from a clean slate.
const { __resetConnectionBudgets } = await import('../../../src/imap/connection-budget');

const cfg = {
  host: 'imap.gmail.com', port: 993, secure: true,
  username: 'u@example.com', password: 'pw', authMethod: 'password' as const,
  connectionTimeout: 10000,
};

describe('ImapFlowClient.connect — AUTH-stall timeout force-closes the socket', () => {
  beforeEach(() => { vi.useFakeTimers(); closeSpy.mockClear(); __resetConnectionBudgets(); });
  afterEach(() => { vi.useRealTimers(); __resetConnectionBudgets(); });

  it('rejects AND closes the leaked socket when connect() hangs past the timeout', async () => {
    connectImpl = () => new Promise<void>(() => {}); // never resolves — AUTH stall
    const c = new ImapFlowClient();

    const settled = c.connect(cfg as never).then(() => 'ok', (e) => e as Error);
    await vi.advanceTimersByTimeAsync(10000 * 2 + 500); // past connectTimeoutMs (connectionTimeout*2)
    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/timed out/i);
    expect(closeSpy).toHaveBeenCalledTimes(1); // the half-open socket was released
    expect(c.isConnected()).toBe(false);       // and we don't report a live connection
  });

  it('does NOT close the socket on a normal fast connect', async () => {
    connectImpl = async () => { /* connects immediately */ };
    const c = new ImapFlowClient();

    await c.connect(cfg as never);

    expect(closeSpy).not.toHaveBeenCalled();
    expect(c.isConnected()).toBe(true);
  });
});
