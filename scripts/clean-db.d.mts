import type { ProfileResetOptions, ResetProfileId } from './lib/profile-reset.mjs';
export function parseCleanupArgs(argv: string[]): { profiles: ResetProfileId[]; full: boolean; dryRun: boolean; help: boolean };
export function runCleanupCli(argv: string[], options?: ProfileResetOptions & { log?: (line: string) => void }): void;
