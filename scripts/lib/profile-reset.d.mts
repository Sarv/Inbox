export type ResetProfileId = 'production' | 'development';
export interface ProfileProcess { pid: number; command: string }
export interface ProfileResetOptions {
  /** Trusted Electron appData or CLI OS appData only. Never renderer input. */
  baseDir?: string;
  /** Only trusted main-process reset code may ignore its own process. */
  ignorePid?: number;
  /** Trusted dependency injection for scratch-profile tests. */
  readProcesses?: () => ProfileProcess[] | null;
  isPidAlive?: (pid: number) => boolean | null;
}
export interface ResetProfileStatus { id: ResetProfileId; label: string; dir: string; exists: boolean; running: boolean; blockedReason?: string }
export interface ResetProfileResult { profile: ResetProfileId; dir: string; removed: boolean }
export class ProfileResetError extends Error { code: string }
export function getResetProfiles(options?: ProfileResetOptions): ResetProfileStatus[];
export function assertNoProfileReset(options: ProfileResetOptions & { profile: ResetProfileId }): void;
export function eraseProfile(options: ProfileResetOptions & { profile: ResetProfileId }): ResetProfileResult;
export function eraseProfiles(options: ProfileResetOptions & { profiles: ResetProfileId[] }): ResetProfileResult[];
export function planProfileCleanup(options: { profile: ResetProfileId; baseDir?: string; full?: boolean }): string[];
export function cleanProfileCaches(options: ProfileResetOptions & ({ profile: ResetProfileId } | { profiles: ResetProfileId[] })): Array<{ profile: ResetProfileId; dir: string; removed: string[] }>;
