import { readFileSync } from 'node:fs';

import { AUTO_SELECT_FAMILY_ATTEMPT_MS } from '@sarvinbox/core';
import { describe, expect, it } from 'vitest';


/**
 * Where the per-address connect window is raised in `main.ts` — a source-order
 * guard, for the same reason as the scheme-registration one next door: the
 * effect is process-wide state set before anything connects, and no runtime
 * assertion inside a test can observe the real main process doing it.
 *
 * What breaks without it: Node keeps its 250ms per-address default, and every
 * host with both an A and an AAAA record fails `ETIMEDOUT` on a machine with no
 * working IPv6 whenever the handshake needs longer than that. Observed on
 * 2026-09-25 as a Gmail account that could not refresh its OAuth token for
 * hours ("Cannot reach OAuth server [ETIMEDOUT]") while `curl` to the same URL
 * answered in under a second.
 */

const source = readFileSync(new URL('../../../../electron/main.ts', import.meta.url), 'utf8');

/** The file with `//` and block comments removed, so prose cannot match. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('main.ts connect-window bootstrap', () => {
  it('raises the window through the shared helper, not a hand-rolled call', () => {
    expect(code).toContain('raiseAutoSelectFamilyAttemptTimeout');
    // Reads and writes the real process-wide default rather than a copy.
    expect(code).toContain('getDefaultAutoSelectFamilyAttemptTimeout()');
    expect(code).toContain('setDefaultAutoSelectFamilyAttemptTimeout(');
  });

  // Anything that connects before this line still races addresses at 250ms.
  it('raises it at module scope, before app.whenReady()', () => {
    const raiseAt = code.indexOf('raiseAutoSelectFamilyAttemptTimeout({');
    const readyAt = code.indexOf('whenReady()');

    expect(raiseAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(raiseAt).toBeLessThan(readyAt);
  });

  // The window the main process gets is the shared constant, so raising it in
  // one place raises it for IMAP/SMTP and OAuth alike.
  it('uses the shared default window', () => {
    expect(AUTO_SELECT_FAMILY_ATTEMPT_MS).toBe(2000);
    // The call site passes controls only — no second argument overriding the
    // shared window with a number of its own.
    const call = code.slice(code.indexOf('raiseAutoSelectFamilyAttemptTimeout({'));
    expect(call.slice(0, call.indexOf(');') + 2)).toMatch(/\}\);$/);
  });
});
