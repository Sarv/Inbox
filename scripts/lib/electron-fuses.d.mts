export type FuseName =
  | 'RunAsNode'
  | 'EnableCookieEncryption'
  | 'EnableNodeOptionsEnvironmentVariable'
  | 'EnableNodeCliInspectArguments'
  | 'EnableEmbeddedAsarIntegrityValidation'
  | 'OnlyLoadAppFromAsar'
  | 'LoadBrowserProcessSpecificV8Snapshot'
  | 'GrantFileProtocolExtraPrivileges';

export declare const EXPECTED_FUSES: Readonly<Record<FuseName, boolean>>;
export declare const BUILDER_KEYS: Readonly<Record<FuseName, string>>;
export declare const FUSE_SENTINEL: string;
export interface FuseWire { offset: number; version: number; states: number[] }
export declare function fuseFilePath(target: string): string;
export declare function readFuseWires(binary: Buffer): FuseWire[];
export declare function fuseProblems(states: number[], ids: Record<string, number>): string[];
