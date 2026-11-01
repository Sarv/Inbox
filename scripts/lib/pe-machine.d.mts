/* Types for pe-machine.mjs — see userdata-dirs.d.mts for why these exist. */

/** Offset of the "PE\0\0" signature; throws if the buffer is not a PE binary. */
export declare function locatePeSignature(buffer: Buffer): number;

/** Whether a buffer starts like a PE binary (MZ + PE signature). Never throws. */
export declare function isPeBinary(buffer: Buffer): boolean;

/** Read the CPU architecture a Windows PE binary was compiled for. */
export declare function readPeMachine(buffer: Buffer): string;

export declare const WIN_CERTIFICATE_HEADER_BYTES: number;

export interface PeCertificateTable {
  format: 'PE32' | 'PE32+';
  /** File offset of the table (data directory 4 holds a file offset, not an RVA). */
  offset: number;
  /** 0 when the file carries no signature. */
  size: number;
}

/** Locate the Authenticode certificate table from a PE binary's headers. */
export declare function readPeCertificateTable(buffer: Buffer): PeCertificateTable;

/** What is wrong with a certificate table, or null if it is a plausible signature. */
export declare function certificateTableProblem(
  table: { offset: number; size: number },
  fileSize: number,
  entryHeader?: Buffer
): string | null;
