export declare const SMOKE_TEST_OK_MARKER: string;
export declare function smokeLaunchArgs(platform: string): string[];
export declare function evaluateSmokeRun(outcome: {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  markerFileFound: boolean;
  timeoutMs: number;
}): { ok: boolean; reason: string };
