import { describe, expect, it } from 'vitest';

import { osSandboxRefusal, readOsSandboxState, type OsSandboxProbe } from '../../../../electron/services/os-sandbox-state';

/**
 * Whether extension code may start at all in a release build hangs on this answer.
 * Answering `active` when it is not is extension code with the user's whole account
 * one Chromium bug away; every doubtful case therefore has to come out as not active.
 */

const probe = (overrides: Partial<OsSandboxProbe>): OsSandboxProbe => ({
  platform: 'darwin',
  pid: 1,
  noSandboxSwitch: false,
  metricSandboxed: () => true,
  ...overrides,
});

describe('readOsSandboxState', () => {
  // `webPreferences.sandbox` keeps reading true under this switch, so it is checked first.
  it.each(['darwin', 'win32', 'linux'] as const)('is off on %s when --no-sandbox was passed', (platform) => {
    expect(
      readOsSandboxState(probe({ platform, noSandboxSwitch: true, readProcStatus: () => 'Seccomp:\t2\n' }))
    ).toBe('off');
  });

  it.each(['darwin', 'win32'] as const)('reads the process metric on %s', (platform) => {
    expect(readOsSandboxState(probe({ platform, metricSandboxed: () => true }))).toBe('active');
    expect(readOsSandboxState(probe({ platform, metricSandboxed: () => false }))).toBe('off');
    expect(readOsSandboxState(probe({ platform, metricSandboxed: () => undefined }))).toBe('unknown');
  });

  // Electron leaves `sandboxed` undefined on Linux, so the metric cannot be what says
  // yes there: the kernel's view of the process is. Seccomp 2 is the filter mode.
  it('reads seccomp mode 2 as active on Linux, whatever the metric says', () => {
    const status = 'Name:\tchrome\nUid:\t1000\nSeccomp:\t2\nSeccomp_filters:\t3\n';
    expect(
      readOsSandboxState(probe({ platform: 'linux', metricSandboxed: () => undefined, readProcStatus: () => status }))
    ).toBe('active');
  });

  // A renderer on Linux with no sandbox: mode 0. The case this whole check is for.
  it('reads seccomp mode 0 as off on Linux', () => {
    expect(readOsSandboxState(probe({ platform: 'linux', readProcStatus: () => 'Seccomp:\t0\n' }))).toBe('off');
  });

  // Strict mode is not what Chromium's sandbox is, and a process could not run under it.
  it('reads any other mode as off on Linux', () => {
    expect(readOsSandboxState(probe({ platform: 'linux', readProcStatus: () => 'Seccomp:\t1\n' }))).toBe('off');
  });

  // A kernel without the field, or a /proc that cannot be read, cannot say yes.
  it('is unknown on Linux when the kernel says nothing', () => {
    expect(readOsSandboxState(probe({ platform: 'linux', readProcStatus: () => 'Name:\tchrome\n' }))).toBe('unknown');
    expect(
      readOsSandboxState(
        probe({
          platform: 'linux',
          readProcStatus: () => {
            throw new Error('EACCES');
          },
        })
      )
    ).toBe('unknown');
  });

  // Reads the real /proc path by default, which fails on this platform and must fail safe.
  it('fails to unknown with the default reader when there is no such process', () => {
    expect(readOsSandboxState(probe({ platform: 'linux', pid: 999_999_999 }))).toBe('unknown');
  });
});

describe('osSandboxRefusal', () => {
  // electron-builder's AppRun adds --no-sandbox by itself on Ubuntu 24.04 and later, where
  // AppArmor restricts user namespaces, so "remove --no-sandbox" would be useless advice:
  // the user never passed it. Only the packages install the profile that fixes this.
  it('tells an AppImage user the one thing that helps', () => {
    const message = osSandboxRefusal({ platform: 'linux', appImage: true });
    expect(message).toContain('AppImage');
    expect(message).toContain('.deb or .rpm');
    expect(message).not.toContain('--no-sandbox');
  });

  it('tells a Linux user about the switch and the packages', () => {
    const message = osSandboxRefusal({ platform: 'linux', appImage: false });
    expect(message).toContain('--no-sandbox');
    expect(message).toContain('.deb or .rpm');
  });

  // No packages to suggest there, and no AppImage to blame.
  it.each(['darwin', 'win32'] as const)('tells a %s user about the switch alone', (platform) => {
    const message = osSandboxRefusal({ platform, appImage: false });
    expect(message).toContain('--no-sandbox');
    expect(message).not.toContain('.deb');
  });

  // LIMITS.body in ui-notification.ts: longer is silently cut off on the card.
  it.each([
    { platform: 'linux' as const, appImage: true },
    { platform: 'linux' as const, appImage: false },
    { platform: 'win32' as const, appImage: false },
  ])('fits on a card: %j', (where) => {
    expect(osSandboxRefusal(where).length).toBeLessThanOrEqual(240);
  });
});
