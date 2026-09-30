// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { LATEST_RELEASE_URL, buildDownloadView } from '../src/download-view.js';
import { ARCH, OS } from '../src/platform.js';
import { formatDate, formatSize, renderDownloadPage } from '../src/render.js';

import { releaseV122 } from './fixtures.js';

let root;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"><p>loading</p></div>';
  root = document.getElementById('app');
});

const render = (os, arch = ARCH.UNKNOWN, release = releaseV122()) =>
  renderDownloadPage(root, buildDownloadView({ platform: { os, arch }, release }), 'en-US');
const text = (selector) => root.querySelector(selector)?.textContent;
const selectedOs = () => root.querySelector('.os-picker button[aria-pressed="true"]')?.textContent;
const primaryHref = () =>
  root.querySelector('.download-choice a.btn-primary')?.getAttribute('href');

describe('formatSize / formatDate', () => {
  // Breaks if release sizes and timestamps become hard to read.
  it('formats size and date for the reader', () => {
    expect(formatSize(261830599, 'en-US')).toBe('262 MB');
    expect(formatDate('2026-09-25T10:16:40Z', 'en-US')).toBe('Sep 25, 2026');
  });
});

describe('renderDownloadPage', () => {
  // Breaks if a Mac visitor stops getting the universal dmg as the first choice.
  it('selects the detected OS and links directly to its installer', () => {
    render(OS.MAC, ARCH.ARM64);
    expect(selectedOs()).toBe('macOS');
    expect(primaryHref()).toBe(
      'https://github.com/Sarv/Inbox/releases/download/v1.2.2/sarv-inbox-1.2.2-mac-arm64-amd64.dmg'
    );
    expect(text('.download-choice')).toContain(
      'Disk image (.dmg) · Apple Silicon and Intel · 262 MB'
    );
    expect(root.textContent).not.toContain('loading');
  });

  // Breaks if a bad detection leaves visitors stuck with the wrong OS download.
  it('lets visitors switch OS and updates the download and pressed state', () => {
    render(OS.MAC);
    root.querySelector('button[data-os="windows"]').click();
    expect(selectedOs()).toBe('Windows');
    expect(primaryHref()).toContain('Sarv.Inbox.Setup.1.2.2.exe');
    expect(root.querySelector('button[data-os="mac"]').getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelectorAll('#download-choice')).toHaveLength(1);
  });

  // Breaks if Linux users lose the distro packages or cannot tell their architecture.
  it('shows Linux formats and architectures without another disclosure', () => {
    render(OS.LINUX, ARCH.X64);
    expect(primaryHref()).toContain('x86_64.AppImage');
    expect(root.querySelectorAll('.download-alt li')).toHaveLength(5);
    expect(text('.download-alt')).toContain('Debian / Ubuntu (.deb)');
    expect(text('.download-alt')).toContain('Fedora / openSUSE (.rpm)');
    expect(text('.download-alt')).toContain('ARM64');
  });

  // Breaks if the release details no longer match the installer on the page.
  it('shows the version, date and release notes', () => {
    render(OS.WINDOWS);
    expect(text('.release-version')).toBe('Version 1.2.2');
    expect(text('.release-line')).toContain('Released Sep 25, 2026');
    expect(root.querySelector('.release-line a').getAttribute('href')).toBe(
      'https://github.com/Sarv/Inbox/releases/tag/v1.2.2'
    );
  });

  // Breaks if missing optional release fields render misleading metadata.
  it('omits missing version and date', () => {
    render(OS.WINDOWS, ARCH.X64, {
      ...releaseV122(),
      tag_name: undefined,
      published_at: undefined,
    });
    expect(root.querySelector('.release-line')).toBeNull();
  });

  // Breaks if a phone is told that a desktop installer will run on it.
  it('explains mobile support while leaving computer choices available', () => {
    render(OS.IOS);
    expect(text('.download-note')).toContain('There is no iOS app yet');
    expect(root.querySelectorAll('.os-picker button')).toHaveLength(3);
    expect(selectedOs()).toBe('macOS');
    expect(text('.download-choice')).toContain('macOS download');
    render(OS.IOS, ARCH.UNKNOWN, null);
    expect(text('.download-note')).toContain('There is no iOS app yet');
  });

  // Breaks if an unrecognised device receives a guessed platform without a choice.
  it('asks unsupported devices to choose a platform', () => {
    render(OS.CHROMEOS);
    expect(text('.download-note')).toContain('ChromeOS');
    expect(root.querySelectorAll('.os-picker button')).toHaveLength(3);
  });

  // Breaks if API failure makes every download control disappear.
  it('links to GitHub releases when the API cannot be reached', () => {
    render(OS.MAC, ARCH.ARM64, null);
    expect(text('.banner')).toBe("Couldn't reach GitHub to find the latest release.");
    expect(primaryHref()).toBe(LATEST_RELEASE_URL);
    root.querySelector('button[data-os="linux"]').click();
    expect(primaryHref()).toBe(LATEST_RELEASE_URL);
  });

  // Breaks if one missing release asset is mistaken for a network outage.
  it('explains a missing OS asset while other platforms still work', () => {
    const release = releaseV122();
    release.assets = release.assets.filter(
      (asset) => !asset.name.endsWith('.dmg') && !asset.name.endsWith('.zip')
    );
    render(OS.MAC, ARCH.X64, release);
    expect(text('.banner')).toBe('The latest release has no macOS installer.');
    root.querySelector('button[data-os="windows"]').click();
    expect(primaryHref()).toContain('.exe');
  });

  // Breaks if a zero-size asset is displayed as a real 0 MB download.
  it('omits a missing file size', () => {
    const release = releaseV122();
    release.assets = [
      { name: 'Sarv.Inbox.Setup.9.exe', size: 0, browser_download_url: 'https://x' },
    ];
    render(OS.WINDOWS, ARCH.X64, release);
    expect(text('.download-choice')).not.toContain('MB');
  });

  // Breaks if API-provided asset text is ever interpreted as page markup.
  it('does not parse release data as HTML', () => {
    const release = releaseV122();
    release.assets = [
      { name: '<img src=x onerror=alert(1)>.dmg', size: 1, browser_download_url: 'https://x' },
    ];
    render(OS.MAC, ARCH.X64, release);
    expect(root.querySelector('img')).toBeNull();
  });

  // Breaks if a decorative glyph adds noise to a screen reader's download label.
  it('keeps download glyphs decorative', () => {
    render(OS.LINUX, ARCH.X64);
    const icons = [...root.querySelectorAll('a.btn svg')];
    expect(icons.length).toBeGreaterThan(1);
    icons.forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
  });
});
