import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * When main.ts snapshots the account registry for binding saved passwords from
 * older versions (vault-credentials.ts) — a source guard, because main.ts
 * cannot be imported by a test (it starts the app). The snapshot itself is
 * tested in vault-credentials.test.ts; this pins that it is taken after the
 * registry is seeded and before any IPC handler (the window's only way to
 * write the registry) exists.
 */

const source = readFileSync(new URL('../../../electron/main.ts', import.meta.url), 'utf8');

/** The file with `//` and `/* *\/` comments removed, so prose can't match. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('main.ts legacy vault binding wiring', () => {
  // Breaks: the snapshot is taken after IPC handlers exist (a compromised
  // window's accounts:save then chooses how an unused saved password is sent),
  // before the registry is seeded (every legacy password reads as "no record"
  // and a self-signed account is bound strict), or never (legacy passwords are
  // never used and those accounts stop connecting).
  it('snapshots the registry once, after seeding it and before registering IPC handlers', () => {
    const seeded = code.indexOf('await seedAccountRegistryFromDurableStores();');
    const snapshot = code.indexOf('captureRegistryForLegacyBinding();');
    // The window writes the registry only through IPC (accounts:save), so the
    // handlers — not the window — are what must come after the snapshot.
    const handlers = code.indexOf('registerAllHandlers();');
    expect(seeded).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(seeded);
    expect(handlers).toBeGreaterThan(snapshot);
    expect(code.match(/captureRegistryForLegacyBinding\(/g)).toHaveLength(1);
  });

  // The snapshot runs in initializeAccountRegistry; this pins that startup
  // awaits it before the handlers, not just that the text comes first.
  it('initialises the account registry before registering IPC handlers', () => {
    const registry = code.indexOf('await initializeAccountRegistry();');
    expect(registry).toBeGreaterThan(-1);
    expect(code.indexOf('registerAllHandlers();', registry)).toBeGreaterThan(registry);
    expect(code.slice(0, registry)).not.toMatch(/^\s*registerAllHandlers\(\);/m);
  });
});
