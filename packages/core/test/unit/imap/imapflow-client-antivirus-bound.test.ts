import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

function connected(content: Readable) {
  const download = vi.fn(async () => ({ content }));
  const client = new ImapFlowClient(); const internals = client as any;
  internals.connectionState = 'authenticated'; internals.client = { usable: true, download };
  return { client, download };
}

describe('bounded antivirus MIME download', () => {
  it('returns decoded bytes within the cap', async () => {
    const { client, download } = connected(Readable.from([Buffer.from('syn'), Buffer.from('thetic')]));
    expect((await client.downloadPart(42, '3', { maxBytes: 9 }))?.toString()).toBe('synthetic');
    expect(download).toHaveBeenCalledWith('42', '3', { uid: true });
  });

  it('destroys the MIME stream when actual decoded bytes exceed the cap', async () => {
    const first = Buffer.alloc(8, 65); const second = Buffer.alloc(8, 66);
    const stream = Readable.from([first, second]); const destroy = vi.spyOn(stream, 'destroy'); const { client } = connected(stream);
    await expect(client.downloadPart(42, '3', { maxBytes: 9 })).rejects.toThrow(/byte limit/);
    expect(destroy).toHaveBeenCalled(); expect(stream.destroyed).toBe(true);
    expect(first.every(byte => byte === 0)).toBe(true); expect(second.every(byte => byte === 0)).toBe(true);
  });

  it('cancels a stalled stream, destroys it, and erases downloaded chunks', async () => {
    const partial = Buffer.from('synthetic partial content'); const stream = new Readable({ read() {} }); stream.push(partial);
    const { client } = connected(stream); const controller = new AbortController();
    const check = expect(client.downloadPart(42, '3', { maxBytes: 128, signal: controller.signal })).rejects.toThrow(/cancelled|Premature close/);
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await check;
    expect(stream.destroyed).toBe(true); expect(partial.every(byte => byte === 0)).toBe(true);
  });

  it('times out a stream that never yields another byte', async () => {
    const partial = Buffer.from('synthetic partial content'); const stream = new Readable({ read() {} }); stream.push(partial);
    const { client } = connected(stream);
    await expect(client.downloadPart(42, '3', { maxBytes: 128, timeoutMs: 5 })).rejects.toThrow(/timed out|Premature close/);
    expect(stream.destroyed).toBe(true); expect(partial.every(byte => byte === 0)).toBe(true);
  });

  it('does not start a download when already cancelled', async () => {
    const { client, download } = connected(new Readable({ read() {} })); const controller = new AbortController(); controller.abort();
    await expect(client.downloadPart(42, '3', { maxBytes: 128, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(download).not.toHaveBeenCalled();
  });
});
