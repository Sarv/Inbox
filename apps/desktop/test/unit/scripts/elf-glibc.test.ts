import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compareVersions,
  findElfFiles,
  formatVersion,
  glibcVersionsInStringTable,
  highestVersion,
  isElfHeader,
  parseVersion,
  readGlibcRequirement,
} from '../../../../../scripts/lib/elf-glibc.mjs';

/**
 * Guards the check that stops a Linux build shipping binaries linked against a
 * newer glibc than the oldest distribution we support.
 *
 * The regression this protects against already happened. v1.2.2 was built on
 * `ubuntu-latest` after GitHub moved that label to Ubuntu 24.04, so every
 * artifact demanded GLIBC_2.38 and died on launch for users on Ubuntu 22.04
 * LTS, Debian 12 and RHEL 9 -- after passing the signature, architecture and
 * packed-addon checks, none of which can see it. The build machine can never
 * notice by running the app: its own glibc is always new enough.
 *
 * If the parser below silently mis-reads a section header it returns null, the
 * release step prints OK, and the protection is gone without a sound -- so the
 * parser is tested rather than only the script that calls it.
 */

/** Byte offsets this test writes into, mirroring the ELF64 file header. */
const SECTION_ENTRY_SIZE = 64;

/**
 * Build the smallest byte sequence that is a valid little-endian 64-bit ELF:
 * a file header pointing at three section headers (the mandatory null one, the
 * section-name table, and one more), each pointing at its contents.
 */
const elfBinary = (
  sections: { name: string; content: Buffer }[],
  { elfClass = 2, elfData = 1 } = {}
): Buffer => {
  const headerSize = 0x40;
  const names = ['', ...sections.map((section) => section.name)];
  const nameTable = Buffer.from(`${names.join('\0')}\0`, 'latin1');
  const nameOffsets = new Map<string, number>();
  let cursor = 0;
  for (const name of names) {
    nameOffsets.set(name, cursor);
    cursor += name.length + 1;
  }

  // Section 0 is the mandatory null entry; then the name table; then the rest.
  const laid = [
    { name: '', content: Buffer.alloc(0) },
    { name: '.shstrtab', content: nameTable },
    ...sections.filter((section) => section.name !== '.shstrtab'),
  ];
  const tableOffset = headerSize;
  let contentOffset = tableOffset + laid.length * SECTION_ENTRY_SIZE;

  const table = Buffer.alloc(laid.length * SECTION_ENTRY_SIZE);
  const bodies: Buffer[] = [];
  laid.forEach((section, index) => {
    const entry = table.subarray(index * SECTION_ENTRY_SIZE, (index + 1) * SECTION_ENTRY_SIZE);
    entry.writeUInt32LE(nameOffsets.get(section.name) ?? 0, 0x00);
    entry.writeBigUInt64LE(BigInt(index === 0 ? 0 : contentOffset), 0x18);
    entry.writeBigUInt64LE(BigInt(section.content.length), 0x20);
    if (index !== 0) {
      bodies.push(section.content);
      contentOffset += section.content.length;
    }
  });

  const header = Buffer.alloc(headerSize);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header, 0);
  header[4] = elfClass;
  header[5] = elfData;
  header.writeBigUInt64LE(BigInt(tableOffset), 0x28);
  header.writeUInt16LE(SECTION_ENTRY_SIZE, 0x3a);
  header.writeUInt16LE(laid.length, 0x3c);
  header.writeUInt16LE(1, 0x3e); // .shstrtab is always index 1 above.

  return Buffer.concat([header, table, ...bodies]);
};

/** A `.dynstr` section as the linker writes it: NUL-separated symbol strings. */
const dynstr = (entries: string[]): Buffer => Buffer.from(`\0${entries.join('\0')}\0`, 'latin1');

describe('parseVersion / formatVersion / compareVersions', () => {
  // A floor that silently parses to something lenient disables the whole check.
  it('rejects anything that is not a glibc version', () => {
    expect(() => parseVersion('2')).toThrow(/Not a glibc version/);
    expect(() => parseVersion('2.x')).toThrow(/Not a glibc version/);
    expect(() => parseVersion('2.35.1.4')).toThrow(/Not a glibc version/);
  });

  it('round-trips a two- and three-part version', () => {
    expect(parseVersion('2.35')).toEqual([2, 35]);
    expect(formatVersion(parseVersion('2.2.5'))).toBe('2.2.5');
  });

  // Compared as numbers, not text: "2.9" must not outrank "2.38".
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions([2, 38], [2, 9])).toBeGreaterThan(0);
    expect(compareVersions([2, 35], [2, 35])).toBe(0);
    expect(compareVersions([2, 2], [2, 2, 5])).toBeLessThan(0);
  });
});

