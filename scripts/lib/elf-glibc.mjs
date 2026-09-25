/*
 * Read the highest glibc version a Linux binary demands, by parsing the ELF
 * dynamic string table it links against.
 *
 * Why this exists. glibc is backward compatible and never forward: a binary
 * linked on a machine with glibc 2.39 binds the newest versioned symbols it can
 * see and then refuses to load anywhere older, with
 *
 *   /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
 *
 * Nothing on the build machine can notice, because the build machine is always
 * new enough. v1.2.2 shipped exactly that: the release workflow built Linux on
 * `ubuntu-latest`, GitHub moved that label to Ubuntu 24.04, and every user on
 * Ubuntu 22.04 LTS, Debian 12 or RHEL 9 got an app that died on launch. The
 * runner label is now pinned, but a pin is a comment away from being undone --
 * this reads the artifacts themselves, which cannot be argued with.
 *
 * Format reference: ELF64 spec. The file header gives the offset, size and
 * count of the section header table plus the index of the section-name string
 * table; each section header gives a name offset, a file offset and a size.
 * Versioned symbol requirements are recorded as plain NUL-terminated strings
 * ("GLIBC_2.35") inside `.dynstr`, so the strings in that ONE section are read
 * rather than the whole file -- a grep over the whole binary would also match
 * any unrelated data that happens to spell a version, and a false failure that
 * blocks a release is as expensive as a missed one.
 */

import fs from 'node:fs';
import path from 'node:path';

/** First four bytes of every ELF file. */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** e_ident[EI_CLASS] value for a 64-bit object. 32-bit Linux is not a target. */
const ELF_CLASS_64 = 2;

/** e_ident[EI_DATA] value for little-endian. Every arch we ship is LE. */
const ELF_DATA_LSB = 1;

/** Offsets inside the ELF64 file header. */
const HEADER = Object.freeze({
  class: 4,
  data: 5,
  sectionHeaderOffset: 0x28,
  sectionHeaderEntrySize: 0x3a,
  sectionHeaderCount: 0x3c,
  sectionNameTableIndex: 0x3e,
  size: 0x40,
});

/** Offsets inside one ELF64 section header entry. */
const SECTION = Object.freeze({
  name: 0x00,
  offset: 0x18,
  size: 0x20,
});

/** The section holding the versioned-symbol strings we are after. */
const DYNAMIC_STRING_SECTION = '.dynstr';

/** Every versioned glibc symbol is spelled "GLIBC_<major>.<minor>[.<patch>]". */
const GLIBC_VERSION = /^GLIBC_(\d+)\.(\d+)(?:\.(\d+))?$/;

/**
 * True when `buffer` starts with the ELF magic. Used to pick the binaries out
 * of a packaged app without depending on file extensions -- the main
 * executable has none, and the addons are .node rather than .so.
 *
 * @param {Buffer} buffer At least the first four bytes of a file.
 * @returns {boolean}
 */
export function isElfHeader(buffer) {
  return buffer.length >= ELF_MAGIC.length && buffer.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC);
}

/**
 * Parse "2.35" into a comparable tuple. Throws rather than guessing: a
 * mistyped floor that parses to something lenient would disable the check
 * silently.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function parseVersion(text) {
  const parts = String(text).split('.');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`Not a glibc version: "${text}" (expected e.g. 2.35)`);
  }
  return parts.map(Number);
}

/** Render a tuple back as "2.35". @param {number[]} version @returns {string} */
export function formatVersion(version) {
  return version.join('.');
}

/**
 * Compare two version tuples of possibly different length, so 2.2 and 2.2.5
 * order correctly.
 *
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number} Negative, zero or positive, like a sort comparator.
 */
export function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Every GLIBC_x.y string in a NUL-separated string table, as tuples.
 *
 * @param {Buffer} strtab Contents of a `.dynstr` section.
 * @returns {number[][]}
 */
export function glibcVersionsInStringTable(strtab) {
  return strtab
    .toString('latin1')
    .split('\0')
    .map((entry) => GLIBC_VERSION.exec(entry))
    .filter((match) => match !== null)
    .map((match) => [Number(match[1]), Number(match[2]), ...(match[3] === undefined ? [] : [Number(match[3])])]);
}

/**
 * The highest of a list of versions, or null when the list is empty.
 *
 * @param {number[][]} versions
 * @returns {number[] | null}
 */
export function highestVersion(versions) {
  return versions.length === 0 ? null : versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
}

/**
 * Read `length` bytes at `position` from an open file descriptor.
 *
 * @param {number} fd
 * @param {number} position
 * @param {number} length
 * @returns {Buffer} What was actually read, which may be shorter.
 */
function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

/**
 * The highest glibc version `file` requires, or null when it requires none
 * (a static binary, a data file, or an ELF with no `.dynstr`).
 *
 * Reads three small ranges rather than the file: the packaged Electron binary
 * alone is ~180MB and there are dozens of shared objects beside it.
 *
 * @param {string} file
 * @returns {number[] | null}
 * @throws {Error} When the file is not a little-endian 64-bit ELF.
 */
export function readGlibcRequirement(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = readAt(fd, 0, HEADER.size);
    if (!isElfHeader(header)) throw new Error(`Not an ELF file: ${file}`);
    if (header[HEADER.class] !== ELF_CLASS_64 || header[HEADER.data] !== ELF_DATA_LSB) {
      throw new Error(`Unsupported ELF (only little-endian 64-bit is built): ${file}`);
    }

    const tableOffset = Number(header.readBigUInt64LE(HEADER.sectionHeaderOffset));
    const entrySize = header.readUInt16LE(HEADER.sectionHeaderEntrySize);
    const count = header.readUInt16LE(HEADER.sectionHeaderCount);
    const nameTableIndex = header.readUInt16LE(HEADER.sectionNameTableIndex);
    if (tableOffset === 0 || count === 0 || nameTableIndex >= count) return null;

    const table = readAt(fd, tableOffset, entrySize * count);
    /** @param {number} index */
    const sectionAt = (index) => {
      const entry = table.subarray(index * entrySize, (index + 1) * entrySize);
      return {
        name: entry.readUInt32LE(SECTION.name),
        offset: Number(entry.readBigUInt64LE(SECTION.offset)),
        size: Number(entry.readBigUInt64LE(SECTION.size)),
      };
    };

    const names = sectionAt(nameTableIndex);
    const nameTable = readAt(fd, names.offset, names.size);
    /** @param {number} at */
    const nameOf = (at) => {
      const end = nameTable.indexOf(0, at);
      return nameTable.subarray(at, end === -1 ? nameTable.length : end).toString('latin1');
    };

    for (let index = 0; index < count; index += 1) {
      const section = sectionAt(index);
      if (nameOf(section.name) !== DYNAMIC_STRING_SECTION) continue;
      return highestVersion(glibcVersionsInStringTable(readAt(fd, section.offset, section.size)));
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every ELF file under `root`, deepest-first order irrelevant, sorted for
 * stable output. Symlinks are skipped: electron-builder leaves several
 * (libfoo.so -> libfoo.so.1) and reporting the same binary twice under two
 * names makes a failure harder to read, not easier.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function findElfFiles(root) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} directory */
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const fd = fs.openSync(full, 'r');
      try {
        if (isElfHeader(readAt(fd, 0, ELF_MAGIC.length))) found.push(full);
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.sort();
}
