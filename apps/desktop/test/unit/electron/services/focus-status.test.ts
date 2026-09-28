import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  focusAssertionsPath,
  systemFocusStatusDeps,
  parseFocusAssertions,
  readFocusStatus,
  type FocusStatusDeps,
} from '../../../../electron/services/focus-status';

// macOS Focus / Do Not Disturb swallows banners while the app's show() still
// succeeds. This reader is what lets "Test notification" say so instead of
// claiming success. The shapes below are what macOS actually writes.

const ACTIVE = JSON.stringify({
  data: [{
    storeInvalidationRequestRecords: [{ invalidationRequestReason: 'user-changed-state' }],
    storeAssertionRecords: [{
      assertionUUID: 'B5948186',
      assertionDetails: { assertionDetailsModeIdentifier: 'com.apple.donotdisturb.mode.default' },
    }],
  }],
  header: { version: 8 },
});
const CLEARED = JSON.stringify({ data: [{ storeInvalidationRequestRecords: [{}] }], header: { version: 8 } });

describe('parseFocusAssertions', () => {
  // Breaks: the exact case that hid notifications for weeks is reported as fine.
  it('reads an active assertion as on', () => {
    expect(parseFocusAssertions(ACTIVE)).toBe('on');
  });

  // Breaks: every user who once toggled Focus is told it is still on.
  it('reads a file with no active assertions as off', () => {
    expect(parseFocusAssertions(CLEARED)).toBe('off');
    expect(parseFocusAssertions(JSON.stringify({ data: [{ storeAssertionRecords: [] }] }))).toBe('off');
    expect(parseFocusAssertions(JSON.stringify({ data: [] }))).toBe('off');
  });

  // Breaks: a format change in a future macOS silently reads as "Focus off".
  it('reads anything it does not recognise as unknown, never off', () => {
    expect(parseFocusAssertions('not json')).toBe('unknown');
    expect(parseFocusAssertions('null')).toBe('unknown');
    expect(parseFocusAssertions(JSON.stringify({ records: [] }))).toBe('unknown');
    expect(parseFocusAssertions(JSON.stringify({ data: 'x' }))).toBe('unknown');
  });

  // Breaks: one malformed entry throws instead of being skipped.
  it('tolerates null and malformed entries alongside a real one', () => {
    expect(parseFocusAssertions(JSON.stringify({ data: [null, { storeAssertionRecords: 'x' }] }))).toBe('off');
    expect(parseFocusAssertions(JSON.stringify({ data: [null, { storeAssertionRecords: [{}] }] }))).toBe('on');
  });
});

describe('readFocusStatus', () => {
  const deps = (over: Partial<FocusStatusDeps> = {}): FocusStatusDeps & { reads: string[] } => {
    const reads: string[] = [];
    return {
      platform: 'darwin',
      homeDir: '/Users/someone',
      readFile: async (filePath) => { reads.push(filePath); return ACTIVE; },
      ...over,
      reads,
    };
  };

  // Breaks: the check looks in the wrong place and always reports off.
  it('reads the Assertions.json under the home directory', async () => {
    const d = deps();
    await expect(readFocusStatus(d)).resolves.toBe('on');
    expect(d.reads).toEqual([focusAssertionsPath('/Users/someone')]);
    expect(focusAssertionsPath('/Users/someone')).toMatch(/Library.DoNotDisturb.DB.Assertions\.json$/);
  });

  // Breaks: Windows/Linux read a macOS path, or claim Focus is off there.
  it('is unknown off macOS and never touches the disk', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const d = deps({ platform });
      await expect(readFocusStatus(d)).resolves.toBe('unknown');
      expect(d.reads).toHaveLength(0);
    }
  });

  // Breaks: a Mac that never used Focus shows an alarming "unknown".
  it('treats a missing file as off', async () => {
    const readFile = async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    await expect(readFocusStatus(deps({ readFile }))).resolves.toBe('off');
  });

  // Breaks: privacy settings blocking the read are reported as "Focus off",
  // or throw into the Test button.
  it('treats any other read failure as unknown and never throws', async () => {
    const eperm = async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    const bare = async () => { throw null; };
    await expect(readFocusStatus(deps({ readFile: eperm }))).resolves.toBe('unknown');
    await expect(readFocusStatus(deps({ readFile: bare }))).resolves.toBe('unknown');
  });
});

describe('systemFocusStatusDeps', () => {
  // Breaks: the real-OS wiring reads the wrong file or the wrong encoding.
  it('reads the real Assertions.json as UTF-8 for the current platform', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'focus-status-'));
    try {
      const file = focusAssertionsPath(home);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, ACTIVE);
      const deps = systemFocusStatusDeps(home);
      expect(deps.platform).toBe(process.platform);
      expect(deps.homeDir).toBe(home);
      await expect(deps.readFile(file)).resolves.toBe(ACTIVE);
      await expect(readFocusStatus({ ...deps, platform: 'darwin' })).resolves.toBe('on');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
