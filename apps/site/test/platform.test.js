import { describe, expect, it } from 'vitest';

import {
  ARCH,
  OS,
  archFromHints,
  archFromUserAgent,
  detectOs,
  detectPlatform,
} from '../src/platform.js';

import { UA } from './fixtures.js';

describe('detectOs', () => {
  // Breaks if a desktop visitor is offered the wrong OS's installer (or none).
  it.each([
    ['macChrome', OS.MAC],
    ['macSafari', OS.MAC],
    ['windowsChrome', OS.WINDOWS],
    ['windowsFirefox', OS.WINDOWS],
    ['linuxX64Firefox', OS.LINUX],
    ['ubuntuFirefox', OS.LINUX],
    ['linuxArmFirefox', OS.LINUX],
    ['iphone', OS.IOS],
    ['android', OS.ANDROID],
    ['chromeOs', OS.CHROMEOS],
    ['bot', OS.UNKNOWN],
  ])('%s -> %s', (key, expected) => {
    expect(detectOs({ userAgent: UA[key] })).toBe(expected);
  });

  // Breaks if an iPad (which sends a desktop-Mac user agent) is offered a .dmg.
  it('treats a touchscreen "Mac" as an iPad', () => {
    expect(detectOs({ userAgent: UA.macSafari, maxTouchPoints: 5 })).toBe(OS.IOS);
  });

  // Breaks if a trackpad Mac reporting one touch point is mistaken for an iPad.
  it('keeps a Mac with maxTouchPoints 1 or 0 a Mac', () => {
    expect(detectOs({ userAgent: UA.macSafari, maxTouchPoints: 1 })).toBe(OS.MAC);
    expect(detectOs({ userAgent: UA.macSafari })).toBe(OS.MAC);
  });

  // Breaks if a missing user agent throws instead of falling back to "unknown".
  it('returns unknown for no input', () => {
    expect(detectOs()).toBe(OS.UNKNOWN);
    expect(detectOs({ userAgent: '' })).toBe(OS.UNKNOWN);
  });
});

describe('archFromHints', () => {
  // Breaks if Windows-on-ARM / ARM Linux Chromium users get the x64 build.
  it('reads arm and 64-bit x86', () => {
    expect(archFromHints({ architecture: 'arm', bitness: '64' })).toBe(ARCH.ARM64);
    expect(archFromHints({ architecture: 'x86', bitness: '64' })).toBe(ARCH.X64);
  });

  // Breaks if 32-bit x86 (which we don't ship) is mistaken for x64, or empty hints crash.
  it('is unknown for 32-bit, empty or missing hints', () => {
    expect(archFromHints({ architecture: 'x86', bitness: '32' })).toBe(ARCH.UNKNOWN);
    expect(archFromHints({ architecture: '', bitness: '' })).toBe(ARCH.UNKNOWN);
    expect(archFromHints(null)).toBe(ARCH.UNKNOWN);
    expect(archFromHints(undefined)).toBe(ARCH.UNKNOWN);
  });
});

describe('archFromUserAgent', () => {
  // Breaks if Firefox on ARM Linux (no client hints) is offered the x64 AppImage.
  it('reads the architecture Linux browsers still report', () => {
    expect(archFromUserAgent(UA.linuxArmFirefox)).toBe(ARCH.ARM64);
    expect(archFromUserAgent(UA.linuxX64Firefox)).toBe(ARCH.X64);
    expect(archFromUserAgent(UA.windowsFirefox)).toBe(ARCH.X64);
  });

  // Breaks if a user agent with no architecture is guessed rather than left unknown.
  it('is unknown when the user agent names none', () => {
    expect(archFromUserAgent(UA.macSafari)).toBe(ARCH.UNKNOWN);
    expect(archFromUserAgent(UA.linuxNoArch)).toBe(ARCH.UNKNOWN);
    expect(archFromUserAgent()).toBe(ARCH.UNKNOWN);
  });
});

describe('detectPlatform', () => {
  // Breaks if the frozen "Win64; x64" user agent overrides Chrome's real ARM hint.
  it('prefers client hints over the frozen user agent', () => {
    expect(
      detectPlatform({ userAgent: UA.windowsChrome, hints: { architecture: 'arm', bitness: '64' } })
    ).toEqual({
      os: OS.WINDOWS,
      arch: ARCH.ARM64,
    });
  });

  // Breaks if browsers without client hints (Firefox, Safari) lose the UA fallback.
  it('falls back to the user agent without hints', () => {
    expect(detectPlatform({ userAgent: UA.linuxArmFirefox })).toEqual({
      os: OS.LINUX,
      arch: ARCH.ARM64,
    });
    expect(detectPlatform({ userAgent: UA.linuxX64Firefox, hints: {} })).toEqual({
      os: OS.LINUX,
      arch: ARCH.X64,
    });
  });

  // Breaks if calling with nothing throws.
  it('handles no input', () => {
    expect(detectPlatform()).toEqual({ os: OS.UNKNOWN, arch: ARCH.UNKNOWN });
  });
});
