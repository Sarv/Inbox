import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createExtensionRegistry } from '../../../src/extensions/extension-registry';
import { ExtensionSource, type ExtensionPermission } from '../../../src/extensions/types';

/**
 * What the registry does with a profile written by an older build.
 *
 * Extensions used to ship inside the app. A profile from back then still holds
 * records with `source: 'builtin'` pointing at a folder in the app's own tree —
 * a folder that no longer exists. What breaks if this file goes red: those
 * records come back, and every one of them is a permanent ghost. It lists as
 * installed and enabled, it never loads ("enabled but not loaded" on every
 * start), it cannot be uninstalled, and — worst — its id is taken, so the same
 * extension can never be installed from the registry the ordinary way.
 */

let dir = '';

const statePath = () => join(dir, 'extensions-state.json');

const writeState = (extensions: Record<string, unknown>) =>
  writeFileSync(statePath(), JSON.stringify({ extensions, lastUpdated: 1 }), 'utf-8');

const record = (id: string, source: ExtensionSource, path: string) => ({
  id,
  source,
  path,
  version: '1.0.0',
  installedAt: 1,
  enabled: true,
  grantedPermissions: ['email:read'],
  settings: {},
});

describe('atomic optional extension permission approval', () => {
  const createSource = () => {
    const source = join(dir, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'sarvinbox-extension.json'), JSON.stringify({ id: 'test-scanner', name: 'Test scanner', version: '1.0.0',
      description: 'Synthetic scanner for permission testing', author: 'Test', main: 'index.js', engines: { sarvinbox: '>=1.0.0' },
      permissions: ['ui:panel', 'security:scan-attachments', 'security:scan-body'] }));
    writeFileSync(join(source, 'index.js'), 'module.exports = {};');
    return source;
  };

  // Regression: installing before narrowing capabilities briefly persisted broad unapproved permissions across a crash/restart.
  it('persists and emits only the approved subset on the first installation', async () => {
    const registry = await open(); const source = createSource(); const permissions: ExtensionPermission[] = ['ui:panel', 'security:scan-attachments'];
    const grantedAtInstall: ExtensionPermission[][] = [];
    registry.subscribe(event => { if (event.type === 'installed') grantedAtInstall.push([...event.extension.grantedPermissions]); });
    expect((await registry.install(source, permissions)).grantedPermissions).toEqual(permissions);
    expect(grantedAtInstall).toEqual([permissions]);
    const saved = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(saved.extensions['test-scanner'].grantedPermissions).toEqual(permissions);
    permissions.push('security:scan-body');
    expect(registry.get('test-scanner')!.grantedPermissions).toEqual(['ui:panel', 'security:scan-attachments']);
    const reopened = await open();
    expect(reopened.get('test-scanner')!.grantedPermissions).toEqual(['ui:panel', 'security:scan-attachments']);
  });

  // Regression: permission approval must reject undeclared/duplicate/invalid grants before any copied or persisted installation.
  it.each([{ permissions: ['network:fetch'] }, { permissions: ['ui:panel', 'ui:panel'] }, { permissions: null }])('refuses invalid initial permissions $permissions before installation', async ({ permissions }) => {
    const registry = await open(); const source = createSource();
    await expect(registry.install(source, permissions as ExtensionPermission[])).rejects.toThrow(/unique subset/);
    expect(registry.has('test-scanner')).toBe(false);
    expect(existsSync(join(dir, 'extensions', 'test-scanner'))).toBe(false);
  });

  // Regression: existing folder/marketplace callers and deliberately empty approvals must remain supported.
  it.each([{ permissions: undefined }, { permissions: [] as ExtensionPermission[] }])('retains default compatibility and supports an empty explicit approval', async ({ permissions }) => {
    const registry = await open(); const source = createSource(); const installed = await registry.install(source, permissions);
    expect(installed.grantedPermissions).toEqual(permissions ?? ['ui:panel', 'security:scan-attachments', 'security:scan-body']);
  });
});

const open = async () => {
  const registry = createExtensionRegistry({
    userExtensionsDir: join(dir, 'extensions'),
    statePath: statePath(),
  });
  await registry.initialize();
  return registry;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'registry-'));
  mkdirSync(join(dir, 'extensions'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loading a profile from an older build', () => {
  it('drops records that pointed at extensions bundled into the app', async () => {
    writeState({
      'otp-code': record('otp-code', ExtensionSource.BUILTIN, '/gone/extensions/otp-code'),
    });

    const registry = await open();

    expect(registry.get('otp-code')).toBeUndefined();
    expect(registry.getAll()).toHaveLength(0);
  });

  // The whole point of dropping it: the id has to be free again, or the
  // extension can never come back from the registry it is published in.
  it('leaves the id installable again', async () => {
    writeState({
      'otp-code': record('otp-code', ExtensionSource.BUILTIN, '/gone/extensions/otp-code'),
    });

    const registry = await open();

    expect(registry.has('otp-code')).toBe(false);
  });

  it('keeps records for extensions the user actually installed', async () => {
    writeState({
      'otp-code': record('otp-code', ExtensionSource.BUILTIN, '/gone/extensions/otp-code'),
      'vip-scoring': record('vip-scoring', ExtensionSource.MARKETPLACE, join(dir, 'extensions', 'vip-scoring')),
      'local-one': record('local-one', ExtensionSource.LOCAL, join(dir, 'extensions', 'local-one')),
    });

    const registry = await open();

    expect(registry.getAll().map((ext) => ext.id).sort()).toEqual(['local-one', 'vip-scoring']);
  });

  // Left only in memory, the same warning would be logged on every single
  // start, and the file would keep describing extensions that cannot exist.
  it('rewrites the state file so the ghost does not come back', async () => {
    writeState({
      'otp-code': record('otp-code', ExtensionSource.BUILTIN, '/gone/extensions/otp-code'),
      'vip-scoring': record('vip-scoring', ExtensionSource.MARKETPLACE, join(dir, 'extensions', 'vip-scoring')),
    });

    await open();

    const saved = JSON.parse(readFileSync(statePath(), 'utf-8'));
    expect(Object.keys(saved.extensions)).toEqual(['vip-scoring']);
  });

  // A profile with nothing stale must not be rewritten into a different shape.
  it('leaves a profile with no bundled records alone', async () => {
    writeState({
      'vip-scoring': record('vip-scoring', ExtensionSource.MARKETPLACE, join(dir, 'extensions', 'vip-scoring')),
    });
    const before = readFileSync(statePath(), 'utf-8');

    await open();

    expect(readFileSync(statePath(), 'utf-8')).toBe(before);
  });
});
