export declare const SMOKE_TEST_OK_MARKER: string;
export declare function smokeLaunchArgs(platform: string): string[];
export declare function reportedElectronVersion(text: string): string | null;
export declare function expectedElectronVersion(desktopPackageJson: { devDependencies?: Record<string, string> }): string;
export declare function evaluateSmokeRun(outcome: {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  markerText: string | null;
  timeoutMs: number;
  expectedElectron: string;
}): { ok: boolean; reason: string };
