import { describe, expect, it } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

/**
 * `bytesReceived()` is the progress signal behind the body fetch's stall
 * timeout — it is what tells a slow transfer apart from a hung one.
 *
 * The distinction that matters is between "no bytes have arrived" and "there is
 * no reading to be had". The first is a stall and must count against the
 * deadline; the second must NOT look like one, or a client with no socket to
 * ask would report a frozen counter and its fetch would be given the full
 * ceiling before failing instead of failing fast.
 */

type Internals = { client: { stats: (reset?: boolean) => { sent: number; received: number } } | null };

const clientWithStats = (stats: Internals['client']): ImapFlowClient => {
  const c = new ImapFlowClient();
  (c as unknown as Internals).client = stats;
  return c;
};

describe('ImapFlowClient.bytesReceived', () => {
  // Breaks if the counter is read from the wrong field: the stall timeout would
  // see a constant and kill every long transfer at 30s, exactly as before.
  it('reports the socket read counter, and reports it as it advances', () => {
    let received = 0;
    const c = clientWithStats({ stats: () => ({ sent: 0, received }) });

    expect(c.bytesReceived()).toBe(0);
    received = 65_536;
    expect(c.bytesReceived()).toBe(65_536);
  });

  // No client to ask is "no reading", not "no progress" — a 0 here would be
  // indistinguishable from a genuinely silent socket.
  it('returns NaN rather than 0 when there is no underlying client', () => {
    expect(Number.isNaN(clientWithStats(null).bytesReceived())).toBe(true);
  });

  // A counter that throws must not take the body fetch down with it: this runs
  // inside the fetch's own timeout wrapper.
  it('returns NaN instead of throwing when the counter itself fails', () => {
    const c = clientWithStats({ stats: () => { throw new Error('socket gone'); } });
    expect(Number.isNaN(c.bytesReceived())).toBe(true);
  });
});
