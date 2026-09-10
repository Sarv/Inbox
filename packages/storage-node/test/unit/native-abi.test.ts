/*
 * Guards packages/storage-node/src/native-abi.ts — the probe that turns a
 * lazily-dlopened, silently-swallowed native module failure into a named one.
 *
 * What breaks if this file fails: the app boots on an unloadable better-sqlite3
 * and reports it as "you have no accounts". That is the exact reading that made
 * a startup sweep delete two live mailbox databases; the probe below is what
 * stops the next boot from getting there.
 */

import { describe, expect, it } from 'vitest';

import {
  describeNativeAbiFailure,
  parseAbiMismatch,
  probeNativeSqlite,
} from '../../src/native-abi';
import { probeBundledSqlite } from '../../src/native-abi-probe';

/** The real message Node raises, verbatim in shape. */
const mismatchMessage = (built: string, required: string) =>
  `The module '/x/better_sqlite3.node' was compiled against a different Node.js ` +
  `version using NODE_MODULE_VERSION ${built}. This version of Node.js requires ` +
  `NODE_MODULE_VERSION ${required}. Please try re-compiling or re-installing the module.`;

describe('parseAbiMismatch', () => {
  // Breaks: the diagnostic cannot say WHICH way the mismatch runs, so a reader
  // cannot tell "built for Node, needs Electron" from its opposite — and the
  // two have different fixes.
  it('reads the built ABI first and the required one second', () => {
    expect(parseAbiMismatch(new Error(mismatchMessage('137', '148')))).toEqual({
      builtAbi: '137',
      requiredAbi: '148',
    });
  });

  // Breaks: a message naming only the built ABI (a truncated or wrapped error)
  // is reported as "not an ABI problem" and the reader is sent hunting.
  it('falls back to the running ABI when only one number is named', () => {
    expect(
      parseAbiMismatch(new Error('was compiled using NODE_MODULE_VERSION 137.'), '148'),
    ).toEqual({ builtAbi: '137', requiredAbi: '148' });
  });

  // Breaks: the guard claims an ABI mismatch for a corrupt build, a missing
  // file or a permissions error, and the printed fix does not fix anything.
  it.each([
    ['a missing addon', new Error("Cannot find module 'better_sqlite3.node'")],
    ['a truncated binary', new Error('ERR_DLOPEN_FAILED: file too short')],
    ['an empty message', new Error('')],
  ])('returns null for %s', (_case, cause) => {
    expect(parseAbiMismatch(cause)).toBeNull();
  });

  // Breaks: this runs on a path that is ALREADY failing — a thrown string or a
  // null must not make the reporter itself throw and swallow the diagnosis.
  it.each([
    ['a thrown string with the numbers', mismatchMessage('137', '148'), { builtAbi: '137', requiredAbi: '148' }],
    ['a thrown string without them', 'something else went wrong', null],
    ['null', null, null],
    ['undefined', undefined, null],
    ['an object', { code: 'ERR_DLOPEN_FAILED' }, null],
  ])('survives %s', (_case, cause, expected) => {
    expect(parseAbiMismatch(cause)).toEqual(expected);
  });

  // Breaks: the default hides a test's injected ABI, and the fallback branch
  // can never be exercised against a known value.
  it('defaults the required ABI to this process', () => {
    expect(parseAbiMismatch(new Error('NODE_MODULE_VERSION 137.'))).toEqual({
      builtAbi: '137',
      requiredAbi: process.versions.modules,
    });
  });
});

describe('describeNativeAbiFailure', () => {
  // Breaks: the headline stops naming both numbers, and the one line a reader
  // is guaranteed to see stops being actionable.
  it('names both ABIs when they are known', () => {
    expect(describeNativeAbiFailure(new Error(mismatchMessage('137', '148')))).toBe(
      'better-sqlite3 is compiled for ABI 137, but this process requires ABI 148.',
    );
  });

  // Breaks: a non-ABI failure is described as an ABI mismatch — a confident,
  // wrong diagnosis is worse than a vague, right one.
  it('stays vague when the failure is not an ABI mismatch', () => {
    expect(describeNativeAbiFailure(new Error('file too short'))).toBe(
      'better-sqlite3 could not be loaded.',
    );
  });
});

describe('probeNativeSqlite', () => {
  // THE REGRESSION: better-sqlite3 dlopens on the first open, not on import, so
  // a probe that does not actually open a database proves nothing.
  it('opens and closes the database it was given', () => {
    let closed = false;
    let opened = 0;

    const probe = probeNativeSqlite(() => {
      opened += 1;
      return { close: () => { closed = true; } };
    });

    expect(probe).toEqual({ ok: true });
    expect(opened).toBe(1);
    expect(closed).toBe(true);
  });

  // Breaks: the load failure escapes the probe and takes down the boot path it
  // was added to protect — before it has had a chance to report anything.
  it('captures a failure to open instead of throwing', () => {
    const cause = new Error(mismatchMessage('137', '148'));

    const probe = probeNativeSqlite(() => { throw cause; });

    expect(probe).toEqual({ ok: false, cause });
  });

  // Breaks: a binding that loads but cannot be closed leaks a handle on every
  // boot AND is reported as broken, which quits a perfectly good app.
  it('reports a failing close as a failure rather than swallowing it', () => {
    const cause = new Error('close blew up');

    const probe = probeNativeSqlite(() => ({ close: () => { throw cause; } }));

    expect(probe).toEqual({ ok: false, cause });
  });

  // Breaks: the app's boot guard tests a stand-in rather than the addon it
  // actually ships with, and proves nothing about the running process.
  it('loads the real addon through probeBundledSqlite', () => {
    expect(probeBundledSqlite()).toEqual({ ok: true });
  });
});
