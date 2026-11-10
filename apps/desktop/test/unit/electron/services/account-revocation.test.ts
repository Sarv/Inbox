import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * settleRevocation turns a sign-out's revocation into what accounts:remove
 * reports (CASA audit I-6). The removal flow's own tests cover the common
 * outcomes; these pin the edges. What breaks if this file fails: an unexpected
 * answer, an unknown provider or a slow provider makes removal report
 * 'revoked' (the user is never told to revoke by hand) or hang.
 */

vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { REVOCATION_WAIT_MS, settleRevocation } from '../../../../electron/services/account-revocation';

afterEach(() => { vi.useRealTimers(); });

describe('settleRevocation', () => {
  // The task's budget; the remove dialog's "Deleting…" waits at most this long.
  it('waits ten seconds by default', () => {
    expect(REVOCATION_WAIT_MS).toBe(10_000);
  });

  // Breaks: an outcome this code does not know is read as success.
  it('reports an unrecognised outcome as failed', async () => {
    await expect(settleRevocation('gmail', Promise.resolve('weird' as never))).resolves.toBe('failed');
  });

  // Breaks: an unknown provider id throws out of removal instead of reporting.
  it('reports no stored token for an unknown provider as unsupported', async () => {
    await expect(settleRevocation('nope' as never, Promise.resolve('no-account'))).resolves.toBe('unsupported');
  });

  // Transient: the provider never answers. Breaks: removal hangs on it.
  it('gives up after the given budget and reports failed', async () => {
    vi.useFakeTimers();
    const outcome = settleRevocation('gmail', new Promise(() => {}), 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(outcome).resolves.toBe('failed');
  });
});
