export declare const MANIFEST_FORMAT: number;
export declare const MANIFEST_NAME: string;
export declare const SIGNATURE_NAME: string;
export declare function sha512Base64(bytes: Buffer): string;
export declare function buildManifest(version: string, artifacts: Record<string, Buffer>): Buffer;
export declare function signManifest(manifestBytes: Buffer, privateKeyPem: string): string;
export declare function publicKeyPemFor(privateKeyPem: string): string;
export declare function ymlProblems(
  ymlName: string,
  yml: { version?: string; files?: Array<{ url?: string; sha512?: string }> },
  version: string,
  signed: Record<string, { sha512: string }>,
): string[];
