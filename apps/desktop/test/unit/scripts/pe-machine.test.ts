import { describe, expect, it } from 'vitest';

import {
  certificateTableProblem,
  isPeBinary,
  locatePeSignature,
  readPeCertificateTable,
  readPeMachine,
} from '../../../../../scripts/lib/pe-machine.mjs';

import { fullPe, peBinary, winCertificate } from './helpers/synthetic-pe';

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

describe('locatePeSignature / isPeBinary', () => {
  // The shared header walk: readPeMachine and the certificate-table reader both
  // go through it, so a regression here would mis-read both.
  it('returns the PE signature offset of a PE binary', () => {
    expect(locatePeSignature(peBinary(0x8664, { peOffset: 0x100 }))).toBe(0x100);
  });

  // The release verifier finds binaries by CONTENT. A text file, a truncated
  // file or a DOS-only stub must read as "not a PE", never throw and abort the
  // walk over the whole app directory.
  it('tells PE binaries from everything else without throwing', () => {
    expect(isPeBinary(peBinary(0x8664))).toBe(true);
    expect(isPeBinary(Buffer.from('provider: github\n'))).toBe(false);
    expect(isPeBinary(Buffer.alloc(1))).toBe(false);
    const dosOnly = peBinary(0x8664, { signature: 'NE\0\0' });
    expect(isPeBinary(dosOnly)).toBe(false);
    const noMz = peBinary(0x8664);
    noMz.write('ZM', 0, 'binary');
    expect(isPeBinary(noMz)).toBe(false);
  });
});

/**
 * Guards the Authenticode certificate-table reader: the signing hook uses it
 * to leave already-signed files (Microsoft's DLLs) alone and to prove jsign
 * really signed, and the publish job uses it to refuse an unsigned installer.
 * Misreading it either way ships an unsigned file as signed, or re-signs one.
 */
describe('readPeCertificateTable', () => {
  // The app and its addons are PE32+; the NSIS installer is PE32. The two keep
  // their data directories 16 bytes apart, so reading one layout as the other
  // would report garbage for the installer.
  it('reads the certificate table of both PE32 and PE32+ files', () => {
    for (const format of ['PE32', 'PE32+'] as const) {
      const certificate = winCertificate(100);
      const file = fullPe({ format, certificate });
      expect(readPeCertificateTable(file)).toEqual({
        format,
        offset: file.length - certificate.length,
        size: certificate.length,
      });
    }
  });

  // An unsigned file has a zero entry. Reporting anything else would make the
  // hook skip a file it should sign.
  it('reports size 0 for an unsigned file', () => {
    expect(readPeCertificateTable(fullPe({ format: 'PE32' }))).toEqual({ format: 'PE32', offset: 0, size: 0 });
  });

  // Fewer than five directories means there is no certificate slot at all:
  // that is "unsigned", not "unreadable". The bytes where slot 4 WOULD be
  // belong to something else (here they hold a plausible-looking table entry),
  // and reading them as one would report an unsigned file as signed -- the
  // hook would skip it and it would ship unsigned. Changed deliberately: the
  // old version left those bytes zero, so it passed with the guard deleted.
  it('treats a header with no certificate slot as unsigned', () => {
    const noSlot = fullPe({ directoryCount: 4, table: { offset: 0x200, size: 0x48 } });
    expect(readPeCertificateTable(noSlot)).toEqual({ format: 'PE32+', offset: 0, size: 0 });
  });

  // An unknown optional-header layout (a ROM image, a corrupt file) must throw
  // rather than be read at a guessed offset.
  it('rejects an optional-header magic it does not know', () => {
    expect(() => readPeCertificateTable(fullPe({ magic: 0x107 }))).toThrow(/unknown PE optional-header magic 0x107/);
  });

  // A SizeOfOptionalHeader too small to hold directory 4 means the entry we
  // would read is really section-table bytes.
  it('rejects an optional header too short to hold the certificate entry', () => {
    expect(() => readPeCertificateTable(fullPe({ optionalHeaderSize: 100 }))).toThrow(/too short for the certificate-table entry/);
  });

  // Every truncation point must throw, never read out of bounds and return a
  // "valid" table made of zero bytes.
  it('rejects headers truncated at each step', () => {
    const file = fullPe({ format: 'PE32+', certificate: winCertificate() });
    const peOffset = 0x80;
    const cuts = [
      peOffset + 10, // inside the COFF header
      peOffset + 24, // before the optional-header magic
      peOffset + 24 + 100, // before NumberOfRvaAndSizes (PE32+ keeps it at 108)
      peOffset + 24 + 112 + 32, // before the certificate entry
    ];
    for (const cut of cuts) {
      expect(() => readPeCertificateTable(file.subarray(0, cut)), `cut at ${cut}`).toThrow(/truncated PE header/);
    }
  });

  // Not a PE binary at all: the same error readPeMachine gives.
  it('rejects a buffer that is not a PE binary', () => {
    expect(() => readPeCertificateTable(Buffer.alloc(16))).toThrow(/not a PE binary/);
  });
});

describe('certificateTableProblem', () => {
  const entryOf = (file: Buffer, table: { offset: number }) => file.subarray(table.offset, table.offset + 8);

  // The happy path: a revision-2 PKCS#7 entry at the end of the file.
  it('accepts a well-formed Authenticode table', () => {
    const file = fullPe({ certificate: winCertificate() });
    const table = readPeCertificateTable(file);
    expect(certificateTableProblem(table, file.length, entryOf(file, table))).toBeNull();
  });

  // Unsigned must say so in words the release log reader understands.
  it('reports an unsigned file as not signed', () => {
    expect(certificateTableProblem({ offset: 0, size: 0 }, 1000)).toMatch(/not signed/);
  });

  // A table pointing outside the file is a truncated download or a forged
  // header, never a signature.
  it('rejects a table that lies outside the file', () => {
    expect(certificateTableProblem({ offset: 900, size: 200 }, 1000)).toMatch(/outside the 1000-byte file/);
    expect(certificateTableProblem({ offset: 0, size: 200 }, 1000)).toMatch(/outside/);
  });

  // Each WIN_CERTIFICATE field is checked: a length that overruns the table, a
  // wrong revision, or a type that is not PKCS#7 (an X.509-only entry) is not
  // an Authenticode signature.
  it('rejects a malformed WIN_CERTIFICATE header', () => {
    const table = { offset: 100, size: 72 };
    expect(certificateTableProblem(table, 1000)).toMatch(/too short to hold a WIN_CERTIFICATE/);
    expect(certificateTableProblem(table, 1000, winCertificate(64, { length: 8 }))).toMatch(/length 8 does not fit/);
    expect(certificateTableProblem(table, 1000, winCertificate(64, { length: 500 }))).toMatch(/length 500 does not fit/);
    expect(certificateTableProblem(table, 1000, winCertificate(64, { revision: 0x100 }))).toMatch(/revision 0x100/);
    expect(certificateTableProblem(table, 1000, winCertificate(64, { type: 0x0001 }))).toMatch(/type 0x1 is not PKCS#7/);
  });
});
