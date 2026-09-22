/**
 * What a panel is allowed to ask the host for.
 *
 * A panel is extension-authored HTML in an iframe, and the renderer that
 * relays its traffic is not a security boundary. These pin that every request
 * is checked in the host against what the user actually granted — a gap here
 * is an extension reading or writing through its own UI what it was refused
 * through its code.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExtensionSettingsBackend,
  ExtensionStorageBackend,
  ExtensionUIBackend,
} from '../../../src/extensions/extension-api';
import { ExtensionHost } from '../../../src/extensions/extension-host';
import type { LoadedExtension } from '../../../src/extensions/extension-loader';
import type { ExtensionRegistry } from '../../../src/extensions/extension-registry';
import type { PanelRequest } from '../../../src/extensions/panel-bridge';
import {
  ExtensionState,
  type ExtensionInfo,
  type ExtensionManifest,
  type ExtensionPermission,
} from '../../../src/extensions/types';
import { createEventBus } from '../../../src/pipeline/event-bus';

let workDir: string;

function writeExtension(
  id: string,
  source: string,
  extra: Partial<ExtensionManifest> = {}
): LoadedExtension {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), source, 'utf-8');
  const manifest = {
    id,
    name: id,
    version: '1.0.0',
    description: 'panel test extension',
    author: 'test',
    main: 'index.js',
    engines: { sarvinbox: '>=0.1.0' },
    permissions: [],
    contributes: {
      panels: [{ id: 'main', title: 'Main', entry: 'panel.html', surface: 'sidebar' }],
    },
    ...extra,
  } as ExtensionManifest;
  writeFileSync(join(dir, 'sarvinbox-extension.json'), JSON.stringify(manifest), 'utf-8');
  return { manifest, path: dir, entryPoint: join(dir, 'index.js') };
}

function fakeRegistry(): ExtensionRegistry {
  const infos = new Map<string, ExtensionInfo>();
  return {
    getRuntimeInfo: (id: string) => infos.get(id),
    setRuntimeInfo: (id: string, info: ExtensionInfo) => infos.set(id, info),
    getLoaded: () => undefined,
    get: () => undefined,
    filter: () => [],
  } as unknown as ExtensionRegistry;
}

function memoryStorage(): ExtensionStorageBackend {
  const data = new Map<string, unknown>();
  const scoped = (id: string, key: string) => `${id}::${key}`;
  return {
    async get<T>(id: string, key: string) {
      return data.get(scoped(id, key)) as T | undefined;
    },
    async set<T>(id: string, key: string, value: T) {
      data.set(scoped(id, key), value);
    },
    async delete(id: string, key: string) {
      data.delete(scoped(id, key));
    },
    async keys(id: string) {
      return Array.from(data.keys())
        .filter((k) => k.startsWith(`${id}::`))
        .map((k) => k.slice(id.length + 2));
    },
    async clear() {
      data.clear();
    },
  };
}

function memorySettings(
  initial: Record<string, Record<string, unknown>> = {}
): ExtensionSettingsBackend {
  const values = new Map(Object.entries(initial));
  return {
    get: <T,>(id: string, key: string) => values.get(id)?.[key] as T | undefined,
    async update(id: string, key: string, value: unknown) {
      const forExtension = values.get(id) ?? {};
      forExtension[key] = value;
      values.set(id, forExtension);
    },
    has: (id: string, key: string) => key in (values.get(id) ?? {}),
    keys: (id: string) => Object.keys(values.get(id) ?? {}),
  };
}

const notified: unknown[] = [];

function createHost(settings?: ExtensionSettingsBackend): ExtensionHost {
  const uiBackend: ExtensionUIBackend = {
    notify: (_id, notification) => notified.push(notification),
    dismiss: vi.fn(),
  };
  return new ExtensionHost({
    registry: fakeRegistry(),
    eventBus: createEventBus(),
    storageBackend: memoryStorage(),
    settingsBackend: settings ?? memorySettings(),
    uiBackend,
    extensionStoragePath: join(workDir, 'storage'),
  });
}

function request(method: string, params?: unknown): PanelRequest {
  return { requestId: 'r1', method: method as PanelRequest['method'], params };
}

const PANEL_ONLY: ExtensionPermission[] = ['ui:panel'];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sarvinbox-panel-host-'));
  notified.length = 0;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('servePanelRequest', () => {
  // The whole point of routing panel traffic through main: a request for
  // something the extension was never granted is refused, no matter that it
  // came from the extension's own UI.
  it("refuses storage to a panel whose extension has no 'storage:local'", async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', request('storage.set', {
      key: 'k',
      value: 1,
    }));

    expect(response.ok).toBe(false);
    expect(response.error).toContain("'storage:local'");
  });

  it('reads and writes storage when the grant is there', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, ['ui:panel', 'storage:local']);

    await host.servePanelRequest('panels', request('storage.set', { key: 'seen', value: 42 }));
    const read = await host.servePanelRequest('panels', request('storage.get', { key: 'seen' }));
    const keys = await host.servePanelRequest('panels', request('storage.keys'));

    expect(read).toMatchObject({ ok: true, value: 42 });
    expect(keys.value).toEqual(['seen']);
  });

  // Losing `ui:panel` has to silence the panel that is already open, not just
  // stop the next one from being offered.
  it('refuses everything when ui:panel was never granted', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, ['storage:local']);

    const response = await host.servePanelRequest('panels', request('storage.keys'));

    expect(response.ok).toBe(false);
    expect(response.error).toContain("'ui:panel'");
  });

  // Default deny. A method added to the SDK without a permission decision has
  // no entry in the table, and must not fall through as "needs nothing".
  it('refuses a method it does not know', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', request('storage.dropEverything'));

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unknown panel request');
  });

  it('refuses a panel whose extension is not running', async () => {
    const host = createHost();

    const response = await host.servePanelRequest('ghost', request('settings.all'));

    expect(response.ok).toBe(false);
    expect(response.error).toContain('not running');
  });

  // The message a panel sees comes from the app, never from the panel: a panel
  // that could name its own message could read mail the reader never opened.
  it('answers message.current from what the app supplies', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, ['ui:panel', 'email:read']);

    const response = await host.servePanelRequest('panels', request('message.current'), {
      getCurrentMessage: async () => ({ id: 'email-1', subject: 'Hello' }),
    });

    expect(response).toMatchObject({ ok: true, value: { id: 'email-1', subject: 'Hello' } });
  });

  it("refuses message.current without 'email:read'", async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', request('message.current'), {
      getCurrentMessage: async () => ({ id: 'email-1' }),
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("'email:read'");
  });

  it('answers null when nothing is open', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, ['ui:panel', 'email:read']);

    const response = await host.servePanelRequest('panels', request('message.current'));

    expect(response).toMatchObject({ ok: true, value: null });
  });

  // A panel calling into its own module is how anything real gets done, and it
  // crosses the process boundary to do it.
  it('calls a function the extension exported, in the sandbox', async () => {
    const host = createHost();
    const loaded = writeExtension(
      'panels',
      `exports.activate = (ctx) => {
         ctx.exports = { double: (n) => n * 2 };
       };`
    );
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', request('exports.call', {
      name: 'double',
      args: [21],
    }));

    expect(response).toMatchObject({ ok: true, value: 42 });
  });

  it('refuses a call to a function the extension does not export', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', request('exports.call', {
      name: 'nope',
      args: [],
    }));

    expect(response.ok).toBe(false);
    expect(response.error).toContain('exports no function');
  });

  // An error thrown inside the extension has to come back as a refusal the
  // panel can render — an escape here is an unhandled rejection in an IPC
  // handler, which takes more than this panel down with it.
  it('turns an error inside the extension into a refusal', async () => {
    const host = createHost();
    const loaded = writeExtension(
      'panels',
      `exports.activate = (ctx) => {
         ctx.exports = { boom: () => { throw new Error('exploded'); } };
       };`
    );
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', request('exports.call', {
      name: 'boom',
      args: [],
    }));

    expect(response.ok).toBe(false);
    expect(response.error).toContain('exploded');
  });

  // A panel reads settings under the same grant the extension's own code
  // needs: a panel must not be a way around a permission that was refused.
  it('reads settings under settings:read', async () => {
    const host = createHost(memorySettings({ panels: { theme: 'dark' } }));
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, ['ui:panel', 'settings:read']);

    const one = await host.servePanelRequest('panels', request('settings.get', { key: 'theme' }));
    const all = await host.servePanelRequest('panels', request('settings.all'));

    expect(one).toMatchObject({ ok: true, value: 'dark' });
    expect(all.value).toMatchObject({ theme: 'dark' });
  });

  it("refuses ui.notify without 'ui:notify'", async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', request('ui.notify', {
      id: 'n1',
      title: 'Hi',
    }));

    expect(response.ok).toBe(false);
    expect(notified).toHaveLength(0);
  });

  it('raises a notification when the grant is there', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, ['ui:panel', 'ui:notify']);

    const response = await host.servePanelRequest('panels', request('ui.notify', {
      id: 'n1',
      title: 'Hi',
    }));

    expect(response.ok).toBe(true);
    expect(notified).toHaveLength(1);
  });

  it('carries the request id back so the panel can match the reply', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', {
      requestId: 'abc-123',
      method: 'settings.all',
    });

    expect(response.requestId).toBe('abc-123');
    expect(response.ok).toBe(false);
  });

  it('stops answering once the extension is deactivated', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);
    await host.deactivate('panels');

    const response = await host.servePanelRequest('panels', request('settings.all'));

    expect(response.ok).toBe(false);
    expect(response.error).toContain('not running');
  });

  it('refuses settings without the grant', async () => {
    const host = createHost(memorySettings({ panels: { theme: 'dark' } }));
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);

    const response = await host.servePanelRequest('panels', request('settings.all'));

    expect(response.ok).toBe(false);
    expect(response.error).toContain("'settings:read'");
  });

  it('leaves the extension state untouched by a refused request', async () => {
    const host = createHost();
    const loaded = writeExtension('panels', 'exports.activate = () => {};');
    await host.activate(loaded, PANEL_ONLY);

    await host.servePanelRequest('panels', request('storage.keys'));

    expect(host.isActive('panels')).toBe(true);
    expect(host.getActiveExtensionIds()).toContain('panels');
    expect(ExtensionState.ACTIVE).toBeDefined();
  });
});
