import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALT_MANIFEST_FILENAME, MANIFEST_FILENAME, MAX_MANIFEST_BYTES, loadExtension } from '../../../src/extensions/extension-loader';

// An installed extension's manifest is kept in the registry's state, which is
// stringified whole on every change — and the manifest is the extension author's
// file, unpacked from an archive that can expand far past the download limit.
// Breaks if: a manifest large enough to end the app when stringified (uncatchably,
// in Electron 44, and again on every launch while it stays installed) is read and
// parsed instead of refused, or the cap starts refusing real manifests.

const manifest = {
  id: 'sized',
  name: 'Sized',
  version: '1.0.0',
  description: 'A manifest of some size',
  author: 'Sarv',
  engines: { sarvinbox: '>=1.0.0' },
  permissions: [],
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sarvinbox-manifest-size-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** An extension folder whose manifest file is padded to exactly `bytes`. */
function extensionWithManifest(file: string, bytes: number): string {
  const dir = join(root, file.replace('.', '-'));
  mkdirSync(dir, { recursive: true });
  const body = file === ALT_MANIFEST_FILENAME
    ? { name: 'sized', version: '1.0.0', sarvinboxExtension: { ...manifest, main: './index.js' } }
    : { ...manifest };
  const bare = JSON.stringify({ ...body, padding: '' });
  writeFileSync(join(dir, file), JSON.stringify({ ...body, padding: 'p'.repeat(bytes - bare.length) }));
  writeFileSync(join(dir, 'index.js'), 'exports.activate = () => {};');
  return dir;
}

describe('extension manifest size', () => {
  it.each([MANIFEST_FILENAME, ALT_MANIFEST_FILENAME])('refuses a %s over the limit without parsing it', async (file) => {
    const dir = extensionWithManifest(file, MAX_MANIFEST_BYTES + 1);
    const parse = vi.spyOn(JSON, 'parse');

    await expect(loadExtension(dir)).rejects.toThrow(`a manifest may be at most ${MAX_MANIFEST_BYTES} bytes`);

    expect(parse).not.toHaveBeenCalled();
  });

  it.each([MANIFEST_FILENAME, ALT_MANIFEST_FILENAME])('still loads a %s at the limit', async (file) => {
    const dir = extensionWithManifest(file, MAX_MANIFEST_BYTES);

    const loaded = await loadExtension(dir);

    expect(loaded.manifest.id).toBe('sized');
  });
});
