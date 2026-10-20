export declare function packageNameOf(specifier: string): string;
export declare function isRuntimeProvided(specifier: string): boolean;
export declare function requiredPackagesOf(source: string): string[];
export declare function owningPackageOf(file: string): string | null;
export declare function analyseRequires(
  files: string[],
  read: (file: string) => string,
  entryDirs?: string[]
): { missing: Array<{ name: string; requiredBy: string }>; reached: string[]; packed: string[] };
