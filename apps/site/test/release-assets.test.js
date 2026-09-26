import { describe, expect, it } from 'vitest';

import { ARCH, OS } from '../src/platform.js';
import {
  ANY_ARCH,
  PACKAGE,
  classifyAsset,
  classifyAssets,
  pickDownloads,
  rankAssetsFor,
} from '../src/release-assets.js';

import { releaseV122 } from './fixtures.js';

const installables = () => classifyAssets(releaseV122().assets);
const names = (assets) => assets.map((asset) => asset.name);

describe('classifyAsset', () => {
  // Breaks if a real v1.2.2 file is misfiled — a Windows user sent a .deb, etc.
  it.each([
    ['sarv-inbox-1.2.2-mac-arm64-amd64.dmg', OS.MAC, PACKAGE.DMG, ANY_ARCH],
    ['sarv-inbox-1.2.2-mac-arm64-amd64.zip', OS.MAC, PACKAGE.MAC_ZIP, ANY_ARCH],
    ['Sarv.Inbox.Setup.1.2.2.exe', OS.WINDOWS, PACKAGE.EXE, ANY_ARCH],
    ['sarv-inbox-1.2.2-x86_64.AppImage', OS.LINUX, PACKAGE.APPIMAGE, ARCH.X64],
    ['sarv-inbox-1.2.2-arm64.AppImage', OS.LINUX, PACKAGE.APPIMAGE, ARCH.ARM64],
    ['sarv-inbox-1.2.2-amd64.deb', OS.LINUX, PACKAGE.DEB, ARCH.X64],
    ['sarv-inbox-1.2.2-arm64.deb', OS.LINUX, PACKAGE.DEB, ARCH.ARM64],
    ['sarv-inbox-1.2.2-x86_64.rpm', OS.LINUX, PACKAGE.RPM, ARCH.X64],
    ['sarv-inbox-1.2.2-aarch64.rpm', OS.LINUX, PACKAGE.RPM, ARCH.ARM64],
    ['Sarv Inbox Setup 1.3.0-x64.exe', OS.WINDOWS, PACKAGE.EXE, ARCH.X64],
  ])('%s', (name, os, kind, arch) => {
    expect(classifyAsset({ name, size: 1, browser_download_url: 'u' })).toEqual({
      os,
      kind,
      arch,
      name,
      size: 1,
      url: 'u',
    });
  });

  // Breaks if update manifests, blockmaps or unrelated archives appear as downloads.
  it.each([
    'latest.yml',
    'latest-mac.yml',
    'Sarv.Inbox.Setup.1.2.2.exe.blockmap',
    'sarv-inbox-1.2.2-mac-arm64-amd64.dmg.blockmap',
    'source.zip',
    'no-extension',
    '',
  ])('ignores %j', (name) => {
    expect(classifyAsset({ name })).toBeNull();
  });

  // Breaks if a malformed API entry throws instead of being skipped.
  it('ignores a missing asset', () => {
    expect(classifyAsset()).toBeNull();
    expect(classifyAssets()).toEqual([]);
  });

  // Breaks if the v1.2.2 manifests/blockmaps leak into the list.
  it('keeps exactly the nine installers from v1.2.2', () => {
    expect(installables()).toHaveLength(9);
  });
});

describe('rankAssetsFor / pickDownloads', () => {
  // Breaks if a Mac is offered the .zip instead of the .dmg.
  it('macOS: the universal dmg first, zip as the alternative', () => {
    const { primary, alternatives } = pickDownloads(installables(), {
      os: OS.MAC,
      arch: ARCH.ARM64,
    });
    expect(primary.name).toBe('sarv-inbox-1.2.2-mac-arm64-amd64.dmg');
    expect(names(alternatives)).toEqual(['sarv-inbox-1.2.2-mac-arm64-amd64.zip']);
  });

  // Breaks if Windows (any arch) doesn't get the combined installer.
  it.each([ARCH.X64, ARCH.ARM64, ARCH.UNKNOWN])('Windows %s: the one installer', (arch) => {
    const { primary, alternatives } = pickDownloads(installables(), { os: OS.WINDOWS, arch });
    expect(primary.name).toBe('Sarv.Inbox.Setup.1.2.2.exe');
    expect(alternatives).toEqual([]);
  });

  // Breaks if x64 Linux gets an ARM build first, or loses the deb/rpm options.
  it('Linux x64: AppImage, deb, rpm for x64, then the ARM builds', () => {
    expect(names(rankAssetsFor(installables(), OS.LINUX, ARCH.X64))).toEqual([
      'sarv-inbox-1.2.2-x86_64.AppImage',
      'sarv-inbox-1.2.2-amd64.deb',
      'sarv-inbox-1.2.2-x86_64.rpm',
      'sarv-inbox-1.2.2-arm64.AppImage',
      'sarv-inbox-1.2.2-arm64.deb',
      'sarv-inbox-1.2.2-aarch64.rpm',
    ]);
  });

  // Breaks if an ARM Linux machine (Raspberry Pi, Asahi) is offered an x64 AppImage that won't run.
  it('Linux arm64: the ARM builds first', () => {
    expect(names(rankAssetsFor(installables(), OS.LINUX, ARCH.ARM64)).slice(0, 3)).toEqual([
      'sarv-inbox-1.2.2-arm64.AppImage',
      'sarv-inbox-1.2.2-arm64.deb',
      'sarv-inbox-1.2.2-aarch64.rpm',
    ]);
  });

  // Breaks if an unknown architecture picks ARM (the rare case) over x64.
  it('Linux with unknown arch assumes x64', () => {
    expect(pickDownloads(installables(), { os: OS.LINUX, arch: ARCH.UNKNOWN }).primary.name).toBe(
      'sarv-inbox-1.2.2-x86_64.AppImage'
    );
  });

  // Breaks if an arch-specific build stops beating a universal one for its own arch.
  it('prefers an exact-arch file over a universal one', () => {
    const assets = classifyAssets([
      { name: 'Sarv Inbox Setup 2.0.0.exe' },
      { name: 'Sarv Inbox Setup 2.0.0-arm64.exe' },
    ]);
    expect(pickDownloads(assets, { os: OS.WINDOWS, arch: ARCH.ARM64 }).primary.name).toBe(
      'Sarv Inbox Setup 2.0.0-arm64.exe'
    );
  });

  // Breaks if a platform with no files crashes instead of returning no primary.
  it('no primary when nothing matches', () => {
    expect(pickDownloads([], { os: OS.MAC, arch: ARCH.X64 })).toEqual({
      primary: null,
      alternatives: [],
    });
    expect(pickDownloads(installables(), { os: OS.IOS, arch: ARCH.UNKNOWN })).toEqual({
      primary: null,
      alternatives: [],
    });
  });

  // Breaks if ranking mutates the caller's array (the list is reused for "Other platforms").
  it('does not reorder its input', () => {
    const input = installables();
    const before = names(input);
    rankAssetsFor(input, OS.LINUX, ARCH.ARM64);
    expect(names(input)).toEqual(before);
  });
});
