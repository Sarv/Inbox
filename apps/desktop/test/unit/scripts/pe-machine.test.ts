import { describe, expect, it } from 'vitest';

import { readPeMachine } from '../../../../../scripts/lib/pe-machine.mjs';

/**
 * Guards the check that stops an arm64 Windows build shipping an x64 native
 * addon.
 *
 * The regression this protects against is not a crash. better-sqlite3 is
 * cross-compiled for arm64 on an x64 runner; if that cross-compile falls back
 * to the host CPU, the build stays green and the installer is produced, but on
 * a real arm64 machine Electron cannot load the addon. Every core-DB read is
 * wrapped in a try/catch returning an empty result, so the user sees an app
 * with no accounts and no mail rather than an error -- the same shape as the
 * 2026-09-09 data loss described in CLAUDE.md.
 *
 * If the parser below silently mis-reads a header, the release workflow's
 * verification step passes and the protection is gone, so the parser itself is
 * tested rather than only the script that calls it.
 */

/**
 * Build the smallest byte sequence that is a valid PE header: a DOS stub whose
 * 0x3C pointer leads to "PE\0\0" followed by the COFF machine type.
 */
const peBinary = (machine: number, { signature = 'PE\0\0', peOffset = 0x80 } = {}): Buffer => {
  const buffer = Buffer.alloc(peOffset + 8);
  buffer.write('MZ', 0, 'binary');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write(signature, peOffset, 'binary');
  buffer.writeUInt16LE(machine, peOffset + 4);
  return buffer;
};

describe('readPeMachine', () => {
  // The two architectures the Windows installer actually carries. Getting
  // either wrong is the whole point of the check.
  it('reads the architectures the Windows release ships', () => {
    expect(readPeMachine(peBinary(0x8664))).toBe('x64');
    expect(readPeMachine(peBinary(0xaa64))).toBe('arm64');
  });

  // Not shipped today, but a build misconfigured to target 32-bit must be
  // named, not reported as unknown -- "ia32" tells you what went wrong.
  it('names the 32-bit architectures too', () => {
    expect(readPeMachine(peBinary(0x014c))).toBe('ia32');
    expect(readPeMachine(peBinary(0x01c0))).toBe('arm');
  });

  // An unrecognised machine type must NOT be silently treated as a match.
  // Reporting the raw code keeps the failure debuggable.
  it('reports an unrecognised machine type rather than guessing', () => {
    expect(readPeMachine(peBinary(0x5032))).toBe('unknown (0x5032)');
  });

  // A corrupt or non-PE file is a different failure from a wrong architecture
  // and must be reported as such -- otherwise a truncated addon reads as some
  // arbitrary arch and either passes or fails for the wrong reason.
  it('rejects a file that is not a PE binary', () => {
    expect(() => readPeMachine(Buffer.alloc(8))).toThrow(/not a PE binary/);
    expect(() => readPeMachine(peBinary(0x8664, { signature: 'NE\0\0' }))).toThrow(/no PE signature/);
  });

  // A header pointer running past the end of the file must throw rather than
  // read out of bounds and return garbage.
  it('rejects a PE offset that points past the end of the file', () => {
    const truncated = Buffer.alloc(0x40);
    truncated.write('MZ', 0, 'binary');
    truncated.writeUInt32LE(0xffff, 0x3c);
    expect(() => readPeMachine(truncated)).toThrow(/past the end of the file/);
  });
});
