import { describe, expect, it, vi } from 'vitest';

/**
 * The boot guard that refuses to start on an unloadable better-sqlite3.
 *
 * What breaks if this file fails: the app starts anyway. Every core-DB read
 * absorbs the load failure into an empty result, so it comes up as onboarding —
 * no accounts, no folders, no mail — and invites the user to re-add an account
 * on top of data that is still on disk. That reading is what let a startup
 * sweep delete two live mailbox databases.
 */

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));

import {
  ABI_FAILURE_TITLE,
  abiFailureReport,
  ensureNativeSqliteLoadable,
} from '../../../../electron/services/native-abi-guard';

const mismatch = new Error(
  "The module '/x/better_sqlite3.node' was compiled against a different Node.js version " +
    'using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 148.',
);

/** A guard wired to spies, so nothing quits the test runner. */
const harness = (probeResult: { ok: true } | { ok: false; cause: unknown }) => {
  const showErrorBox = vi.fn();
  const quit = vi.fn();
  const logs: string[] = [];
  const ok = ensureNativeSqliteLoadable({
    probe: () => probeResult,
    showErrorBox,
    quit,
    log: (message) => logs.push(message),
  });
  return { ok, showErrorBox, quit, logs };
};

describe('abiFailureReport', () => {
  // Breaks: the reader is told something is wrong but not which way round the
  // mismatch runs, and the two directions have different fixes.
  it('names both ABIs', () => {
    expect(abiFailureReport(mismatch)).toContain(
      'better-sqlite3 is compiled for ABI 137, but this process requires ABI 148.',
    );
  });

  // THE point of the message. This failure is indistinguishable from data loss
  // from the outside, and someone who believes their mail is gone does
  // destructive things to get it back.
  it('says nothing was deleted', () => {
    expect(abiFailureReport(mismatch)).toMatch(/Nothing has\nbeen read, written or deleted/);
  });

  // Breaks: the message is a dead end — actionable without reading any source
  // is the whole reason it exists.
  it('names the command that fixes it', () => {
    expect(abiFailureReport(mismatch)).toContain('node scripts/native-abi.mjs electron');
  });

  // Breaks: nothing is left to confirm the diagnosis against when the parse was
  // wrong or the failure was something else entirely.
  it('keeps the underlying load error', () => {
    expect(abiFailureReport(new Error('ERR_DLOPEN_FAILED: wrong ELF class'))).toContain(
      'ERR_DLOPEN_FAILED: wrong ELF class',
    );
  });

  // Breaks: the formatter throws on a path that is already failing, and the
  // user gets no message at all.
  it.each([
    ['a thrown string', 'plain string'],
    ['null', null],
    ['undefined', undefined],
  ])('survives %s as the cause', (_case, cause) => {
    expect(() => abiFailureReport(cause)).not.toThrow();
  });
});

describe('ensureNativeSqliteLoadable', () => {
  // Breaks: every ordinary boot is stopped by the guard meant to catch a broken
  // one — the worst possible false positive.
  it('lets a working binding through, silently', () => {
    const { ok, showErrorBox, quit, logs } = harness({ ok: true });

    expect(ok).toBe(true);
    expect(showErrorBox).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  // THE REGRESSION: booting on an unloadable addon is what impersonates a fresh
  // install. The guard must stop the boot, not merely mention the problem.
  it('reports and quits on a failure, and tells the caller to stop', () => {
    const { ok, showErrorBox, quit, logs } = harness({ ok: false, cause: mismatch });

    expect(ok).toBe(false);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(showErrorBox).toHaveBeenCalledWith(ABI_FAILURE_TITLE, expect.stringContaining('ABI 137'));
    // Logged as well as shown: a dialog the user dismisses leaves nothing to
    // diagnose from, and a headless or auto-started run never sees one.
    expect(logs.join('\n')).toContain('ABI 137');
    expect(logs.join('\n')).toContain(ABI_FAILURE_TITLE);
  });

  // Breaks on Linux with no display server: a dialog that throws takes the
  // guard down before it quits, and the app hangs half-initialised instead.
  it('still quits when the dialog cannot be shown', () => {
    const quit = vi.fn();
    const logs: string[] = [];

    const ok = ensureNativeSqliteLoadable({
      probe: () => ({ ok: false, cause: mismatch }),
      showErrorBox: () => { throw new Error('no display'); },
      quit,
      log: (message) => logs.push(message),
    });

    expect(ok).toBe(false);
    expect(quit).toHaveBeenCalledTimes(1);
    // The failure to report is itself reported — otherwise it looks like the
    // guard never ran.
    expect(logs.join('\n')).toContain('no display');
  });

  // Breaks: the guard probes something other than the addon the app opens its
  // databases with, and proves nothing about the running process.
  it('probes the real addon when no probe is injected', () => {
    expect(ensureNativeSqliteLoadable({ quit: vi.fn(), showErrorBox: vi.fn(), log: vi.fn() })).toBe(true);
  });
});
