/**
 * What an extension's `context.storage` leaves on disk. This is the user's data: a write
 * must replace the store whole or not at all, never treat a store it could not read as
 * an empty one, and never leave it readable by other accounts on the computer.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExtensionStorageBackend } from '../../../src/extensions/extension-api';
import { ExtensionManager } from '../../../src/extensions/extension-manager';

const posixOnly = process.platform === 'win32' ? it.skip : it;

let base: string;
let store: ExtensionStorageBackend;
const folder = () => join(base, 'extension-storage', 'ext');
const file = () => join(folder(), 'storage.json');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sarv-storage-file-'));
  const manager = new ExtensionManager({ extensionsBaseDir: base });
  store = (manager as unknown as { host: { storageBackend: ExtensionStorageBackend } }).host.storageBackend;
});

afterEach(() => {
  if (existsSync(file())) chmodSync(file(), 0o600);
  rmSync(base, { recursive: true, force: true });
});

describe('extension storage on disk', () => {
  // Breaks: a set, delete or clear leaves its temporary file beside the store.
  it('keeps one file, whatever is written to it', async () => {
    await store.set('ext', 'a', 1);
    await store.set('ext', 'b', 2);
    await store.delete('ext', 'a');

    expect(readdirSync(folder())).toEqual(['storage.json']);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ b: 2 });

    await store.clear('ext');

    expect(readdirSync(folder())).toEqual(['storage.json']);
    expect(await store.keys('ext')).toEqual([]);
  });

  // Breaks: what an extension keeps is readable by every account on the computer.
  posixOnly('writes the store readable by this user only', async () => {
    await store.set('ext', 'token', 'private');

    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  // Breaks: an extension that has stored nothing gets a store created by a read, a
  // delete or a clear, or reads an error.
  it('reads a store that does not exist as empty, and creates nothing for it', async () => {
    expect(await store.get('ext', 'k')).toBeUndefined();
    expect(await store.keys('ext')).toEqual([]);
    await store.delete('ext', 'k');
    await store.clear('ext');

    expect(existsSync(file())).toBe(false);
  });

  // Breaks: a store that cannot be read is taken for an empty one, and the next write
  // replaces everything in it with one key. Unreadable and empty are opposite facts.
  posixOnly('never overwrites a store it could not read', async () => {
    mkdirSync(folder(), { recursive: true });
    writeFileSync(file(), JSON.stringify({ kept: true }));
    chmodSync(file(), 0o000);

    await store.set('ext', 'new', 1);
    await store.delete('ext', 'kept');

    chmodSync(file(), 0o600);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ kept: true });
  });

  // Breaks: a damaged store is overwritten by a set, losing whatever could be recovered.
  it('leaves a damaged store alone on set and delete, and empties it only on clear', async () => {
    mkdirSync(folder(), { recursive: true });
    writeFileSync(file(), '{ not json');

    await store.set('ext', 'k', 1);
    await store.delete('ext', 'k');
    expect(readFileSync(file(), 'utf8')).toBe('{ not json');
    expect(await store.get('ext', 'k')).toBeUndefined();

    await store.clear('ext');
    expect(readFileSync(file(), 'utf8')).toBe('{}');
  });
});
