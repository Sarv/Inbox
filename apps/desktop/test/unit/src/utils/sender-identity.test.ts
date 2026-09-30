import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSenderIdentityCache,
  getCachedSenderIdentity,
  getSenderIdentityVersion,
  requestSenderIdentity,
  subscribeSenderIdentity,
} from '../../../../src/utils/sender-identity';

/**
 * The renderer's sender-identity cache, as seen from OUTSIDE React — the
 * remote-image decision reads the verified-brand tick synchronously.
 *
 * What breaks if this file goes red: a verified brand's mail keeps its image
 * banner with "From trusted senders" on because nothing told the open message that the
 * brand lookup had landed, or every render re-asks the main process for an
 * identity it already has.
 */

let getSender: ReturnType<typeof vi.fn>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  getSender = vi.fn(async (address: string) => ({
    success: true,
    data: { address, domain: 'brand.test', bimi: { status: 'verified' }, favicon: null, faviconStatus: null, contactPhoto: null, pending: false },
  }));
  (globalThis as any).window = {
    electronAPI: { identity: { getSender, onUpdated: vi.fn() } },
    addEventListener: vi.fn(),
  };
  clearSenderIdentityCache();
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe('sender identity — outside React', () => {
  // Breaks: the verified-brand part of "From trusted senders" never re-decides.
  it('asks main once for an uncached address and notifies when it lands', async () => {
    const listener = vi.fn();
    const off = subscribeSenderIdentity(listener);
    const before = getSenderIdentityVersion();

    requestSenderIdentity('News@Brand.test');
    requestSenderIdentity('news@brand.test'); // in flight: not asked twice
    await settle();
    expect(getSender).toHaveBeenCalledTimes(1);
    expect(getCachedSenderIdentity('news@brand.test')?.bimi?.status).toBe('verified');
    expect(listener).toHaveBeenCalled();
    expect(getSenderIdentityVersion()).toBeGreaterThan(before);

    requestSenderIdentity('news@brand.test'); // cached: not asked again
    requestSenderIdentity('');
    await settle();
    expect(getSender).toHaveBeenCalledTimes(1);
    off();
  });

  // Transient failure: a failed lookup caches nothing and notifies nobody (no
  // re-render loop), and the next ask tries again.
  it('caches nothing on a failed lookup and retries on the next ask', async () => {
    getSender.mockRejectedValueOnce(new Error('offline'));
    const listener = vi.fn();
    const off = subscribeSenderIdentity(listener);
    requestSenderIdentity('news@brand.test');
    await settle();
    expect(getCachedSenderIdentity('news@brand.test')).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    requestSenderIdentity('news@brand.test');
    await settle();
    expect(getCachedSenderIdentity('news@brand.test')).not.toBeNull();
    off();
  });
});
