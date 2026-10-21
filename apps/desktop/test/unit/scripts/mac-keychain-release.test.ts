import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../../../scripts/verify-mac-arch.mjs', import.meta.url));
const x64 = 0x01000007; const arm64 = 0x0100000c;
function machO(cpus: number[]): Buffer {
  const bytes = Buffer.alloc(8 + cpus.length * 20);
  bytes.writeUInt32BE(0xcafebabe, 0); bytes.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, index) => bytes.writeInt32BE(cpu, 8 + index * 20));
  return bytes;
}
let root: string;
let resources: string;
let helper: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inbox-mac-release-'));
  const contents = join(root, 'Sarv Inbox.app', 'Contents');
  resources = join(contents, 'Resources');
  mkdirSync(resources, { recursive: true }); mkdirSync(join(contents, 'MacOS'));
  writeFileSync(join(resources, 'app.asar'), '');
  writeFileSync(join(resources, 'better_sqlite3.node'), machO([x64, arm64]));
  helper = join(contents, 'MacOS', 'Sarv Inbox Keychain');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const run = (archs = 'x64,arm64') => spawnSync(process.execPath, [script, `${root}=${archs}`], {
  encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

describe('required macOS Keychain helper release gate', () => {
  it('accepts an app only when its helper and addon include every requested architecture', () => {
    writeFileSync(helper, machO([x64, arm64])); chmodSync(helper, 0o755);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Sarv Inbox Keychain carries x64, arm64');
  });

  it('rejects a build with working native addons but no helper', () => {
    const result = run(); expect(result.status).toBe(1);
    expect(result.stderr).toContain('Sarv Inbox Keychain is missing');
  });

  it('rejects a universal app whose helper lost one CPU slice', () => {
    writeFileSync(helper, machO([arm64]));
    const result = run(); expect(result.status).toBe(1);
    expect(result.stderr).toContain('Sarv Inbox Keychain carries arm64, missing x64');
  });

  it('accepts the matching single architecture update payload', () => {
    writeFileSync(helper, machO([arm64]));
    expect(run('arm64').status).toBe(0);
  });

  it('rejects an empty or corrupt helper', () => {
    writeFileSync(helper, 'invalid native binary');
    const result = run(); expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a Mach-O binary');
  });
});
