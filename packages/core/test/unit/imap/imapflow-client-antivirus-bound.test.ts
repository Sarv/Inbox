import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

function connected(content: Readable) {
  const download = vi.fn(async () => ({ content }));
  const fetchOne = vi.fn(async () => ({ uid: 42, size: 1024 }));
  const client = new ImapFlowClient(); const internals = client as any;
  internals.connectionState = 'authenticated'; internals.client = { usable: true, download, fetchOne };
  return { client, download, fetchOne };
}

describe('bounded antivirus MIME download', () => {
  it('returns decoded bytes within the cap', async () => {
    const { client, download } = connected(Readable.from([Buffer.from('syn'), Buffer.from('thetic')]));
    expect((await client.downloadPart(42, '3', { maxBytes: 9 }))?.toString()).toBe('synthetic');
    expect(download).toHaveBeenCalledWith('42', '3', { uid: true, maxBytes: 10, chunkSize: 1025 });
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

  it('does not start a body transfer after cancellation during size metadata', async () => {
    const { client, download, fetchOne } = connected(Readable.from([]));
    let finishMetadata!: (value: { uid: number; size: number }) => void;
    fetchOne.mockImplementation(() => new Promise(resolve => { finishMetadata = resolve; }));
    const controller = new AbortController();
    const result = client.downloadPart(42, '3', { maxBytes: 128, signal: controller.signal });
    const check = expect(result).rejects.toThrow(/cancelled/);
    controller.abort(); finishMetadata({ uid: 42, size: 1024 }); await check;
    expect(download).not.toHaveBeenCalled();
  });

  it('bounds the initial MIME header FETCH and recycles its socket before returning a timeout', async () => {
    vi.useFakeTimers();
    try {
      const { client, download } = connected(new Readable({ read() {} }));
      const close = vi.fn(); (client as any).client.close = close;
      download.mockImplementation(() => new Promise(() => {}));
      const result = client.downloadPart(42, '2.MIME', { maxBytes: 65536, timeoutMs: 20_000 });
      const check = expect(result).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(20_000); await check;
      expect(close).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith('42', '2.MIME', { uid: true, maxBytes: 65537, chunkSize: 1025 });
    } finally { vi.useRealTimers(); }
  });

  it('bounds the message-size preflight and recycles a stalled connection', async () => {
    vi.useFakeTimers();
    try {
      const { client, download, fetchOne } = connected(new Readable({ read() {} }));
      const close = vi.fn(); (client as any).client.close = close;
      fetchOne.mockImplementation(() => new Promise(() => {}));
      const check = expect(client.downloadPart(42, '3', { maxBytes: 128, timeoutMs: 20_000 })).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(20_000); await check;
      expect(close).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([undefined, NaN, 0, -1, 1.5])('refuses invalid enclosing-message size %s before fetching any content', async size => {
    const { client, download, fetchOne } = connected(Readable.from([]));
    fetchOne.mockResolvedValue({ uid: 42, size: size as number });
    await expect(client.downloadPart(42, '3', { maxBytes: 128 })).rejects.toThrow(/size is unavailable/);
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses metadata for a different UID', async () => {
    const { client, download, fetchOne } = connected(Readable.from([]));
    fetchOne.mockResolvedValue({ uid: 43, size: 1024 });
    await expect(client.downloadPart(42, '3')).rejects.toThrow(/size is unavailable/);
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses an enclosing message over the wire budget without downloading it', async () => {
    const { client, download, fetchOne } = connected(Readable.from([]));
    fetchOne.mockResolvedValue({ uid: 42, size: 2 * 1024 * 1024 });
    await expect(client.downloadPart(42, '3', { maxBytes: 128 })).rejects.toThrow(/download byte limit/);
    expect(download).not.toHaveBeenCalled();
  });

  it('caps unconfigured attachment downloads before allocating a message-sized window', async () => {
    const { client, download, fetchOne } = connected(Readable.from([]));
    fetchOne.mockResolvedValue({ uid: 42, size: 202 * 1024 * 1024 });
    await expect(client.downloadPart(42, '3')).rejects.toThrow(/download byte limit/);
    expect(download).not.toHaveBeenCalled();
  });

  it('allows small MIME-header probes in a larger enclosing message while capping header output', async () => {
    const { client, download, fetchOne } = connected(Readable.from([Buffer.from('header')]));
    fetchOne.mockResolvedValue({ uid: 42, size: 10 * 1024 * 1024 });
    expect((await client.downloadPart(42, '3.MIME', { maxBytes: 65536 }))?.toString()).toBe('header');
    expect(download).toHaveBeenCalledWith('42', '3.MIME', { uid: true, maxBytes: 65537, chunkSize: 10 * 1024 * 1024 + 1 });
  });
});
