import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseExtensionsConfig } from '@sarvinbox/core';
import { c as createTar, x as extractTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAllowedArchiveEntry, isSeedableId, seedPaths } from '../../../scripts/extension-seed.mjs';

/**
 * What the build may write when it seeds the default extensions into
 * build/default-extensions/ — the folder electron-builder copies into every
 * shipped app. The archive's bytes are already checked against the registry's
 * pinned SHA-256 before anything is written; these are the other two locks:
 * where a seed lands, and what an archive may put there.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'extension-seed-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('isSeedableId', () => {
  // Breaks: the build seeds (or refuses) an id the app itself would treat
  // differently, so a default either ships under a folder the app never looks
  // in, or a malformed id reaches the filesystem.
  it.each(['otp-code', 'vip-scoring', 'a', '0-x', 'a'.repeat(63), 'a'.repeat(64), '../x', 'a/b', 'A', '-x', '', ' otp', '..', '.'])(
    'agrees with the app on %j',
    (id) => {
      const app = parseExtensionsConfig({ systemExtensions: [id] }).systemExtensions.includes(id);
      expect(isSeedableId(id)).toBe(app);
    },
  );

  // Breaks: a non-string id from a malformed config is coerced into a folder name.
  it('refuses anything that is not a string', () => {
    for (const id of [undefined, null, 7, ['otp-code'], { id: 'otp-code' }]) expect(isSeedableId(id)).toBe(false);
  });
});

describe('seedPaths', () => {
  // Breaks: a registry or config id is no longer checked before it is joined
  // onto the output folder, and the build writes (and first deletes, with
  // rm -rf) a folder outside it.
  it.each(['../escape', '../../etc', 'a/../../b', '/abs', 'C:\\abs', 'a\\b', '..', ''])('refuses %j', (id) => {
    expect(() => seedPaths(dir, id)).toThrow(/not a valid extension id/);
  });

  // Breaks: real defaults stop being seeded at all.
  it('places a valid id directly inside the output folder', () => {
    const { target, archivePath } = seedPaths(dir, 'otp-code');
    expect(target).toBe(join(dir, 'otp-code'));
    expect(archivePath).toBe(join(dir, 'otp-code.tgz'));
    expect(resolve(target, '..')).toBe(resolve(dir));
  });
});

describe('isAllowedArchiveEntry', () => {
  const unpack = async (archive: string) => {
    const out = join(dir, 'out');
    mkdirSync(out);
    await extractTar({ file: archive, cwd: out, filter: isAllowedArchiveEntry });
    return out;
  };

  // Breaks: the seed stops unpacking the files the app loads.
  it('unpacks the allowlisted files of a well-formed archive and nothing else', async () => {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'dist'), { recursive: true });
    writeFileSync(join(src, 'sarvinbox-extension.json'), '{"id":"otp-code"}');
    writeFileSync(join(src, 'dist', 'main.js'), 'export {}');
    writeFileSync(join(src, 'secrets.env'), 'TOKEN=1');
    const archive = join(dir, 'a.tgz');
    await createTar({ gzip: true, file: archive, cwd: src }, ['.']);

    const out = await unpack(archive);

    expect(readFileSync(join(out, 'sarvinbox-extension.json'), 'utf8')).toBe('{"id":"otp-code"}');
    expect(readFileSync(join(out, 'dist', 'main.js'), 'utf8')).toBe('export {}');
    expect(existsSync(join(out, 'secrets.env'))).toBe(false);
  });

  // Breaks: an archive carrying a symbolic or hard link under an allowed name
  // ships a pointer to another file of the build machine (a CI credential, a
  // signing config) inside the app's default-extensions folder.
  it.skipIf(process.platform === 'win32')('refuses symbolic and hard links even under allowed names', async () => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'build machine secret');
    const src = join(dir, 'src');
    mkdirSync(join(src, 'dist'), { recursive: true });
    writeFileSync(join(src, 'sarvinbox-extension.json'), '{"id":"otp-code"}');
    symlinkSync(outside, join(src, 'dist', 'main.js'));
    symlinkSync(outside, join(src, 'README.md'));
    // tar stores the first name of a hard-linked file as a File and every
    // later name as a Link entry pointing at it.
    writeFileSync(join(src, 'dist', 'a.js'), 'export {}');
    linkSync(join(src, 'dist', 'a.js'), join(src, 'dist', 'z.js'));
    const archive = join(dir, 'links.tgz');
    await createTar({ gzip: true, file: archive, cwd: src }, ['.']);

    const out = await unpack(archive);

    expect(readFileSync(join(out, 'sarvinbox-extension.json'), 'utf8')).toBe('{"id":"otp-code"}');
    expect(readFileSync(join(out, 'dist', 'a.js'), 'utf8')).toBe('export {}');
    for (const name of ['dist/main.js', 'README.md', 'dist/z.js']) {
      expect(() => lstatSync(join(out, name)), name).toThrow();
    }
  });

  // Breaks: the archive root, or a Windows-separated path, is judged by name
  // alone, or an entry with no type at all is unpacked.
  it('accepts the archive root only as a folder', () => {
    expect(isAllowedArchiveEntry('./', { type: 'Directory' })).toBe(true);
    expect(isAllowedArchiveEntry('.', { type: 'SymbolicLink' })).toBe(false);
    expect(isAllowedArchiveEntry('dist\\main.js', { type: 'File' })).toBe(true);
    expect(isAllowedArchiveEntry('dist/main.js', null)).toBe(false);
  });
});
