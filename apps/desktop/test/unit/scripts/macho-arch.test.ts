import { describe, expect, it } from 'vitest';

import { readMachOArchs } from '../../../../../scripts/lib/macho-arch.mjs';

/**
 * Guards the check that stops a half-universal macOS build shipping.
 *
 * The regression this protects against is not a crash. The macOS app is one
 * universal binary carrying x64 and arm64, merged by @electron/universal with
 * `lipo`. If that merge ever keeps only one slice, the dmg builds, signs,
 * notarizes and installs -- and then fails only for users on the missing CPU,
 * as an app with no accounts and no mail, because every core-DB read is
 * wrapped in a try/catch returning an empty result (CLAUDE.md).
 *
 * If the parser below silently mis-reads a header, the release workflow's
 * verification step passes and the protection is gone, so the parser itself is
 * tested rather than only the script that calls it.
 */

const CPU_X64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;

/** Build a fat (universal) header carrying the given CPU types. */
const fatBinary = (cpuTypes: number[], { magic = 0xcafebabe, entrySize = 20, count = cpuTypes.length } = {}): Buffer => {
  const buffer = Buffer.alloc(8 + cpuTypes.length * entrySize);
  buffer.writeUInt32BE(magic, 0);
  buffer.writeUInt32BE(count, 4);
  cpuTypes.forEach((cpuType, index) => buffer.writeInt32BE(cpuType, 8 + index * entrySize));
  return buffer;
};

/** Build a thin Mach-O header for one CPU type. */
const thinBinary = (cpuType: number, { magic = 0xcffaedfe, littleEndian = true } = {}): Buffer => {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32BE(magic, 0);
  if (littleEndian) buffer.writeInt32LE(cpuType, 4);
  else buffer.writeInt32BE(cpuType, 4);
  return buffer;
};

describe('readMachOArchs', () => {
  // The shape the release MUST have: one addon carrying both CPUs. This is
  // what `lipo -archs` prints as "x86_64 arm64".
  it('reads both slices of a universal binary', () => {
    expect(readMachOArchs(fatBinary([CPU_X64, CPU_ARM64]))).toEqual(['x64', 'arm64']);
  });

  // The failure this whole check exists for: a "universal" app whose addon is
  // really only one architecture. It must come back as one entry so the caller
  // can name the missing one, NOT as an error or a pass.
  it('reports a single-slice fat binary as exactly one architecture', () => {
    expect(readMachOArchs(fatBinary([CPU_ARM64]))).toEqual(['arm64']);
  });

  // A plain, never-merged addon -- what a broken merge leaves behind. Both
  // byte orders, because the magic is what tells you which one to read.
  it('reads a thin binary in either byte order', () => {
    expect(readMachOArchs(thinBinary(CPU_ARM64))).toEqual(['arm64']);
    expect(readMachOArchs(thinBinary(CPU_X64))).toEqual(['x64']);
    expect(readMachOArchs(thinBinary(CPU_ARM64, { magic: 0xfeedfacf, littleEndian: false }))).toEqual(['arm64']);
  });

  // The 64-bit fat format has wider entries; reading it with the 32-bit stride
  // would walk into the middle of a struct and report nonsense architectures.
  it('handles the 64-bit fat header, whose entries are wider', () => {
    expect(readMachOArchs(fatBinary([CPU_X64, CPU_ARM64], { magic: 0xcafebabf, entrySize: 32 }))).toEqual([
      'x64',
      'arm64',
    ]);
  });

  // An unrecognised CPU must NOT be silently treated as a match. Reporting the
  // raw value keeps the failure debuggable.
  it('reports an unrecognised CPU type rather than guessing', () => {
    expect(readMachOArchs(fatBinary([0x01000099]))).toEqual(['unknown (0x1000099)']);
  });

  // A corrupt or non-Mach-O file is a different failure from a missing
  // architecture and must be reported as such -- otherwise a truncated addon
  // reads as some arbitrary arch and either passes or fails for the wrong reason.
  it('rejects a file that is not a Mach-O binary', () => {
    expect(() => readMachOArchs(Buffer.alloc(4))).toThrow(/not a Mach-O binary/);
    expect(() => readMachOArchs(Buffer.alloc(32))).toThrow(/no recognised magic/);
  });

  // A slice count running past the end of the file must throw rather than read
  // out of bounds and invent architectures that are not there.
  it('rejects a fat header whose slice table does not fit', () => {
    expect(() => readMachOArchs(fatBinary([CPU_X64], { count: 8 }))).toThrow(/fat header needs/);
    expect(() => readMachOArchs(fatBinary([CPU_X64], { count: 0 }))).toThrow(/claims 0 architectures/);
    expect(() => readMachOArchs(fatBinary([CPU_X64], { count: 999 }))).toThrow(/claims 999 architectures/);
  });
});