describe('isElfHeader', () => {
  // How the binaries are picked out of a packaged app: the main executable has
  // no extension and the addons are .node, so only the magic bytes can decide.
  it('recognises the ELF magic and nothing else', () => {
    expect(isElfHeader(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toBe(true);
    expect(isElfHeader(Buffer.from('MZ\0\0', 'latin1'))).toBe(false);
    expect(isElfHeader(Buffer.from([0x7f, 0x45]))).toBe(false);
  });
});

describe('glibcVersionsInStringTable / highestVersion', () => {
  it('picks out only GLIBC_ version strings', () => {
    const table = dynstr(['libc.so.6', 'GLIBC_2.35', 'sqlite3_open', 'GLIBC_2.2.5', 'GLIBCXX_3.4']);
    expect(glibcVersionsInStringTable(table)).toEqual([
      [2, 35],
      [2, 2, 5],
    ]);
  });

  it('reports the highest requirement, or null when there is none', () => {
    expect(highestVersion(glibcVersionsInStringTable(dynstr(['GLIBC_2.17', 'GLIBC_2.38', 'GLIBC_2.9'])))).toEqual([2, 38]);
    expect(highestVersion([])).toBeNull();
  });
});

describe('readGlibcRequirement', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'elf-glibc-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** Write `bytes` into the temp dir and return its path. */
  const file = (name: string, bytes: Buffer): string => {
    const full = join(directory, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, bytes);
    return full;
  };

  // The whole point: the version an artifact demands, read out of the artifact.
  it('reads the highest glibc version out of .dynstr', () => {
    const path = file('libapp.so', elfBinary([{ name: '.dynstr', content: dynstr(['GLIBC_2.17', 'GLIBC_2.38']) }]));
    expect(readGlibcRequirement(path)).toEqual([2, 38]);
  });

  // A static binary is fine to ship; it must not be reported as a failure.
  it('returns null for an ELF with no .dynstr', () => {
    const path = file('static.bin', elfBinary([{ name: '.text', content: Buffer.alloc(8) }]));
    expect(readGlibcRequirement(path)).toBeNull();
  });

  // Failing loudly beats returning null, which the caller reads as "clean".
  it('throws on a file that is not a little-endian 64-bit ELF', () => {
    expect(() => readGlibcRequirement(file('notelf.txt', Buffer.from('hello world')))).toThrow(/Not an ELF/);
    const bigEndian = elfBinary([{ name: '.dynstr', content: dynstr(['GLIBC_2.35']) }], { elfData: 2 });
    expect(() => readGlibcRequirement(file('be.so', bigEndian))).toThrow(/Unsupported ELF/);
  });
});

describe('findElfFiles', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'elf-find-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // Extensions cannot be trusted here: the main executable has none and the
  // addons are .node, so the magic bytes are what decide.
  it('finds ELF files at any depth and ignores everything else', () => {
    mkdirSync(join(directory, 'resources', 'app.asar.unpacked'), { recursive: true });
    const elf = elfBinary([{ name: '.dynstr', content: dynstr(['GLIBC_2.35']) }]);
    writeFileSync(join(directory, 'sarv-inbox'), elf);
    writeFileSync(join(directory, 'resources', 'app.asar.unpacked', 'better_sqlite3.node'), elf);
    writeFileSync(join(directory, 'resources', 'app.asar'), Buffer.from('not an elf'));

    expect(findElfFiles(directory)).toEqual([
      join(directory, 'resources', 'app.asar.unpacked', 'better_sqlite3.node'),
      join(directory, 'sarv-inbox'),
    ]);
  });

  // An empty result is what the CLI turns into a hard failure; it must not
  // throw on a path that simply is not there.
  it('returns nothing for a directory that does not exist', () => {
    expect(findElfFiles(join(directory, 'missing'))).toEqual([]);
  });
});
