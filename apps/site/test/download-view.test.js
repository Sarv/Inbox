import { describe, expect, it } from 'vitest';

import { LATEST_RELEASE_URL, VIEW, buildDownloadView, toLink } from '../src/download-view.js';
import { ARCH, OS } from '../src/platform.js';
import { classifyAsset } from '../src/release-assets.js';

import { releaseV122 } from './fixtures.js';

const view = (os, arch = ARCH.UNKNOWN, release = releaseV122()) =>
  buildDownloadView({ platform: { os, arch }, release });
const sectionNames = (built) => built.others.map((section) => section.osName);

describe('buildDownloadView', () => {
  // Breaks if a Mac visitor stops getting a one-click .dmg download.
  it('macOS: primary dmg, zip alternative, other platforms are Windows and Linux', () => {
    const built = view(OS.MAC, ARCH.ARM64);
    expect(built.kind).toBe(VIEW.DOWNLOAD);
    expect(built.osName).toBe('macOS');
    expect(built.primary).toEqual({
      url: 'https://github.com/Sarv/Inbox/releases/download/v1.2.2/sarv-inbox-1.2.2-mac-arm64-amd64.dmg',
      name: 'sarv-inbox-1.2.2-mac-arm64-amd64.dmg',
      label: 'Disk image (.dmg)',
      detail: 'Apple Silicon and Intel',
      size: 261830599,
    });
    expect(built.alternatives.map((link) => link.label)).toEqual(['Zip archive (.zip)']);
    expect(sectionNames(built)).toEqual(['Windows', 'Linux']);
  });

  // Breaks if the version/date/notes line stops tracking the release it was given.
  it('carries the release version, date and notes link', () => {
    expect(view(OS.WINDOWS)).toMatchObject({
      version: '1.2.2',
      publishedAt: '2026-09-25T10:16:40Z',
      notesUrl: 'https://github.com/Sarv/Inbox/releases/tag/v1.2.2',
      releasesUrl: LATEST_RELEASE_URL,
      reachedGitHub: true,
    });
  });

  // Breaks if a release missing optional fields renders "vundefined" or a dead link.
  it('tolerates a release without tag, date or page URL', () => {
    const built = view(OS.WINDOWS, ARCH.X64, { assets: releaseV122().assets });
    expect(built).toMatchObject({ version: null, publishedAt: null, notesUrl: LATEST_RELEASE_URL });
  });

  // Breaks if x64 Linux loses the deb/rpm choice or gets ARM first.
  it('Linux x64: AppImage primary, x64 packages before ARM ones', () => {
    const built = view(OS.LINUX, ARCH.X64);
    expect(built.primary).toMatchObject({ label: 'AppImage', detail: 'x64' });
    expect(built.alternatives.map((link) => `${link.label} ${link.detail}`)).toEqual([
      'Debian / Ubuntu (.deb) x64',
      'Fedora / openSUSE (.rpm) x64',
      'AppImage ARM64',
      'Debian / Ubuntu (.deb) ARM64',
      'Fedora / openSUSE (.rpm) ARM64',
    ]);
  });

  // Breaks if a phone visitor is offered a desktop installer as if it would work.
  it.each([OS.IOS, OS.ANDROID])('%s: mobile view with every desktop listed', (os) => {
    const built = view(os);
    expect(built.kind).toBe(VIEW.MOBILE);
    expect(built.primary).toBeNull();
    expect(built.alternatives).toEqual([]);
    expect(sectionNames(built)).toEqual(['macOS', 'Windows', 'Linux']);
  });

  // Breaks if ChromeOS or an unrecognised browser gets a guessed installer instead of the full list.
  it.each([OS.CHROMEOS, OS.UNKNOWN])('%s: unsupported view with every desktop listed', (os) => {
    const built = view(os);
    expect(built.kind).toBe(VIEW.UNSUPPORTED);
    expect(sectionNames(built)).toEqual(['macOS', 'Windows', 'Linux']);
  });

  // Breaks if GitHub being down leaves a blank page instead of a link to the latest release.
  it('no release fetched: unavailable, pointing at the latest release page', () => {
    expect(buildDownloadView({ platform: { os: OS.MAC, arch: ARCH.X64 }, release: null })).toEqual({
      kind: VIEW.UNAVAILABLE,
      os: OS.MAC,
      osName: 'macOS',
      releasesUrl: LATEST_RELEASE_URL,
      reachedGitHub: false,
    });
  });

  // Breaks if a release that skipped one OS (a failed runner) shows an empty button for it.
  it('release without files for this OS: unavailable, others still listed', () => {
    const release = releaseV122();
    release.assets = release.assets.filter((asset) => !asset.name.endsWith('.exe'));
    const built = view(OS.WINDOWS, ARCH.X64, release);
    expect(built.kind).toBe(VIEW.UNAVAILABLE);
    expect(built.reachedGitHub).toBe(true);
    expect(built.primary).toBeNull();
    expect(sectionNames(built)).toEqual(['macOS', 'Linux']);
  });

  // Breaks if a release with no installers at all produces empty "Other platforms" sections.
  it('drops platforms that have no files', () => {
    expect(view(OS.MAC, ARCH.X64, { ...releaseV122(), assets: [] }).others).toEqual([]);
  });
});

describe('toLink', () => {
  // Breaks if the combined Windows installer stops saying it covers ARM too.
  it('names what a universal file covers per OS', () => {
    const exe = classifyAsset({
      name: 'Sarv.Inbox.Setup.1.2.2.exe',
      size: 5,
      browser_download_url: 'u',
    });
    expect(toLink(exe).detail).toBe('64-bit Intel/AMD and ARM');
  });
});
