export declare const OPTIONAL_PEERS_LEFT_OUT: Readonly<Record<string, readonly string[]>>;
export declare function packageNameOf(specifier: string): string;
export declare function isRuntimeProvided(specifier: string): boolean;
export declare function requiredPackagesOf(source: string): string[];
export declare function unresolvedPeersOf(
  source: string,
  leftOut?: Readonly<Record<string, readonly string[]>>
): Array<{ name: string; importer: string }>;
export declare function owningPackageOf(file: string): string | null;
export declare function analyseRequires(
  files: string[],
  read: (file: string) => string,
  entryDirs?: string[]
): {
  missing: Array<{ name: string; requiredBy: string }>;
  unresolved: Array<{ name: string; importer: string; file: string }>;
  reached: string[];
  packed: string[];
};
