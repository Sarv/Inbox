import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

// downloadPartRaw is the escape hatch for a part whose Content-Transfer-Encoding
// header lies: it fetches BODY[part] undecoded, where download() would hand back
// the (wrong) decoded bytes. Reaches into internals to stand the client up
// "connected" without a socket, as imapflow-client-quota.test.ts does.

const connectedClientWith = (fetchOne: (...args: any[]) => Promise<any>) => {
  const client = new ImapFlowClient();
  const internals = client as unknown as { connectionState: string; client: any };
  internals.connectionState = 'authenticated';
  internals.client = { usable: true, fetchOne };
  return client;
};

describe('ImapFlowClient.downloadPartRaw', () => {
  it('fetches the part by UID and returns its UNDECODED bytes', async () => {
    // Breaks if this ever routes through download(): the mis-declared base64
    // part would decode to junk again, which is the bug it exists to undo.
    const fetchOne = vi
      .fn()
      .mockResolvedValue({ bodyParts: new Map([['2', Buffer.from('<p>Hello World</p>')]]) });
    const raw = await connectedClientWith(fetchOne).downloadPartRaw(7, '2');

    expect(raw?.toString()).toBe('<p>Hello World</p>');
    expect(fetchOne).toHaveBeenCalledWith('7', { bodyParts: ['2'] }, { uid: true });
  });

  it('accepts a plain-object bodyParts as well as ImapFlow’s Map', async () => {
    // Breaks the shared IMAP fakes (and any non-ImapFlow client) if the Map
    // shape is assumed — `.get` would be undefined and throw.
    const client = connectedClientWith(async () => ({ bodyParts: { '2': Buffer.from('raw') } }));
    expect((await client.downloadPartRaw(7, '2'))?.toString()).toBe('raw');
  });

  it('returns null when the server answers with no parts at all', async () => {
    // Permanent "nothing there": the caller must keep the bytes it already has
    // rather than replacing them with nothing.
    expect(await connectedClientWith(async () => null).downloadPartRaw(7, '2')).toBeNull();
    expect(await connectedClientWith(async () => ({})).downloadPartRaw(7, '2')).toBeNull();
  });

  it('returns null when the requested part is missing from the response', async () => {
    const client = connectedClientWith(async () => ({ bodyParts: new Map() }));
    expect(await client.downloadPartRaw(7, '2')).toBeNull();
  });

  it('throws when the client is not connected, without issuing a fetch', async () => {
    // Transient: a disconnected client must fail loudly so the caller falls back,
    // never silently report "this attachment is empty".
    const fetchOne = vi.fn();
    const client = new ImapFlowClient();
    (client as unknown as { client: any }).client = { usable: true, fetchOne };
    await expect(client.downloadPartRaw(7, '2')).rejects.toThrow();
    expect(fetchOne).not.toHaveBeenCalled();
  });
});
