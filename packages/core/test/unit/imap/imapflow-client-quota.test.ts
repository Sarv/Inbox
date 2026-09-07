import { describe, expect, it } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

// getQuota parses ImapFlow's QUOTA response (storage.usage/limit, already in
// BYTES) and is BEST-EFFORT: a server without QUOTA (returns false) or one that
// errors must yield null, never throw — a quota hiccup must never break sync.
// These reach into internals to stand the client up "connected" without a socket
// (same technique as imapflow-client-connected.test.ts).

const GB = 1024 ** 3;

const connectedClientWith = (getQuota: (path?: string) => Promise<any>): ImapFlowClient => {
  const c = new ImapFlowClient();
  const internals = c as unknown as { connectionState: string; client: any };
  internals.connectionState = 'authenticated';
  internals.client = { usable: true, getQuota };
  return c;
};

describe('ImapFlowClient.getQuota', () => {
  it('parses storage usage/limit (already bytes) into { used, limit }', async () => {
    const c = connectedClientWith(async () => ({ storage: { usage: 3 * GB, limit: 15 * GB, status: '20%' } }));
    expect(await c.getQuota()).toEqual({ used: 3 * GB, limit: 15 * GB });
  });

  it('returns null when the server does not advertise QUOTA (false)', async () => {
    const c = connectedClientWith(async () => false);
    expect(await c.getQuota()).toBeNull();
  });

  it('returns null for an unlimited / zero-limit mailbox (nothing meaningful to show)', async () => {
    const c = connectedClientWith(async () => ({ storage: { usage: 100, limit: 0 } }));
    expect(await c.getQuota()).toBeNull();
  });

  it('swallows a QUOTA command error and returns null (best-effort)', async () => {
    const c = connectedClientWith(async () => { throw new Error('NO quota command failed'); });
    expect(await c.getQuota()).toBeNull();
  });
});
