import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * How main.ts wires the attachment store into startup (CASA M-7) — a source
 * guard, because main.ts cannot be imported by a test (it starts the app). The
 * functions it calls are tested on their own (attachment-cache-store,
 * attachment-cache-legacy); this pins that startup calls them with the SAFE
 * inputs: the throwing registry read, the default stale guard, and never a
 * wipe-everything.
 */

const source = readFileSync(new URL('../../../electron/main.ts', import.meta.url), 'utf8');

/** The file with `//` and `/* *\/` comments removed, so prose can't match. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('main.ts attachment-store startup wiring', () => {
  // Breaks (data loss): the startup attachment sweep takes its keep-set from a
  // read that swallows errors, or runs outside the try that aborts on an
  // unreadable registry — the failure that once deleted both live mailbox DBs.
  // Also breaks if it turns the one-hour stale guard off at startup.
  it('sweeps orphaned attachment folders with the DB sweep\'s keep-set, inside its guard', () => {
    const start = code.indexOf('const keepAccountIds = readRegistryAccounts().map((a) => a.id);');
    const end = code.indexOf('Orphaned DB cleanup SKIPPED');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const guarded = code.slice(start, end);

    expect(guarded).toContain('cleanupOrphanedAttachmentStores(keepAccountIds)');
    expect(code.match(/cleanupOrphanedAttachmentStores\(/g)).toHaveLength(1);
  });

  // Breaks (data loss): startup removes every cached attachment — something
  // only a deliberate removal of the last account may do.
  it('never removes the whole cache at startup', () => {
    expect(code).not.toContain('removeAllCachedAttachments');
  });

  // Breaks: the legacy plaintext cache is never retired (CASA M-7), or the
  // migration runs before the account registry is known and finds no owners.
  it('retires the legacy plaintext cache after the account registry is initialised', () => {
    const registry = code.indexOf('await initializeAccountRegistry();');
    const migration = code.indexOf('migrateLegacyAttachmentCache()');
    expect(registry).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(registry);
    expect(code.match(/migrateLegacyAttachmentCache\(/g)).toHaveLength(1);
  });
});
