// Decides what the page says, from the visitor's platform and the latest
// release. Pure: the output is plain data that render.js turns into DOM, so
// every wording and fallback decision is unit-tested here.
import { ARCH, DESKTOP_OSES, OS } from './platform.js';
import { ANY_ARCH, PACKAGE, classifyAssets, pickDownloads } from './release-assets.js';

// Always the LATEST release, never a pinned version: the API answers with the
// newest published, non-prerelease release, and GitHub redirects the page URL
// to that same release. Nothing on this site names a version, so publishing a
// release updates every button without redeploying the page.
export const LATEST_RELEASE_URL = 'https://github.com/Sarv/Inbox/releases/latest';
export const ALL_RELEASES_URL = 'https://github.com/Sarv/Inbox/releases';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/Sarv/Inbox/releases/latest';

export const VIEW = Object.freeze({
  // A desktop we have an installer for.
  DOWNLOAD: 'download',
  // A phone or tablet: there is no mobile app yet.
  MOBILE: 'mobile',
  // A desktop we ship nothing for (ChromeOS) or could not identify.
  UNSUPPORTED: 'unsupported',
  // GitHub could not be reached, or the release has no file for this OS.
  UNAVAILABLE: 'unavailable',
});

export const OS_NAME = Object.freeze({
  [OS.MAC]: 'macOS',
  [OS.WINDOWS]: 'Windows',
  [OS.LINUX]: 'Linux',
  [OS.IOS]: 'iOS',
  [OS.ANDROID]: 'Android',
  [OS.CHROMEOS]: 'ChromeOS',
  [OS.UNKNOWN]: 'your device',
});

const PACKAGE_NAME = Object.freeze({
  [PACKAGE.DMG]: 'Disk image (.dmg)',
  [PACKAGE.MAC_ZIP]: 'Zip archive (.zip)',
  [PACKAGE.EXE]: 'Installer (.exe)',
  [PACKAGE.APPIMAGE]: 'AppImage',
  [PACKAGE.DEB]: 'Debian / Ubuntu (.deb)',
  [PACKAGE.RPM]: 'Fedora / openSUSE (.rpm)',
});

// What a single file covering every architecture covers, per OS.
const ANY_ARCH_NAME = Object.freeze({
  [OS.MAC]: 'Apple Silicon and Intel',
  [OS.WINDOWS]: '64-bit Intel/AMD and ARM',
  [OS.LINUX]: 'All architectures',
});

const ARCH_NAME = Object.freeze({
  [ARCH.X64]: 'x64',
  [ARCH.ARM64]: 'ARM64',
});

const archName = (asset) =>
  asset.arch === ANY_ARCH ? ANY_ARCH_NAME[asset.os] : ARCH_NAME[asset.arch];

/** One download link, ready to show. `size` is bytes; render.js formats it. */
export const toLink = (asset) => ({
  url: asset.url,
  name: asset.name,
  label: PACKAGE_NAME[asset.kind],
  detail: archName(asset),
  size: asset.size,
});

// For "Other platforms": each desktop's best file, assuming the common
// architecture, plus the rest of its files.
const platformSections = (installables, excludeOs) =>
  DESKTOP_OSES.filter((os) => os !== excludeOs)
    .map((os) => {
      const { primary, alternatives } = pickDownloads(installables, { os, arch: ARCH.UNKNOWN });
      return {
        os,
        osName: OS_NAME[os],
        links: [primary, ...alternatives].filter(Boolean).map(toLink),
      };
    })
    .filter((section) => section.links.length > 0);

const releaseFacts = (release) => ({
  version: release.tag_name?.replace(/^v/, '') ?? null,
  publishedAt: release.published_at ?? null,
  notesUrl: release.html_url ?? LATEST_RELEASE_URL,
});

const viewKindFor = (os, primary) => {
  if (os === OS.IOS || os === OS.ANDROID) return VIEW.MOBILE;
  if (!DESKTOP_OSES.includes(os)) return VIEW.UNSUPPORTED;
  return primary ? VIEW.DOWNLOAD : VIEW.UNAVAILABLE;
};

/**
 * The page's content. `release` is GitHub's /releases/latest payload, or null
 * when it could not be fetched; the page then points at the Releases page
 * rather than showing nothing.
 */
export const buildDownloadView = ({ platform, release }) => {
  const osName = OS_NAME[platform.os];
  if (!release) {
    return {
      kind: VIEW.UNAVAILABLE,
      os: platform.os,
      osName,
      releasesUrl: LATEST_RELEASE_URL,
      reachedGitHub: false,
    };
  }

  const installables = classifyAssets(release.assets);
  const { primary, alternatives } = pickDownloads(installables, platform);
  const kind = viewKindFor(platform.os, primary);
  const isDownload = kind === VIEW.DOWNLOAD;

  return {
    kind,
    os: platform.os,
    osName,
    releasesUrl: LATEST_RELEASE_URL,
    reachedGitHub: true,
    ...releaseFacts(release),
    primary: isDownload ? toLink(primary) : null,
    alternatives: isDownload ? alternatives.map(toLink) : [],
    others: platformSections(installables, isDownload ? platform.os : null),
  };
};
