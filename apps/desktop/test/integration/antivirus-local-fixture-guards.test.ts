import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localScannerFixture } from './antivirus-local-fixture';

const credential = 'iv_' + 'A'.repeat(43);
const origin = 'http://127.0.0.1:28080';

describe('local scanner integration credential guards', () => {
  let directory: string;
  const requestFetch = vi.fn<typeof fetch>();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'inbox-av-fixture-guards-'));
    requestFetch.mockReset();
    vi.stubGlobal('fetch', requestFetch);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it('requires explicit synthetic opt-in', async () => {
    await expect(localScannerFixture({ INBOX_AV_SCAN_KEY: credential })).rejects.toThrow('explicitly');
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it.each(['https://av.sarv.com', 'http://example.invalid', origin + '/path', origin + '?token=value'])
    ('rejects nonlocal or non-origin scanner URL %s', async url => {
      await expect(localScannerFixture({ INBOX_AV_SYNTHETIC: '1', INBOX_AV_TEST_ORIGIN: url, INBOX_AV_SCAN_KEY: credential }))
        .rejects.toThrow('local HTTP origin');
      expect(requestFetch).not.toHaveBeenCalled();
    });

  it('rejects multiple credential sources before reading or sending either', async () => {
    await expect(localScannerFixture({ INBOX_AV_SYNTHETIC: '1', INBOX_AV_SCAN_KEY: credential,
      INBOX_AV_SCAN_KEY_FILE: join(directory, 'not-created') })).rejects.toThrow('exactly one');
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('rejects public credential files', async () => {
    const path = join(directory, 'public-key');
    await writeFile(path, credential, { mode: 0o644 });
    await expect(localScannerFixture({ INBOX_AV_SYNTHETIC: '1', INBOX_AV_SCAN_KEY_FILE: path })).rejects.toThrow('private files');
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('rejects symbolic-link credential files', async () => {
    const target = join(directory, 'private-key');
    const link = join(directory, 'key-link');
    await writeFile(target, credential, { mode: 0o600 });
    await symlink(target, link);
    await expect(localScannerFixture({ INBOX_AV_SYNTHETIC: '1', INBOX_AV_SCAN_KEY_FILE: link })).rejects.toThrow();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('refuses a supplied key associated with a real user before uploading', async () => {
    requestFetch.mockResolvedValueOnce(Response.json({ email: 'person@example.com' }));
    await expect(localScannerFixture({ INBOX_AV_SYNTHETIC: '1', INBOX_AV_TEST_ORIGIN: origin, INBOX_AV_SCAN_KEY: credential }))
      .rejects.toThrow('real user');
    expect(requestFetch).toHaveBeenCalledTimes(1);
    expect(requestFetch.mock.calls[0][0]).toBe(origin + '/api/v1/users/me');
  });

  it('accepts a privately supplied synthetic key without creating another one', async () => {
    const path = join(directory, 'private-key');
    await writeFile(path, credential + '\n', { mode: 0o600 });
    requestFetch.mockResolvedValueOnce(Response.json({ email: 'fixture@example.invalid' }));
    const fixture = await localScannerFixture({ INBOX_AV_SYNTHETIC: '1', INBOX_AV_TEST_ORIGIN: origin, INBOX_AV_SCAN_KEY_FILE: path });
    expect(fixture.origin).toBe(origin);
    expect(fixture.credential === credential).toBe(true);
    await fixture.cleanup();
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an unmarked token file before authenticating or creating a key', async () => {
    const path = join(directory, 'unmarked-tokens.json');
    await writeFile(path, JSON.stringify({ issuer: 'https://oauth.sarv.com', scanner: 'untrusted' }), { mode: 0o600 });
    await expect(localScannerFixture({ INBOX_AV_SYNTHETIC: '1', INBOX_AV_SYNTHETIC_TOKENS_FILE: path })).rejects.toThrow('isolated CI');
    expect(requestFetch).not.toHaveBeenCalled();
  });
});
