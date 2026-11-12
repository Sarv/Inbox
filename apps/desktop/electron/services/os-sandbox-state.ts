/**
 * Whether a renderer really is inside the operating system's sandbox.
 *
 * `sandbox: true` in `webPreferences` is a request, and on its own it says nothing:
 * `--no-sandbox` (a dev run, or a user on a Linux with no working sandbox) turns
 * the OS layer off and leaves that preference reading true. Without that layer a
 * bug in Chromium hands an extension everything the user can touch. So it is read
 * from the running process:
 *
 *   - macOS and Windows report it in `app.getAppMetrics()`;
 *   - Linux does not, but the kernel does: a sandboxed Chromium renderer is under
 *     a seccomp-BPF filter, `Seccomp: 2` in `/proc/<pid>/status`, whichever of
 *     user namespaces or the setuid helper put it there.
 */
import { readFileSync } from 'fs';

export type OsSandboxState = 'active' | 'off' | 'unknown';

export interface OsSandboxProbe {
  platform: NodeJS.Platform;
  /** The renderer's process id, from `webContents.getOSProcessId()`. */
  pid: number;
  /** Whether the app was started with `--no-sandbox`. */
  noSandboxSwitch: boolean;
  /** `app.getAppMetrics()`: the `sandboxed` field for this process. */
  metricSandboxed(pid: number): boolean | undefined;
  /** Test seam for reading `/proc`. */
  readProcStatus?(pid: number): string;
}

const defaultReadProcStatus = (pid: number): string => readFileSync(`/proc/${pid}/status`, 'utf8');

/** The value of the `Seccomp:` line of `/proc/<pid>/status`, or null if it has none. */
function seccompMode(status: string): string | null {
  for (const line of status.split('\n')) {
    if (line.startsWith('Seccomp:')) return line.slice('Seccomp:'.length).trim();
  }
  return null;
}

/** Fails to `unknown`, never to `active`: the caller refuses on anything but `active`. */
export function readOsSandboxState(probe: OsSandboxProbe): OsSandboxState {
  if (probe.noSandboxSwitch) return 'off';

  if (probe.platform === 'linux') {
    try {
      const mode = seccompMode((probe.readProcStatus ?? defaultReadProcStatus)(probe.pid));
      if (mode === '2') return 'active';
      return mode === null ? 'unknown' : 'off';
    } catch {
      return 'unknown';
    }
  }

  const sandboxed = probe.metricSandboxed(probe.pid);
  if (sandboxed === undefined) return 'unknown';
  return sandboxed ? 'active' : 'off';
}

/**
 * What the user reads when extensions are held back for this.
 *
 * electron-builder's AppRun tests `unshare -Ur true` and adds `--no-sandbox` itself when
 * that fails, which is every AppImage on Ubuntu 24.04 or later, where AppArmor restricts
 * user namespaces. Nothing the user can pass changes that, and only the packages install
 * the AppArmor profile that lets the sandbox run, so that is the advice worth giving.
 */
export function osSandboxRefusal(where: { platform: NodeJS.Platform; appImage: boolean }): string {
  if (where.platform === 'linux' && where.appImage) {
    return (
      'Extensions are off because this system does not let an AppImage use the sandbox they ' +
      'run in, as on Ubuntu 24.04 and later. Install the .deb or .rpm package to use them.'
    );
  }
  if (where.platform === 'linux') {
    return (
      'Extensions are off because the operating system sandbox they run in is not available. ' +
      'Remove --no-sandbox if you started the app with it, or install the .deb or .rpm package.'
    );
  }
  return (
    'Extensions are off because the operating system sandbox they run in is not available. ' +
    'Remove --no-sandbox if you started the app with it.'
  );
}
