import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type CompilerRunner = (file: string, args: string[], options: Record<string, unknown>) => Promise<unknown>;
const builder = require('../../build/keychain-helper.js') as {
  KEYCHAIN_HELPER_FILENAME: string;
  buildKeychainHelper: (options: { directory: string; arch: string | number; run?: CompilerRunner }) => Promise<string>;
};
const paths: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'inbox-keychain-helper-'));
  paths.push(root);
  const directory = join(root, 'Sarv Inbox.app', 'Contents', 'MacOS');
  await mkdir(directory, { recursive: true });
  return directory;
}
const fakeMachO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
function compiler() {
  return vi.fn<CompilerRunner>().mockImplementation(async (_file, args) => {
    await writeFile(args[args.indexOf('-o') + 1]!, fakeMachO);
  });
}
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('macOS Keychain helper build', () => {
  it.each([
    ['x64', ['x86_64']], [1, ['x86_64']], ['arm64', ['arm64']], [3, ['arm64']],
    ['universal', ['x86_64', 'arm64']], [4, ['x86_64', 'arm64']],
  ] as const)('builds the requested %s slice(s) with fixed Security.framework source', async (arch, architectures) => {
    const directory = await fixture(); const run = compiler();
    const destination = await builder.buildKeychainHelper({ directory, arch, run });
    expect(destination).toBe(join(directory, 'Sarv Inbox Keychain'));
    expect(await readFile(destination)).toEqual(fakeMachO);
    expect((await stat(destination)).mode & 0o777).toBe(0o755);
    expect(await readdir(directory)).toEqual(['Sarv Inbox Keychain']);
    expect(run).toHaveBeenCalledOnce();
    const [file, args, options] = run.mock.calls[0]!;
    expect(file).toBe('/usr/bin/xcrun');
    expect(args.slice(0, 3)).toEqual(['--sdk', 'macosx', 'clang']);
    expect(args.flatMap((value, index) => value === '-arch' ? [args[index + 1]] : [])).toEqual(architectures);
    expect(args).toContain('-mmacosx-version-min=11.0');
    expect(args).toContain('Security'); expect(args).toContain('CoreFoundation');
    expect(args).toContain(fileURLToPath(new URL('../../native/keychain-access.m', import.meta.url)));
    expect(options).toMatchObject({ timeout: 120_000, maxBuffer: 512 * 1024 });
  });

  it.each(['ia32', 'arm', 'unknown', 0, 2, 99])('refuses unsupported architecture %s before invoking any tool', async arch => {
    const directory = await fixture(); const run = compiler();
    await expect(builder.buildKeychainHelper({ directory, arch, run })).rejects.toThrow('Unsupported macOS architecture');
    expect(run).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
  });

  it('fails the build and removes intermediate files if compilation fails, preserving a previous binary', async () => {
    const directory = await fixture(); const destination = join(directory, builder.KEYCHAIN_HELPER_FILENAME);
    await writeFile(destination, 'previous binary');
    const run = vi.fn<CompilerRunner>().mockImplementation(async (_file, args) => {
      await writeFile(args[args.indexOf('-o') + 1]!, 'partial output');
      throw new Error('compiler failed');
    });
    await expect(builder.buildKeychainHelper({ directory, arch: 'arm64', run })).rejects.toThrow('compiler failed');
    expect(await readFile(destination, 'utf8')).toBe('previous binary');
    expect(await readdir(directory)).toEqual([builder.KEYCHAIN_HELPER_FILENAME]);
  });

  it.each([false, true])('fails rather than shipping a missing or empty helper (empty=%s)', async empty => {
    const directory = await fixture();
    const run = vi.fn<CompilerRunner>().mockImplementation(async (_file, args) => {
      if (empty) await writeFile(args[args.indexOf('-o') + 1]!, '');
    });
    await expect(builder.buildKeychainHelper({ directory, arch: 'x64', run })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('is discovered by the installed osx-sign recursive binary walker before app signing', async () => {
    const directory = await fixture(); await writeFile(join(directory, builder.KEYCHAIN_HELPER_FILENAME), fakeMachO);
    const { walkAsync } = require('@electron/osx-sign/dist/cjs/util.js') as { walkAsync: (path: string) => Promise<string[]> };
    expect(await walkAsync(dirname(directory))).toContain(join(directory, builder.KEYCHAIN_HELPER_FILENAME));
    const signer = await readFile(require.resolve('@electron/osx-sign/dist/cjs/sign.js'), 'utf8');
    expect(signer).toContain('walkAsync)((0, util_1.getAppContentsPath)(opts))');
    expect(signer).toContain('for (const filePath of [...children, opts.app])');
  });

  it('requires the build in afterPack before pruning or any early return, including the universal final pack', async () => {
    const hook = await readFile(new URL('../../build/afterPack.js', import.meta.url), 'utf8');
    expect(hook).toContain("electronPlatformName === 'darwin'");
    expect(hook).toContain('await buildKeychainHelper(');
    expect(hook.indexOf('await buildKeychainHelper(')).toBeLessThan(hook.indexOf('if (dead.length === 0) return'));
    expect(hook).toContain("directory: join(appOutDir, `${appName}.app`, 'Contents', 'MacOS')");
    expect(hook).toContain('arch: context.arch');
    const macPackager = await readFile(require.resolve('app-builder-lib/out/macPackager.js'), 'utf8');
    const universalTail = macPackager.slice(macPackager.indexOf('await makeUniversalApp('));
    expect(universalTail.indexOf('await this.info.emitAfterPack(packContext)')).toBeLessThan(universalTail.indexOf('await this.doSignAfterPack('));
  });

  it('keeps the native source, compiler hook and both normal development entrypoints available in a fresh clone', async () => {
    const desktop = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string>; build: { afterPack: string } };
    expect(desktop.build.afterPack).toBe('./build/afterPack.js');
    for (const script of ['dev', 'electron:dev']) expect(desktop.scripts[script]).toContain('node ../../scripts/build-keychain-helper.mjs');
    const root = new URL('../../../../', import.meta.url);
    expect(await readFile(new URL('scripts/dev.sh', root), 'utf8')).toContain('node scripts/build-keychain-helper.mjs');
    expect(await readFile(new URL('.gitignore', root), 'utf8')).toContain('!apps/desktop/build/keychain-helper.js');
    const devBuilder = await readFile(new URL('scripts/build-keychain-helper.mjs', root), 'utf8');
    expect(devBuilder).toContain("if (process.platform === 'darwin')");
    expect(devBuilder).toContain("require('./build/keychain-helper.js')");
    expect(devBuilder).toContain("require('electron')");
    const source = await readFile(new URL('../../native/keychain-access.m', import.meta.url), 'utf8');
    expect(source).toContain('SecKeychainCopyDefault(&keychain)');
    expect(source).toContain('SecKeychainUnlock(keychain, 0, NULL, false)');
    expect(source).not.toMatch(/SecKeychain(?:Lock|Create|Delete|Set|Change)|SecItem(?:Add|Copy|Update|Delete)|SecAccess/);
  });
});
