import { afterEach, describe, expect, it, vi } from 'vitest';

import * as floodBudget from '../../../src/extensions/runtime/flood-budget';
import { MAX_MESSAGE_BYTES, messageBytes, stringifyBounded } from '../../../src/utils/json-size';

// What breaks if this file fails: the whole app ends. In Electron 44, JSON.stringify
// of one flat string of ~256 MB is fatal and uncatchable ("Zone Allocation failed"),
// so every main-process caller that stringifies a value a stranger sized (an email
// body, an extension's message, a server's answer) measures it here first. A helper
// that stringified before measuring, or that let a caller raise the limit past the
// measured-safe 64 million characters, would hand the crash straight back.
// (`messageBytes` itself is pinned in extensions/flood-budget.test.ts.)

afterEach(() => {
  vi.restoreAllMocks();
});

describe('json-size', () => {
  // Breaks: two copies of the measure drift, and the extension bridge and the rest
  // of main disagree about what is too large to stringify.
  it('is the one implementation the extension flood budget uses', () => {
    expect(floodBudget.messageBytes).toBe(messageBytes);
    expect(floodBudget.MAX_MESSAGE_BYTES).toBe(MAX_MESSAGE_BYTES);
  });
});

describe('stringifyBounded', () => {
  // Breaks: ordinary values stop being serialised, and every store and log line
  // built on this helper loses its data.
  it('stringifies a value under the limit exactly as JSON.stringify does', () => {
    const value = { id: 'e1', tags: ['a', 'b'], nested: { n: 1, flag: true, none: null } };
    expect(stringifyBounded(value)).toBe(JSON.stringify(value));
    expect(stringifyBounded('plain')).toBe('"plain"');
    expect(stringifyBounded(42)).toBe('42');
  });

  // Breaks: the over-limit value is stringified to find out it is too big — the crash.
  it('refuses a value over the limit without stringifying it', () => {
    const stringify = vi.spyOn(JSON, 'stringify');

    expect(stringifyBounded({ body: 'x'.repeat(MAX_MESSAGE_BYTES + 1) })).toBeNull();

    expect(stringify).not.toHaveBeenCalled();
  });

  // Breaks: a caller's tighter budget (a log line) is ignored, and a large but
  // safe value is stringified on every call just to be cut to a few hundred characters.
  it('honours a lower limit', () => {
    const stringify = vi.spyOn(JSON, 'stringify');

    expect(stringifyBounded({ body: 'x'.repeat(2_000) }, 1_000)).toBeNull();
    expect(stringify).not.toHaveBeenCalled();
    expect(stringifyBounded({ body: 'x'.repeat(100) }, 1_000)).toBe(JSON.stringify({ body: 'x'.repeat(100) }));
  });

  // Breaks: a caller passing a generous limit (or Infinity) re-opens the crash.
  it('never allows more than the measured-safe limit, whatever the caller asks', () => {
    const stringify = vi.spyOn(JSON, 'stringify');

    expect(stringifyBounded('x'.repeat(MAX_MESSAGE_BYTES + 1), Number.POSITIVE_INFINITY)).toBeNull();

    expect(stringify).not.toHaveBeenCalled();
  });

  // Breaks: a cyclic value hangs the measure instead of being left to
  // JSON.stringify's own (catchable) TypeError, as before.
  it('leaves a cycle to JSON.stringify to reject', () => {
    const cyclic: Record<string, unknown> = { a: 'x' };
    cyclic.self = cyclic;
    expect(() => stringifyBounded(cyclic)).toThrow(TypeError);
  });
});
