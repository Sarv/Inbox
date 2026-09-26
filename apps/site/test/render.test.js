// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { ALL_RELEASES_URL, LATEST_RELEASE_URL, buildDownloadView } from '../src/download-view.js';
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
const hrefs = (selector) =>
  [...root.querySelectorAll(selector)].map((node) => node.getAttribute('href'));

describe('formatSize / formatDate', () => {
  // Breaks if sizes stop reading as whole megabytes.
  it('formats megabytes', () => {
    expect(formatSize(261830599, 'en-US')).toBe('262 MB');
  });

  // Breaks if the stored UTC timestamp is shown raw instead of as a local date.
  it('formats a UTC timestamp as a local date', () => {
    expect(formatDate('2026-09-25T10:16:40Z', 'en-US')).toBe('Sep 25, 2026');
  });
});

describe('renderDownloadPage', () => {
  // Breaks if a Mac visitor's primary button stops linking straight to the dmg.
  it('download view: primary button links to the installer', () => {
    render(OS.MAC, ARCH.ARM64);
    expect(text('h1')).toBe('Download Sarv Inbox for macOS');
    const primary = root.querySelector('a.btn-primary');
    expect(primary.getAttribute('href')).toBe(
      'https://github.com/Sarv/Inbox/releases/download/v1.2.2/sarv-inbox-1.2.2-mac-arm64-amd64.dmg'
    );
    expect(primary.textContent).toBe('Download for macOS');
    expect(root.textContent).toContain('Disk image (.dmg) · Apple Silicon and Intel · 262 MB');
  });

  // Breaks if the "loading" placeholder is left behind next to the content.
  it('replaces the placeholder', () => {
    render(OS.MAC);
    expect(root.textContent).not.toContain('loading');
  });

  // Breaks if visitors can't see which release they are getting.
  it('shows the latest version, local date and release notes', () => {
    render(OS.WINDOWS);
    expect(text('.badge')).toBe('Latest release');
    expect(text('.release-version')).toBe('Version 1.2.2');
    expect(root.textContent).toContain('Released Sep 25, 2026');
    expect(hrefs('.release-line a')).toEqual(['https://github.com/Sarv/Inbox/releases/tag/v1.2.2']);
  });

  // Breaks if the release line renders with a missing date or version.
  it('omits the date when the release has none, and the whole line with no version', () => {
    render(OS.WINDOWS, ARCH.X64, { ...releaseV122(), published_at: undefined });
    expect(root.textContent).not.toContain('Released');
    render(OS.WINDOWS, ARCH.X64, { ...releaseV122(), tag_name: undefined });
    expect(root.querySelector('.release-line')).toBeNull();
  });

  // Breaks if Linux users lose the .deb/.rpm choices.
  it('lists alternatives for the same OS', () => {
    render(OS.LINUX, ARCH.X64);
    expect(text('section.card h2')).toBe('Other Linux downloads');
    expect(root.querySelectorAll('section.card')[0].querySelectorAll('li')).toHaveLength(5);
  });

  // Breaks if the other platforms are built into the page before anyone asks for them.
  it('download view: other platforms start collapsed and unbuilt', () => {
    render(OS.WINDOWS);
    const toggle = root.querySelector('button.others-toggle');
    expect(toggle.textContent).toBe('Show other platforms');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('other-platforms');
    expect(root.querySelector('#other-platforms')).toBeNull();
    expect(root.querySelectorAll('.platform-title')).toHaveLength(0);
  });

  // Breaks if people on the wrong detected OS can't reach the other installers.
  it('download view: the toggle reveals the other platforms, without the detected one', () => {
    render(OS.WINDOWS);
    root.querySelector('button.others-toggle').click();
    const titles = [...root.querySelectorAll('.platform-title')].map((node) => node.textContent);
    expect(titles).toEqual(['macOS', 'Linux']);
    expect(text('#other-platforms h2')).toBe('Other platforms');
    expect(root.querySelector('#other-platforms').hidden).toBe(false);
    // Windows has no alternatives, so there is no "Other Windows downloads" card.
    expect(root.textContent).not.toContain('Other Windows downloads');
  });

  // Breaks if the toggle can't close the list again, or rebuilds a second copy on reopen.
  it('download view: the toggle hides and re-shows the same list', () => {
    render(OS.WINDOWS);
    const toggle = root.querySelector('button.others-toggle');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide other platforms');
    toggle.click();
    expect(root.querySelector('#other-platforms').hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show other platforms');
    toggle.click();
    expect(root.querySelectorAll('#other-platforms')).toHaveLength(1);
    expect(root.querySelector('#other-platforms').hidden).toBe(false);
  });

  // Breaks if the download buttons lose their icon, or it becomes readable noise for screen readers.
  it('download buttons carry a decorative download icon', () => {
    render(OS.LINUX, ARCH.X64);
    const buttons = [...root.querySelectorAll('a.btn')];
    expect(buttons.length).toBeGreaterThan(1);
    buttons.forEach((button) => {
      const svg = button.querySelector('svg');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.querySelector('path').getAttribute('d')).toBe('M12 4v12M6 10l6 6 6-6M4 20h16');
    });
    expect(root.querySelector('a.btn-primary svg').getAttribute('width')).toBe('18');
  });

  // Breaks if a phone gets a download button for a desktop installer.
  it('mobile view: explains, no primary button, all desktops listed', () => {
    render(OS.IOS);
    expect(text('h1')).toBe('Sarv Inbox is a desktop app');
    expect(root.textContent).toContain('There is no iOS app yet');
    expect(root.querySelector('a.btn-primary')).toBeNull();
    expect(root.textContent).toContain('All downloads');
    expect(root.querySelectorAll('.platform-title')).toHaveLength(3);
  });

  // Breaks if an unrecognised device gets a guessed installer.
  it('unsupported view: explains and lists all desktops', () => {
    render(OS.CHROMEOS);
    expect(text('h1')).toBe('Download Sarv Inbox');
    expect(root.textContent).toContain("couldn't match ChromeOS");
    expect(root.querySelectorAll('.platform-title')).toHaveLength(3);
  });

  // Breaks if GitHub being unreachable leaves no way to download.
  it('unavailable (GitHub unreachable): banner and a link to the latest release', () => {
    renderDownloadPage(
      root,
      buildDownloadView({ platform: { os: OS.MAC, arch: ARCH.X64 }, release: null }),
      'en-US'
    );
    expect(text('.banner')).toBe("Couldn't reach GitHub to find the latest release.");
    expect(root.querySelector('a.btn-primary').getAttribute('href')).toBe(LATEST_RELEASE_URL);
    expect(root.querySelector('.release-line')).toBeNull();
  });

  // Breaks if a release missing this OS's file shows a misleading "couldn't reach GitHub".
  it('unavailable (no file for this OS): says the release has none', () => {
    const release = releaseV122();
    release.assets = release.assets.filter(
      (asset) => !asset.name.endsWith('.dmg') && !asset.name.endsWith('.zip')
    );
    render(OS.MAC, ARCH.X64, release);
    expect(text('.banner')).toBe('The latest release has no macOS download.');
  });

  // Breaks if asset names from the API are ever parsed as HTML.
  it('renders asset text as text, never markup', () => {
    const release = releaseV122();
    release.assets = [
      { name: '<img src=x onerror=alert(1)>.dmg', size: 1, browser_download_url: 'https://x' },
    ];
    render(OS.WINDOWS, ARCH.X64, release);
    expect(root.querySelector('img')).toBeNull();
  });

  // Breaks if the footer loses its escape hatches to every release and the source.
  it('footer links to all releases and the source', () => {
    render(OS.MAC);
    expect(hrefs('footer a')).toEqual([ALL_RELEASES_URL, 'https://github.com/Sarv/Inbox']);
  });

  // Breaks if a zero-size asset renders "0 MB".
  it('omits a missing size', () => {
    const release = releaseV122();
    release.assets = [
      { name: 'Sarv.Inbox.Setup.9.exe', size: 0, browser_download_url: 'https://x' },
    ];
    render(OS.WINDOWS, ARCH.X64, release);
    expect(root.textContent).not.toContain('MB');
  });
});
