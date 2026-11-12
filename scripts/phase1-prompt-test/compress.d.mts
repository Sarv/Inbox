// Type declarations for compress.mjs — see the sibling .mjs for the rationale.
// Mirrors the convention used by the scripts/lib modules, so the unit test that
// imports it is type-checked.

export interface BodyFormat {
  /** false for a body that is already plain text; it is then not parsed as HTML. */
  html?: boolean;
}

export declare function estimateTokens(s: string | null | undefined): number;
export declare function compressToPlainText(body: string, options?: BodyFormat): string;
export declare function compressTruncateDepth(plainText: string, maxDepth: number): string;
export declare function compressToFit(
  html: string,
  maxBodyChars: number,
  options?: BodyFormat
): { body: string; finalDepth: number; originalChars: number; compressedChars: number };
