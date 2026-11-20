import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * main.ts's shutdown line for attachment previews that could not be cleared —
 * a source guard, because main.ts cannot be imported by a test (it starts the
 * app). dispose() rejects with the filesystem error when a private copy cannot
 * be removed (attachment-preview-protection-log.test.ts), and Node's message
 * for that quotes the copy's path, which ends in the attachment's name.
 *
 * What breaks if this file fails: the shutdown line logs that error whole, and
 * an attachment's file name (with the Windows profile folder) reaches app.log.
 */

const source = readFileSync(new URL('../../../electron/main.ts', import.meta.url), 'utf8');

describe('main.ts attachment-preview shutdown log', () => {
  it('logs a failed preview cleanup on shutdown through errorDiagnostic', () => {
    const lines = source.split('\n').filter((line) => line.includes('Could not clear attachment previews on shutdown'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/logger\.warn\('Could not clear attachment previews on shutdown:', errorDiagnostic\(error\)\);/);
  });
});
