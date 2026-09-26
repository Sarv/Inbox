// Works out which device the visitor is on, from what the browser reports.
// Pure: every function takes the browser's values as arguments, so the whole
// decision is testable without a browser. main.js is the only caller that
// reads `navigator`.
import Bowser from 'bowser';

export const OS = Object.freeze({
  MAC: 'mac',
  WINDOWS: 'windows',
  LINUX: 'linux',
  IOS: 'ios',
  ANDROID: 'android',
  CHROMEOS: 'chromeos',
  UNKNOWN: 'unknown',
});

export const ARCH = Object.freeze({
  ARM64: 'arm64',
  X64: 'x64',
  UNKNOWN: 'unknown',
});

export const DESKTOP_OSES = Object.freeze([OS.MAC, OS.WINDOWS, OS.LINUX]);

const OS_BY_BOWSER_NAME = Object.freeze({
  [Bowser.OS_MAP.MacOS]: OS.MAC,
  [Bowser.OS_MAP.Windows]: OS.WINDOWS,
  [Bowser.OS_MAP.Linux]: OS.LINUX,
  [Bowser.OS_MAP.iOS]: OS.IOS,
  [Bowser.OS_MAP.Android]: OS.ANDROID,
  [Bowser.OS_MAP.ChromeOS]: OS.CHROMEOS,
});

// Architecture words as they appear in user-agent strings. Only Linux browsers
// still put a real one there: Chrome freezes Windows at "Win64; x64" even on
// ARM, and Safari reports "Intel" on Apple Silicon.
const ARM_UA_TOKENS = Object.freeze(['aarch64', 'arm64', 'armv8']);
const X64_UA_TOKENS = Object.freeze(['x86_64', 'amd64', 'x64', 'win64', 'wow64']);

/**
 * The OS from a user-agent string. iPadOS 13+ sends a desktop-Mac user agent,
 * so a "Mac" with a touchscreen is an iPad.
 */
export const detectOs = ({ userAgent = '', maxTouchPoints = 0 } = {}) => {
  // Bowser throws on an empty string; a browser that sends none is unknown.
  if (!userAgent) return OS.UNKNOWN;
  const bowserName = Bowser.parse(userAgent).os.name;
  const os = OS_BY_BOWSER_NAME[bowserName] ?? OS.UNKNOWN;
  return os === OS.MAC && maxTouchPoints > 1 ? OS.IOS : os;
};

/** The architecture from User-Agent Client Hints (Chromium only). */
export const archFromHints = (hints) => {
  if (hints?.architecture === 'arm') return ARCH.ARM64;
  if (hints?.architecture === 'x86' && hints.bitness === '64') return ARCH.X64;
  return ARCH.UNKNOWN;
};

/** The architecture from a user-agent string, when it still carries one. */
export const archFromUserAgent = (userAgent = '') => {
  const lowered = userAgent.toLowerCase();
  if (ARM_UA_TOKENS.some((token) => lowered.includes(token))) return ARCH.ARM64;
  if (X64_UA_TOKENS.some((token) => lowered.includes(token))) return ARCH.X64;
  return ARCH.UNKNOWN;
};

/**
 * The visitor's platform. Client hints win over the user-agent string because
 * they are the only source that is not frozen or spoofed for compatibility.
 */
export const detectPlatform = ({ userAgent = '', maxTouchPoints = 0, hints = null } = {}) => {
  const fromHints = archFromHints(hints);
  return {
    os: detectOs({ userAgent, maxTouchPoints }),
    arch: fromHints === ARCH.UNKNOWN ? archFromUserAgent(userAgent) : fromHints,
  };
};
