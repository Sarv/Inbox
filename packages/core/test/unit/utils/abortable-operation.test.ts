import { describe, expect, it, vi } from 'vitest';

import { waitForAbortableOperation } from '../../../src/utils/abortable-operation';

// Breaks: cancellation leaves a native dialog/metadata wait stuck or a late rejection escapes unhandled.
describe('abortable operations', () => {
  it('passes through normal results and errors, with or without a signal', async () => {
    expect(await waitForAbortableOperation(Promise.resolve(3))).toBe(3);
    const controller = new AbortController();
    const cleanup = vi.spyOn(controller.signal, 'removeEventListener');
    expect(await waitForAbortableOperation(Promise.resolve(4), controller.signal)).toBe(4);
    await expect(waitForAbortableOperation(Promise.reject(new Error('lookup failed')), controller.signal)).rejects.toThrow(/lookup failed/);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it('rejects cancellation before or during a wait, and consumes late failures', async () => {
    const already = new AbortController(); already.abort('cancel');
    await expect(waitForAbortableOperation(Promise.resolve(1), already.signal)).rejects.toThrow(/cancelled/);
    const pending = new AbortController();
    let reject!: (reason: Error) => void;
    const original = new Promise<number>((_resolve, fail) => { reject = fail; });
    const waiting = waitForAbortableOperation(original, pending.signal);
    pending.abort(new Error('deadline expired'));
    await expect(waiting).rejects.toThrow(/deadline expired/);
    reject(new Error('late lookup failure')); await Promise.resolve();
  });
});
