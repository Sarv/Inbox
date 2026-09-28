// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeClipboard } from '../../../../src/utils/clipboard';

/**
 * The app's one clipboard write.
 *
 * What breaks if this file goes red: a copy that fails throws into whatever
 * called it (a menu item's click, a button), or reports success for text that
 * never reached the clipboard — and every copy affordance built on it, the
 * copy buttons and the chat's right-click Copy, says the wrong thing.
 */

const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });

afterEach(() => {
  setClipboard(undefined);
});

describe('writeClipboard', () => {
  it('writes the text and reports success', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    setClipboard({ writeText });
    await expect(writeClipboard('the signed copy')).resolves.toBe(true);
    expect(writeText.mock.calls).toEqual([['the signed copy']]);
  });

  // Failure path: the browser refuses (the document lost focus). Reported,
  // never thrown.
  it('reports a refused write as a failure, without throwing', async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error('Document is not focused'))) });
    await expect(writeClipboard('x')).resolves.toBe(false);
  });

  // Failure path: no clipboard at all (a non-secure context).
  it('reports a missing clipboard as a failure', async () => {
    setClipboard(undefined);
    await expect(writeClipboard('x')).resolves.toBe(false);
  });
});
