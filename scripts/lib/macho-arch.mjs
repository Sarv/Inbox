/*
 * Read the CPU architectures out of a Mach-O binary (.node, .dylib, the app
 * executable), including every slice of a universal "fat" binary.
 *
 * Why this exists. The macOS build is UNIVERSAL: electron-builder packs an x64
 * app and an arm64 app, then @electron/universal merges them, running `lipo`
 * over each pair of Mach-O files so one file carries both slices. If that merge
 * ever silently keeps only one slice -- a changed asarUnpack rule, an
 * afterPack hook deleting one side, a future @electron/universal that treats a
 * mismatch as skippable -- the dmg still builds, still signs, still notarizes
 * and still installs. It only fails on the half of users whose CPU is missing.
 *
 * And it does not fail as a crash. Every core-DB read is wrapped in a try/catch
 * returning an empty result (see CLAUDE.md), so an unloadable better_sqlite3
 * looks exactly like "this user has no accounts, no folders and no mail". That
 * is the same shape as the 2026-09-09 data loss, and the same reason
 * scripts/lib/pe-machine.mjs exists for Windows.
 *
 * Format reference: <mach-o/fat.h> and <mach-o/loader.h>. A fat header is
 * ALWAYS big-endian: magic, then nfat_arch, then one fat_arch per slice whose
 * first field is the cputype. A thin Mach-O starts with its own magic, whose
 * byte order tells you how to read the cputype that follows it.
 */

/** Fat (universal) magics. Both are read big-endian, by definition. */
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

/** Thin Mach-O magics, as seen when the first four bytes are read big-endian. */
const MH_MAGIC = 0xfeedface; // 32-bit, file is big-endian
const MH_MAGIC_64 = 0xfeedfacf; // 64-bit, file is big-endian
const MH_CIGAM = 0xcefaedfe; // 32-bit, file is little-endian
const MH_CIGAM_64 = 0xcffaedfe; // 64-bit, file is little-endian

/** Size of one fat_arch / fat_arch_64 entry, in bytes. */
const FAT_ARCH_SIZE = 20;
const FAT_ARCH_64_SIZE = 32;

/** Where the slice table starts: past the magic and nfat_arch. */
const FAT_HEADER_SIZE = 8;

/**
 * A sanity bound on the slice count. Apple has never shipped more than a
 * handful; a larger number means the bytes are not a fat header at all, and
 * looping on it would read garbage.
 */
const MAX_SLICES = 16;

/**
 * CPU types, mapped to the architecture names electron-builder and Node use.
 * Unrecognised values are reported as-is rather than guessed at.
 */
const CPU_TYPES = new Map([
  [7, 'ia32'],
  [0x01000007, 'x64'],
  [12, 'arm'],
  [0x0100000c, 'arm64'],
]);

/** The smallest buffer that could hold a magic and the field after it. */
const MIN_HEADER_BYTES = 8;

/** @param {number} cpuType */
const nameOf = (cpuType) => CPU_TYPES.get(cpuType) ?? `unknown (0x${(cpuType >>> 0).toString(16)})`;

/**
 * Read every architecture a Mach-O binary contains.
 *
 * Pure: takes the file's bytes, returns names. Throws on anything that is not a
 * Mach-O binary, so a truncated or corrupt file is never reported as a missing
 * architecture -- those are different problems and deserve different messages.
 *
 * @param {Buffer} buffer Contents of the file. The first few hundred bytes are
 *   enough; callers need not read the whole binary.
 * @returns {string[]} One name per slice, e.g. `['x64', 'arm64']` for a
 *   universal build or `['arm64']` for a thin one. Order is the file's own.
 */
export function readMachOArchs(buffer) {
  if (buffer.length < MIN_HEADER_BYTES) {
    throw new Error(`not a Mach-O binary: only ${buffer.length} bytes, need at least ${MIN_HEADER_BYTES}`);
  }

  const magic = buffer.readUInt32BE(0);

  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const sliceCount = buffer.readUInt32BE(4);
    if (sliceCount === 0 || sliceCount > MAX_SLICES) {
      throw new Error(`not a Mach-O binary: fat header claims ${sliceCount} architectures`);
    }

    const entrySize = magic === FAT_MAGIC_64 ? FAT_ARCH_64_SIZE : FAT_ARCH_SIZE;
    const needed = FAT_HEADER_SIZE + sliceCount * entrySize;
    if (needed > buffer.length) {
      throw new Error(`not a Mach-O binary: fat header needs ${needed} bytes, file has ${buffer.length}`);
    }

    return Array.from({ length: sliceCount }, (_unused, index) =>
      nameOf(buffer.readInt32BE(FAT_HEADER_SIZE + index * entrySize))
    );
  }

  if (magic === MH_MAGIC || magic === MH_MAGIC_64) return [nameOf(buffer.readInt32BE(4))];
  if (magic === MH_CIGAM || magic === MH_CIGAM_64) return [nameOf(buffer.readInt32LE(4))];

  throw new Error(`not a Mach-O binary: no recognised magic at offset 0 (0x${magic.toString(16)})`);
}
