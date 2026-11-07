/**
 * How much an extension may keep. Each read of its store is a parse of the whole file on
 * the main thread, measured at 150 ms at 300 MB, so unbounded storage is a slow way to take
 * the app down. But this is the user's data: going over must never lose any of it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionContextImpl } from '../../../src/extensions/extension-api';
import type { ExtensionStorageBackend } from '../../../src/extensions/extension-api';
import {
  ExtensionManager,
  STORAGE_MAX_KEY_LENGTH,
  STORAGE_MAX_TOTAL_BYTES,
  STORAGE_MAX_VALUE_BYTES,
} from '../../../src/extensions/extension-manager';
import { MAX_MESSAGE_BYTES } from '../../../src/extensions/runtime/flood-budget';
import { createEventBus } from '../../../src/pipeline/event-bus';

let base: string;
let store: ExtensionStorageBackend;
const file = () => join(base, 'extension-storage', 'ext', 'storage.json');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sarv-storage-'));
  const manager = new ExtensionManager({ extensionsBaseDir: base });
  store = (manager as unknown as { host: { storageBackend: ExtensionStorageBackend } }).host.storageBackend;
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const mb = (n: number) => 'x'.repeat(n * 1024 * 1024);

describe('extension storage limits', () => {
  it('stores and reads ordinary values', async () => {
    await store.set('ext', 'k', { a: 1 });
    expect(await store.get('ext', 'k')).toEqual({ a: 1 });
  });

  // Measured: JSON.stringify of a 256 MB flat string ends the whole app, uncatchably. So a
  // value this size must be refused on its measure alone. Measuring it by stringifying it,
  // as this did, turned the storage limit into the crash it was added to prevent: a panel
  // reaches this with no bridge in front of it.
  it('refuses a value far over the limit without stringifying it', async () => {
    const stringify = vi.spyOn(JSON, 'stringify');

    await expect(store.set('ext', 'big', 'x'.repeat(MAX_MESSAGE_BYTES + 1))).rejects.toThrow(/at most 5 MB.*Nothing/);

    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });

  // One value past the limit is refused whole, with a reason the author can act on.
  it('refuses a value over the limit, and writes nothing', async () => {
    await store.set('ext', 'keep', 1);

    await expect(store.set('ext', 'big', 'x'.repeat(STORAGE_MAX_VALUE_BYTES + 1))).rejects.toThrow(/at most 5 MB.*Nothing was written/);

    expect(await store.get('ext', 'big')).toBeUndefined();
    expect(await store.get('ext', 'keep')).toBe(1);
  });

  it('refuses a key over the limit', async () => {
    await expect(store.set('ext', 'k'.repeat(STORAGE_MAX_KEY_LENGTH + 1), 1)).rejects.toThrow('a key may be at most');
  });

  // Many values each under the limit: the total is what costs on every read.
  it('refuses a write that would take the total over the limit, and keeps what is there', async () => {
    const count = Math.floor(STORAGE_MAX_TOTAL_BYTES / (4 * 1024 * 1024));
    for (let i = 0; i < count; i += 1) await store.set('ext', `k${i}`, mb(4));

    await expect(store.set('ext', 'one-more', mb(4))).rejects.toThrow(/may keep at most 25 MB.*Nothing was written/);

    expect(await store.get('ext', 'one-more')).toBeUndefined();
    expect((await store.get<string>('ext', 'k0'))?.length).toBe(4 * 1024 * 1024);
  });

  // The promise made to the user: data from before there was a limit is still theirs.
  it('leaves data already over the limit readable and untouched', async () => {
    mkdirSync(join(base, 'extension-storage', 'ext'), { recursive: true });
    const old = JSON.stringify({ old: 'x'.repeat(STORAGE_MAX_TOTAL_BYTES + 1024) });
    writeFileSync(file(), old);

    expect((await store.get<string>('ext', 'old'))?.length).toBe(STORAGE_MAX_TOTAL_BYTES + 1024);
    await expect(store.set('ext', 'new', 'value')).rejects.toThrow('may keep at most');

    expect(readFileSync(file(), 'utf8')).toBe(old);
  });

  // Or a store over the limit could never be brought back under it.
  it('still allows deleting, and overwriting smaller, when over the limit', async () => {
    mkdirSync(join(base, 'extension-storage', 'ext'), { recursive: true });
    writeFileSync(file(), JSON.stringify({ a: 'x'.repeat(STORAGE_MAX_TOTAL_BYTES), b: 'y'.repeat(1024) }));

    await store.set('ext', 'b', 'short');
    expect(await store.get('ext', 'b')).toBe('short');

    await store.delete('ext', 'a');
    expect(await store.get('ext', 'a')).toBeUndefined();
    await store.set('ext', 'c', 'room again');
    expect(await store.get('ext', 'c')).toBe('room again');
  });

  // A key like this is data, not a way to change the object it is written onto.
  it('keeps a __proto__ key as data', async () => {
    await store.set('ext', '__proto__', { polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')))).toContain('__proto__');
  });

  it('counts a value it cannot serialize as nothing to refuse', async () => {
    await expect(store.set('ext', 'k', undefined)).resolves.toBeUndefined();
  });
});

describe('extension settings limits', () => {
  const context = (keys: string[] = []) => {
    const update = vi.fn(async () => undefined);
    return {
      update,
      context: new ExtensionContextImpl({
        manifest: { id: 'ext', name: 'x', version: '1.0.0' } as never,
        storagePath: '/x',
        grantedPermissions: ['settings:write'],
        eventBus: createEventBus(),
        storageBackend: store,
        settingsBackend: { get: () => undefined, update, has: (_id, key) => keys.includes(key), keys: () => keys },
      }),
    };
  };

  // Settings are held in main's memory and rewritten whole on every change.
  it.each([
    ['a long key', 'k'.repeat(257), 1, 'a key may be at most'],
    ['a large value', 'k', 'x'.repeat(64 * 1024 + 1), 'a value may be at most'],
  ])('refuses %s', async (_name, key, value, message) => {
    const { context: ctx, update } = context();
    await expect(ctx.settings.update(key, value)).rejects.toThrow(message);
    expect(update).not.toHaveBeenCalled();
  });

  // The same crash as storage, through the same kind of check.
  it('refuses a value far over the limit without stringifying it', async () => {
    const { context: ctx, update } = context();
    const stringify = vi.spyOn(JSON, 'stringify');

    await expect(ctx.settings.update('k', 'x'.repeat(MAX_MESSAGE_BYTES + 1))).rejects.toThrow('a value may be at most');

    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a new key past the count, and still lets an existing one change', async () => {
    const keys = Array.from({ length: 256 }, (_v, i) => `k${i}`);
    const { context: ctx, update } = context(keys);

    await expect(ctx.settings.update('another', 1)).rejects.toThrow('at most 256 settings');
    await ctx.settings.update('k0', 1);

    expect(update).toHaveBeenCalledTimes(1);
  });
});
