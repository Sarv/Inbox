/*
 * Read the target CPU architecture out of a Windows PE binary (.node, .dll,
 * .exe) by parsing its COFF header.
 *
 * Why this exists. The Windows installer is built for x64 AND arm64 in one
 * electron-builder invocation on an x64 runner, so the arm64 copy of
 * better-sqlite3 is CROSS-compiled. If that cross-compile silently falls back
 * to the host architecture, everything still succeeds: the addon builds, the
 * app packs, the installer is produced, CI goes green. The failure only appears
 * on a user's arm64 machine, where Electron cannot load an x64 .node at all.
 *
 * And it does not appear as a crash. Every core-DB read is wrapped in a
 * try/catch that returns an empty result (see CLAUDE.md), so an unloadable
 * addon looks exactly like "this user has no accounts, no folders and no mail".
 * An unreadable store and an empty store are the same value and opposite facts.
 * That is the single most expensive bug shape in this codebase, so the release
 * workflow verifies the machine type of every shipped .node rather than
 * trusting the rebuild to have honoured --arch.
 *
 * Format reference: PE/COFF spec. Offset 0x3C of the DOS header holds a uint32
 * pointing at the PE signature ("PE\0\0"); the COFF header follows it, and its
 * first uint16 is the machine type.
 */

/** Offset of the uint32 that points at the PE signature. */
const PE_OFFSET_POINTER = 0x3c;

/** The 4-byte signature that must sit at the offset above. */
const PE_SIGNATURE = 'PE\0\0';

/**
 * COFF machine types, mapped to the architecture names electron-builder and
 * Node use. Only the ones this project could plausibly produce are listed --
 * an unrecognised value is reported as-is rather than guessed at.
 */
const MACHINE_TYPES = new Map([
  [0x014c, 'ia32'],
  [0x8664, 'x64'],
  [0xaa64, 'arm64'],
  [0x01c0, 'arm'],
  [0x01c4, 'armv7'],
]);

/**
 * The smallest buffer that can possibly contain a COFF header: the pointer at
 * 0x3C plus its own width.
 */
const MIN_HEADER_BYTES = PE_OFFSET_POINTER + 4;

/**
 * Find the PE signature and return its offset. The one place this module
 * walks the DOS header, shared by every reader below so they cannot disagree
 * about what counts as a PE binary.
 *
 * @param {Buffer} buffer Contents of the file (at least its first few hundred bytes).
 * @returns {number} Offset of "PE\0\0".
 */
export function locatePeSignature(buffer) {
  if (buffer.length < MIN_HEADER_BYTES) {
    throw new Error(`not a PE binary: only ${buffer.length} bytes, need at least ${MIN_HEADER_BYTES}`);
  }

  const peOffset = buffer.readUInt32LE(PE_OFFSET_POINTER);
  // +6 so the machine uint16 that follows the 4-byte signature is in range too.
  if (peOffset + 6 > buffer.length) {
    throw new Error(`not a PE binary: PE header offset ${peOffset} is past the end of the file`);
  }

  if (buffer.toString('binary', peOffset, peOffset + 4) !== PE_SIGNATURE) {
    throw new Error(`not a PE binary: no PE signature at offset ${peOffset}`);
  }
  return peOffset;
}

/**
 * Whether a buffer starts like a PE binary. Never throws: for walking a tree of
 * files of every kind and picking out the executables by CONTENT, which is how
 * Windows itself decides, rather than by extension.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isPeBinary(buffer) {
  if (buffer.length < 2 || buffer.toString('binary', 0, 2) !== 'MZ') return false;
  try {
    locatePeSignature(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the architecture a PE binary was compiled for.
 *
 * Pure: takes the file's bytes, returns a name. Throws on anything that is not
 * a PE binary, so a truncated or corrupt file is never reported as a
 * mismatched architecture -- those are different problems and deserve
 * different messages.
 *
 * @param {Buffer} buffer Contents of the file (the first few hundred bytes are
 *   enough; callers need not read the whole binary).
 * @returns {string} `'x64'`, `'arm64'`, `'ia32'`, ... or `'unknown (0x….)'`.
 */
export function readPeMachine(buffer) {
  const peOffset = locatePeSignature(buffer);
  const machine = buffer.readUInt16LE(peOffset + 4);
  return MACHINE_TYPES.get(machine) ?? `unknown (0x${machine.toString(16)})`;
}

/*
 * The Authenticode certificate table.
 *
 * Why this exists. An Authenticode signature lives in the PE "certificate
 * table": data directory 4 (IMAGE_DIRECTORY_ENTRY_SECURITY) of the optional
 * header. Unlike every other directory its address is a FILE OFFSET, not an
 * RVA, and the table itself is appended at the end of the file, outside every
 * section. An unsigned file has a zero entry. Reading that entry is enough to
 * tell "carries a signature" from "does not" on any OS, without Windows'
 * trust APIs -- which is what the release's publish job (Linux) and the
 * signing hook's "already signed, leave it alone" rule need. Whether the
 * signature is VALID is a separate question, answered on Windows by
 * Get-AuthenticodeSignature (see scripts/lib/windows-signing.mjs).
 *
 * The NSIS installer is PE32 (a 32-bit stub) while the app and its addons are
 * PE32+, and the two put the data directories at different offsets, so both
 * layouts are handled.
 */

/** Size of the COFF file header that follows the PE signature. */
const COFF_HEADER_BYTES = 20;

