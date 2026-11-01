export declare const REQUIRED_ADDONS: string[];
export declare function findNativeAddons(root: string): string[];
export declare function findPackagedApps(releaseDir: string): string[];
export declare function missingRequiredAddons(addonPaths: string[], required?: string[]): string[];
export declare function readFileHeader(root: string, bytes?: number): Buffer;
/** Every entry under `root` as it is on disk -- never the inside of an .asar archive. */
export declare function readTreeOnDisk(root: string): import('node:fs').Dirent[];
