/**
 * Synthetic PE binaries for the scripts/lib PE tests (pe-machine,
 * windows-signing). One builder, shared, so the tests of the parser and of
 * its callers cannot drift apart on what a PE file looks like.
 */

/**
 * The smallest byte sequence readPeMachine accepts: a DOS stub whose 0x3C
 * pointer leads to "PE\0\0" followed by the COFF machine type. No optional
 * header -- deliberately, readPeMachine must not need one.
 */
export const peBinary = (
  machine: number,
  { signature = 'PE\0\0', peOffset = 0x80 } = {}
): Buffer => {
  const buffer = Buffer.alloc(peOffset + 8);
  buffer.write('MZ', 0, 'binary');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write(signature, peOffset, 'binary');
  buffer.writeUInt16LE(machine, peOffset + 4);
  return buffer;
};

/** A WIN_CERTIFICATE entry: dwLength, wRevision, wCertificateType, then payload. */
export const winCertificate = (
  payloadBytes = 64,
  {
    revision = 0x0200,
    type = 0x0002,
    length,
  }: { revision?: number; type?: number; length?: number } = {}
): Buffer => {
  const entry = Buffer.alloc(8 + payloadBytes, 0x30);
  entry.writeUInt32LE(length ?? entry.length, 0);
  entry.writeUInt16LE(revision, 4);
  entry.writeUInt16LE(type, 6);
  return entry;
};

export interface FullPeOptions {
  format?: 'PE32' | 'PE32+';
  machine?: number;
  /** NumberOfRvaAndSizes. */
  directoryCount?: number;
  /** Overrides SizeOfOptionalHeader in the COFF header. */
  optionalHeaderSize?: number;
  /** Overrides the optional-header magic. */
  magic?: number;
  peOffset?: number;
  /** Stand-in for the sections. */
  bodyBytes?: number;
  /** Appended at the end of the file and recorded in data directory 4. */
  certificate?: Buffer;
  /** Written into data directory 4 instead of the real location. */
  table?: { offset: number; size: number };
}

/**
 * A PE file with a real optional header and data directories, optionally
 * carrying a certificate table appended at the end -- where Authenticode
 * (and jsign) put it.
 */
export const fullPe = ({
  format = 'PE32+',
  machine = 0x8664,
  directoryCount = 16,
  optionalHeaderSize,
  magic,
  peOffset = 0x80,
  bodyBytes = 256,
  certificate,
  table,
}: FullPeOptions = {}): Buffer => {
  const directoriesOffset = format === 'PE32' ? 96 : 112;
  const rvaCountOffset = format === 'PE32' ? 92 : 108;
  const naturalOptionalSize = directoriesOffset + 16 * 8;
  const optional = peOffset + 24;
  const headerEnd = optional + naturalOptionalSize;
  const unsignedLength = headerEnd + bodyBytes;
  const buffer = Buffer.alloc(unsignedLength + (certificate?.length ?? 0));

  buffer.write('MZ', 0, 'binary');
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write('PE\0\0', peOffset, 'binary');
  buffer.writeUInt16LE(machine, peOffset + 4);
  buffer.writeUInt16LE(optionalHeaderSize ?? naturalOptionalSize, peOffset + 4 + 16);
  buffer.writeUInt16LE(magic ?? (format === 'PE32' ? 0x10b : 0x20b), optional);
  buffer.writeUInt32LE(directoryCount, optional + rvaCountOffset);

  const entry = optional + directoriesOffset + 4 * 8;
  if (certificate) {
    certificate.copy(buffer, unsignedLength);
    buffer.writeUInt32LE(unsignedLength, entry);
    buffer.writeUInt32LE(certificate.length, entry + 4);
  }
  if (table) {
    buffer.writeUInt32LE(table.offset, entry);
    buffer.writeUInt32LE(table.size, entry + 4);
  }
  return buffer;
};

/**
 * What a fake jsign does to a file: append a certificate table and point
 * data directory 4 at it, exactly as the real one does.
 */
export const appendSignature = (unsigned: Buffer): Buffer => {
  const certificate = winCertificate();
  const signed = Buffer.concat([unsigned, certificate]);
  const peOffset = signed.readUInt32LE(0x3c);
  const optional = peOffset + 24;
  const directoriesOffset = signed.readUInt16LE(optional) === 0x10b ? 96 : 112;
  const entry = optional + directoriesOffset + 4 * 8;
  signed.writeUInt32LE(unsigned.length, entry);
  signed.writeUInt32LE(certificate.length, entry + 4);
  return signed;
};
