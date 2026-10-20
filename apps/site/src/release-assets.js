// Turns a GitHub release's asset list into "the file this visitor should get".
// Pure: no fetch, no DOM. Asset names come from electron-builder's
// `artifactName` settings in apps/desktop/package.json, e.g.
//   sarv-inbox-1.2.2-mac-arm64-amd64.dmg   (universal macOS)
//   sarv-inbox-1.3.4-mac-arm64.zip / -mac-x64.zip  (per-arch, for auto-update;
//                                           one universal -mac-arm64-amd64.zip before)
//   Sarv-Inbox-Setup-1.3.2.exe             (one NSIS installer, x64 + arm64;
//                                           Sarv.Inbox.Setup.1.2.2.exe before 1.3.2)
//   sarv-inbox-1.2.2-x86_64.AppImage / -arm64.AppImage
//   sarv-inbox-1.2.2-amd64.deb / -arm64.deb
//   sarv-inbox-1.2.2-x86_64.rpm / -aarch64.rpm
import { ARCH, OS } from './platform.js';

export const PACKAGE = Object.freeze({
  DMG: 'dmg',
  MAC_ZIP: 'mac-zip',
  EXE: 'exe',
  APPIMAGE: 'appimage',
  DEB: 'deb',
  RPM: 'rpm',
});

// An asset that runs on every architecture its OS ships on (the universal dmg,
// the combined Windows installer).
export const ANY_ARCH = 'any';

// Most preferred first: the primary button offers the first one that exists.
const PACKAGE_PREFERENCE = Object.freeze({
  [OS.MAC]: [PACKAGE.DMG, PACKAGE.MAC_ZIP],
  [OS.WINDOWS]: [PACKAGE.EXE],
  [OS.LINUX]: [PACKAGE.APPIMAGE, PACKAGE.DEB, PACKAGE.RPM],
});

const ARM_NAME_TOKENS = Object.freeze(['arm64', 'aarch64']);
const X64_NAME_TOKENS = Object.freeze(['x86_64', 'amd64', 'x64']);

const extensionOf = (name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

// Splits on the separators electron-builder and GitHub put in asset names
// (GitHub turns spaces into dots), so "amd64" never matches inside a word.
const tokensOf = (name) => name.toLowerCase().split(/[-_.\s]+/);

const packageOf = (name) => {
  const extension = extensionOf(name);
  if (extension === 'dmg') return { os: OS.MAC, kind: PACKAGE.DMG };
  if (extension === 'zip' && tokensOf(name).includes('mac'))
    return { os: OS.MAC, kind: PACKAGE.MAC_ZIP };
  if (extension === 'exe') return { os: OS.WINDOWS, kind: PACKAGE.EXE };
  if (extension === 'appimage') return { os: OS.LINUX, kind: PACKAGE.APPIMAGE };
  if (extension === 'deb') return { os: OS.LINUX, kind: PACKAGE.DEB };
  if (extension === 'rpm') return { os: OS.LINUX, kind: PACKAGE.RPM };
  return null;
};

const archOf = (name) => {
  // `x86_64` survives tokenising as "x86" + "64", so match the joined form too.
  const lowered = name.toLowerCase();
  const tokens = tokensOf(name);
  const hasArm = ARM_NAME_TOKENS.some((token) => tokens.includes(token));
  const hasX64 =
    lowered.includes('x86_64') || X64_NAME_TOKENS.some((token) => tokens.includes(token));
  if (hasArm === hasX64) return ANY_ARCH;
  return hasArm ? ARCH.ARM64 : ARCH.X64;
};

/**
 * An installable asset as { os, kind, arch, name, url, size }, or null for
 * anything a person would not download (update manifests, blockmaps, source).
 */
export const classifyAsset = ({ name = '', browser_download_url: url, size = 0 } = {}) => {
  const found = packageOf(name);
  return found ? { ...found, arch: archOf(name), name, url, size } : null;
};

export const classifyAssets = (assets = []) => assets.map(classifyAsset).filter(Boolean);

// The architectures whose files RUN on this machine, best first. A known arch
// takes its own build over a universal one. An unknown arch (Safari on every
// Mac, most Windows browsers) takes the universal file first, since it runs
// whatever the CPU is; then x64, which most desktops run.
const archPreference = (arch) => {
  if (arch === ARCH.ARM64) return [ARCH.ARM64, ANY_ARCH];
  if (arch === ARCH.X64) return [ARCH.X64, ANY_ARCH];
  return [ANY_ARCH, ARCH.X64];
};

const rankOf = (list, value) => {
  const index = list.indexOf(value);
  return index === -1 ? list.length : index;
};

/**
 * Every installable asset for `os`, best match for `arch` first: files that
 * run on this machine before files for the other architecture; within those,
 * the preferred package (a Mac's .dmg over its .zip) before the architecture
 * fit, so a per-arch .zip never outranks a .dmg that runs here.
 */
export const rankAssetsFor = (installables, os, arch) => {
  const packages = PACKAGE_PREFERENCE[os] ?? [];
  const arches = archPreference(arch);
  const runsHere = (asset) => (arches.includes(asset.arch) ? 0 : 1);
  return installables
    .filter((asset) => asset.os === os)
    .toSorted(
      (left, right) =>
        runsHere(left) - runsHere(right) ||
        rankOf(packages, left.kind) - rankOf(packages, right.kind) ||
        rankOf(arches, left.arch) - rankOf(arches, right.arch)
    );
};

/** { primary, alternatives } for one platform; primary is null when nothing fits. */
export const pickDownloads = (installables, { os, arch }) => {
  const [primary = null, ...alternatives] = rankAssetsFor(installables, os, arch);
  return { primary, alternatives };
};
