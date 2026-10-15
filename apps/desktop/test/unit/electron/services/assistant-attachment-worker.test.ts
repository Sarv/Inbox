import type { EventEmitter } from 'node:events';
import type { WorkerOptions } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn>; file: string; options: WorkerOptions }> }));

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor(readonly file: string, readonly options: WorkerOptions) {
      super();
      state.workers.push(this);
    }
  } };
});

import { runAssistantAttachmentWorker } from '../../../../electron/services/assistant-attachment-worker';

afterEach(() => { state.workers.splice(0); vi.useRealTimers(); });
const ready = { status: 'ready', segments: [{ text: 'INR 250000', locator: { kind: 'page', label: 'Page 1', page: 1 } }], truncated: false };

describe('bounded assistant document worker', () => {
  it('sends a private bytes copy to the packaged worker with explicit heap limits', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = runAssistantAttachmentWorker('quote.pdf', bytes);
    const worker = state.workers[0];
    expect(worker.file).toMatch(/assistant-attachment-extract\.worker\.js$/);
    expect(worker.options.resourceLimits).toEqual({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 });
    expect(worker.options.workerData.bytes).not.toBe(bytes);
    worker.emit('message', ready);
    expect(await result).toEqual(ready);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('terminates documents that exceed 15 seconds and exposes an explicit coverage gap', async () => {
    vi.useFakeTimers();
    const result = runAssistantAttachmentWorker('quote.pdf', new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).status).toBe('timeout');
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('terminates an in-flight parser on cancellation', async () => {
    const controller = new AbortController();
    const result = runAssistantAttachmentWorker('quote.pdf', new Uint8Array([1]), controller.signal);
    controller.abort();
    expect((await result).status).toBe('cancelled');
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('caps concurrent workers and recovers after a parser crash', async () => {
    const first = runAssistantAttachmentWorker('a.pdf', new Uint8Array([1]));
    const second = runAssistantAttachmentWorker('b.pdf', new Uint8Array([2]));
    expect((await runAssistantAttachmentWorker('c.pdf', new Uint8Array([3]))).status).toBe('unavailable');
    state.workers[0].emit('error', new Error('private file /Users/secret.pdf'));
    state.workers[1].emit('exit', 1);
    expect((await first).status).toBe('malformed');
    expect((await second).status).toBe('unavailable');
    const next = runAssistantAttachmentWorker('d.pdf', new Uint8Array([4]));
    state.workers[2].emit('message', ready);
    expect((await next).status).toBe('ready');
  });
});
