export declare function isElfHeader(buffer: Buffer): boolean;
export declare function parseVersion(text: string): number[];
export declare function formatVersion(version: number[]): string;
export declare function compareVersions(left: number[], right: number[]): number;
export declare function glibcVersionsInStringTable(strtab: Buffer): number[][];
export declare function highestVersion(versions: number[][]): number[] | null;
export declare function readGlibcRequirement(file: string): number[] | null;
export declare function findElfFiles(root: string): string[];
