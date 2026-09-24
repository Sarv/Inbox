export declare const REQUIRED_ADDONS: string[];
export declare function findNativeAddons(root: string): string[];
export declare function findPackagedApps(releaseDir: string): string[];
export declare function missingRequiredAddons(addonPaths: string[], required?: string[]): string[];
export declare function readFileHeader(root: string, bytes?: number): Buffer;