/** Optional-header magic numbers, and where each layout keeps its directories. */
const OPTIONAL_HEADER_LAYOUTS = new Map([
  [0x10b, { format: 'PE32', rvaCountOffset: 92, directoriesOffset: 96 }],
  [0x20b, { format: 'PE32+', rvaCountOffset: 108, directoriesOffset: 112 }],
]);

/** Index of the certificate table among the data directories. */
const CERTIFICATE_TABLE_INDEX = 4;

/** Each data directory is a uint32 address and a uint32 size. */
const DATA_DIRECTORY_BYTES = 8;

/** WIN_CERTIFICATE: dwLength (4), wRevision (2), wCertificateType (2). */
export const WIN_CERTIFICATE_HEADER_BYTES = 8;
const WIN_CERT_REVISION_2_0 = 0x0200;
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 0x0002;

/**
 * Read where a PE binary's certificate table is, from its headers alone.
 *
 * Pure. Throws on a buffer that is not a PE binary, or whose headers are
 * truncated or carry an optional-header layout this does not know -- an
 * unreadable header must never be reported as "unsigned" (or as "signed").
 *
 * @param {Buffer} buffer The start of the file; the headers end well inside
 *   the first 4 KB of anything a toolchain produces.
 * @returns {{ format: 'PE32' | 'PE32+', offset: number, size: number }}
 *   `size` 0 means the file carries no signature.
 */
export function readPeCertificateTable(buffer) {
  const peOffset = locatePeSignature(buffer);
  const coff = peOffset + 4;
  if (coff + COFF_HEADER_BYTES > buffer.length) {
    throw new Error(
      `truncated PE header: the COFF header at ${coff} runs past ${buffer.length} bytes`
    );
  }
  const optionalHeaderSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + COFF_HEADER_BYTES;
  if (optional + 2 > buffer.length) {
    throw new Error(`truncated PE header: no optional header at ${optional}`);
  }

  const magic = buffer.readUInt16LE(optional);
  const layout = OPTIONAL_HEADER_LAYOUTS.get(magic);
  if (!layout) {
    throw new Error(
      `unknown PE optional-header magic 0x${magic.toString(16)} (expected PE32 0x10b or PE32+ 0x20b)`
    );
  }
  if (optional + layout.rvaCountOffset + 4 > buffer.length) {
    throw new Error('truncated PE header: the data-directory count is past the end of the buffer');
  }

  const directoryCount = buffer.readUInt32LE(optional + layout.rvaCountOffset);
  // A header with fewer than five directories has no certificate slot at all:
  // nothing can be signed in it, which is "unsigned", not "unreadable".
  if (directoryCount <= CERTIFICATE_TABLE_INDEX) {
    return { format: layout.format, offset: 0, size: 0 };
  }

  const entry = layout.directoriesOffset + CERTIFICATE_TABLE_INDEX * DATA_DIRECTORY_BYTES;
  if (entry + DATA_DIRECTORY_BYTES > optionalHeaderSize) {
    throw new Error(
      `malformed PE header: the optional header is ${optionalHeaderSize} bytes, too short for the certificate-table entry`
    );
  }
  if (optional + entry + DATA_DIRECTORY_BYTES > buffer.length) {
    throw new Error(
      'truncated PE header: the certificate-table entry is past the end of the buffer'
    );
  }

  return {
    format: layout.format,
    offset: buffer.readUInt32LE(optional + entry),
    size: buffer.readUInt32LE(optional + entry + 4),
  };
}

/**
 * Say what is wrong with a certificate table, or `null` if it is a plausible
 * Authenticode signature: present, inside the file, and starting with a
 * WIN_CERTIFICATE header of revision 2.0 carrying PKCS#7 signed data.
 *
 * Pure: the caller does the I/O (see readFileCertificateTable in
 * windows-signing.mjs), so this is testable on synthetic buffers.
 *
 * @param {{ offset: number, size: number }} table From {@link readPeCertificateTable}.
 * @param {number} fileSize The file's size in bytes.
 * @param {Buffer} [entryHeader] The {@link WIN_CERTIFICATE_HEADER_BYTES} bytes at `table.offset`.
 * @returns {string | null}
 */
export function certificateTableProblem(table, fileSize, entryHeader) {
  if (table.size === 0) return 'no certificate table: the file is not signed';
  if (table.offset === 0 || table.offset + table.size > fileSize) {
    return `certificate table at ${table.offset}+${table.size} lies outside the ${fileSize}-byte file`;
  }
  if (!entryHeader || entryHeader.length < WIN_CERTIFICATE_HEADER_BYTES) {
    return 'certificate table is too short to hold a WIN_CERTIFICATE header';
  }
  const length = entryHeader.readUInt32LE(0);
  const revision = entryHeader.readUInt16LE(4);
  const type = entryHeader.readUInt16LE(6);
  if (length <= WIN_CERTIFICATE_HEADER_BYTES || length > table.size) {
    return `WIN_CERTIFICATE length ${length} does not fit the ${table.size}-byte table`;
  }
  if (revision !== WIN_CERT_REVISION_2_0) {
    return `WIN_CERTIFICATE revision 0x${revision.toString(16)} is not 0x200`;
  }
  if (type !== WIN_CERT_TYPE_PKCS_SIGNED_DATA) {
    return `WIN_CERTIFICATE type 0x${type.toString(16)} is not PKCS#7 signed data`;
  }
  return null;
}
