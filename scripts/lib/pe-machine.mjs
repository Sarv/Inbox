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

  const machine = buffer.readUInt16LE(peOffset + 4);
  return MACHINE_TYPES.get(machine) ?? `unknown (0x${machine.toString(16)})`;
}
