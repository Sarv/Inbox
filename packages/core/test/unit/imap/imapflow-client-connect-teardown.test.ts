import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression: "Unhandled rejection: Error: Already logged out".
//
// ImapFlow runs its greeting→AUTH sequence DETACHED — startSession() is fired
// WITHOUT an await, "to get out of the current parsing thread". So a connect we
// force-close on failure can still reject that out-of-band chain a tick LATER
// (typically AuthenticationFailure("Already logged out") once the socket is in the
// LOGOUT state) and route the error through ImapFlow's emitError → `emit('error')`.
//
// Our connect-failure teardown calls removeAllListeners() to detach the dead
// socket from the connection manager. If that leaves the client with NO 'error'
// listener, the late listener-less `emit('error')` THROWS synchronously (the Node
// EventEmitter contract) inside ImapFlow's fire-and-forget catch — and escapes as
// a process-level "Unhandled rejection: Error: Already logged out". The teardown
// must leave a SILENT 'error' sink attached so that late error is absorbed.

let lastInstance: FakeFlow | null = null;
let connectImpl: () => Promise<void> = async () => {};

class FakeFlow extends EventEmitter {
  capabilities = new Map<string, boolean>();
  constructor(_opts: unknown) {
    super();
    // The test needs a handle on the instance the client constructs internally.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastInstance = this;
  }
  connect(): Promise<void> { return connectImpl(); }
  close(): void { /* force-close is a no-op for the test double */ }
}

vi.mock('imapflow', () => ({ ImapFlow: FakeFlow }));

// Imported AFTER the mock so the client binds to the fake ImapFlow.
const { ImapFlowClient } = await import('../../../src/imap/imapflow-client');
// The connection GOVERNOR is module-level + stateful (paces/ramps Gmail connects);
// reset it between tests so a leftover budget can't pace-block the next connect.
const { __resetConnectionBudgets } = await import('../../../src/imap/connection-budget');

const cfg = {
  host: 'imap.gmail.com', port: 993, secure: true,
  username: 'u@example.com', password: 'pw', authMethod: 'password' as const,
  connectionTimeout: 10000,
};

describe('ImapFlowClient.connect — teardown keeps an error sink for ImapFlow’s detached late error', () => {
  beforeEach(() => { __resetConnectionBudgets(); lastInstance = null; });
  afterEach(() => { __resetConnectionBudgets(); });

  it('absorbs a post-failure emit("error") instead of letting it throw (the unhandled rejection)', async () => {
    connectImpl = async () => { throw new Error('Too many simultaneous connections'); };
    const c = new ImapFlowClient();

    await expect(c.connect(cfg as never)).rejects.toThrow();
    expect(lastInstance).not.toBeNull();

    // The dead client's out-of-band chain fires 'error' a tick after we tore the
    // connect down. With the teardown's silent sink this is absorbed; WITHOUT it a
    // listener-less 'error' emit throws right here (and, in production, surfaces as
    // an unhandled rejection).
    expect(() => lastInstance!.emit('error', new Error('Already logged out'))).not.toThrow();
  });

  it('still detaches our own handlers on teardown (no spurious reconnect from the dead socket)', async () => {
    // The silent sink must be the ONLY 'error' listener left — our manager-facing
    // handler (which would trigger a reconnect) must have been removed, so a late
    // error from a failed connect can't feed the reconnect storm.
    connectImpl = async () => { throw new Error('Too many simultaneous connections'); };
    const c = new ImapFlowClient();
    await expect(c.connect(cfg as never)).rejects.toThrow();

    expect(lastInstance!.listenerCount('error')).toBe(1); // exactly the silent sink
    expect(lastInstance!.listenerCount('close')).toBe(0); // manager 'close' handler detached
  });
});
