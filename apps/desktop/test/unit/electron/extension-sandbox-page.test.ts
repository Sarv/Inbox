import { readFileSync } from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The code inside the sandbox page. The preload is the only thing there with a line
 * back to Electron, so what matters about it is how little it does. The guest is the
 * first code in the extension's Worker, and everything after it depends on it: if it
 * fails to start the engine, every extension reads "did not start".
 */

const ipc = vi.hoisted(() => ({
  listeners: new Map<string, (event: { ports: unknown[] }) => void>(),
}));

vi.mock('electron', () => ({
  ipcRenderer: {
    once: (channel: string, listener: (event: { ports: unknown[] }) => void) => {
      ipc.listeners.set(channel, listener);
    },
  },
}));

describe('the sandbox preload', () => {
  const workers: { url: string; posted: unknown[]; onerror: ((e: { message: string }) => void) | null }[] = [];

  beforeEach(() => {
    vi.resetModules();
    ipc.listeners.clear();
    workers.length = 0;
    vi.stubGlobal(
      'Worker',
      class {
        posted: unknown[] = [];
        onerror: ((e: { message: string }) => void) | null = null;
        constructor(public url: string) {
          workers.push(this as never);
        }
        postMessage(message: unknown, transfer: unknown[]) {
          this.posted.push({ message, transfer });
        }
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  // The port goes to the Worker and nowhere else. Kept in the preload, or exposed to the
  // page, there would be something to call from outside the Worker.
  it('starts only the guest Worker and hands it the port', async () => {
    await import('../../../electron/extension-sandbox/extension-sandbox-preload');
    const port = { id: 'port' };

    ipc.listeners.get('extension-sandbox:port')?.({ ports: [port] });

    expect(workers).toHaveLength(1);
    expect(workers[0].url).toBe('sarv-extension-sandbox://guest/guest.js');
    expect(workers[0].posted).toEqual([{ message: 'start', transfer: [port] }]);
  });

  // A message with no port must not start a Worker with nothing to talk to.
  it('does nothing without a port', async () => {
    await import('../../../electron/extension-sandbox/extension-sandbox-preload');
    ipc.listeners.get('extension-sandbox:port')?.({ ports: [] });
    expect(workers).toHaveLength(0);
  });

  // A Worker that fails to start can only say so here: it has no port to speak on yet.
  it('reports a Worker that failed to start', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('../../../electron/extension-sandbox/extension-sandbox-preload');
    ipc.listeners.get('extension-sandbox:port')?.({ ports: [{}] });

    workers[0].onerror?.({ message: 'bad script' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('bad script'));
    error.mockRestore();
  });

  // "Beyond the narrow channel it needs": no bridge into the page, no way to send to
  // main, no second channel. Pinned on the source, because a line added here reaches
  // every extension without a test of its own noticing.
  it('exposes nothing, sends nothing, and listens once', () => {
    const source = readFileSync(
      new URL('../../../electron/extension-sandbox/extension-sandbox-preload.ts', import.meta.url),
      'utf8'
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/contextBridge|exposeInMainWorld|webFrame|ipcRenderer\.(send|invoke|on\b|postMessage)/);
    expect(code.match(/ipcRenderer\.once/g)).toHaveLength(1);
    expect(code.match(/from '/g)).toHaveLength(2);
  });
});

describe('the sandbox guest', () => {
  type Listener = (event: unknown) => void;

  function fakeScope() {
    const listeners = new Map<string, Listener[]>();
    const scope = {
      imported: [] as string[],
      closed: false,
      define: null as ((path: string, factory: unknown) => void) | null,
    };
    vi.stubGlobal('addEventListener', (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    });
    vi.stubGlobal('close', () => {
      scope.closed = true;
    });
    return { scope, emit: (type: string, event: unknown) => listeners.get(type)?.forEach((l) => l(event)) };
  }

  function fakePort() {
    return {
      posted: [] as { type: string; [key: string]: unknown }[],
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(message: { type: string }) {
        this.posted.push(message);
      },
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__sarvDefineModule;
  });

  // The whole path in one go: port, file list, engine, load through importScripts, and
  // an extension that activates. A break anywhere here means no extension runs at all.
  it('starts the engine on the port and loads an extension through importScripts', async () => {
    const { emit } = fakeScope();
    const imported: string[] = [];
    vi.stubGlobal('importScripts', (url: string) => {
      imported.push(url);
      (globalThis as unknown as { __sarvDefineModule: (p: string, f: unknown) => void }).__sarvDefineModule(
        'dist/my file.js',
        (exports: Record<string, unknown>) => {
          exports.activate = () => undefined;
        }
      );
    });
    await import('../../../electron/extension-sandbox/extension-sandbox-guest');

    const port = fakePort();
    emit('message', { ports: [port] });
    port.onmessage?.({ data: { type: 'sandbox-init', files: ['dist/my file.js'] } });
    await settle();

    expect(port.posted[0]).toEqual({ type: 'ready' });

    port.onmessage?.({
      data: {
        type: 'activate',
        requestId: 'act-1',
        request: {
          extensionId: 'demo',
          manifest: { id: 'demo' },
          entryPoint: 'dist/my file.js',
          storagePath: '/extension-storage/demo',
          grantedPermissions: [],
          state: { aiAvailable: false, settings: {} },
        },
      },
    });
    await settle();

    // Each segment encoded, or a space in a file name breaks the request.
    expect(imported).toEqual(['sarv-extension-sandbox://guest/ext/dist/my%20file.js']);
    expect(port.posted.find((m) => m.type === 'activated')).toMatchObject({ extensionId: 'demo' });
  });

  // Measured: 3 GB written to OPFS took main from 190 MB to 2.19 GB, because the session is
  // in memory. WebGPU survives disableBlinkFeatures, and hands code a line to the GPU process.
  // The real proof that they are gone from a Worker is in test/sandbox-escape.
  it('takes unneeded APIs away before any extension code can run', async () => {
    fakeScope();
    vi.stubGlobal('importScripts', () => undefined);
    class StorageManager {
      getDirectory() {}
      estimate() {}
    }
    class WorkerNavigator {
      get gpu() {
        return {};
      }
      get serial() {
        return {};
      }
      get storageBuckets() {
        return {};
      }
      get userAgent() {
        return 'x';
      }
    }
    vi.stubGlobal('StorageManager', StorageManager);
    vi.stubGlobal('WorkerNavigator', WorkerNavigator);
    vi.stubGlobal('FileSystemDirectoryHandle', class {});
    vi.stubGlobal('GPU', class {});

    await import('../../../electron/extension-sandbox/extension-sandbox-guest');

    expect('getDirectory' in StorageManager.prototype).toBe(false);
    expect('estimate' in StorageManager.prototype).toBe(true);
    for (const api of ['gpu', 'serial', 'storageBuckets']) expect(api in WorkerNavigator.prototype).toBe(false);
    expect('userAgent' in WorkerNavigator.prototype).toBe(true);
    expect('FileSystemDirectoryHandle' in globalThis).toBe(false);
    expect('GPU' in globalThis).toBe(false);
  });

  // Reached once the extension is deactivated: the Worker closes itself, and main's
  // kill timer stays a backstop for hooks that hang.
  it('closes the Worker when the engine is done', async () => {
    const { scope, emit } = fakeScope();
    vi.stubGlobal('importScripts', () => undefined);
    await import('../../../electron/extension-sandbox/extension-sandbox-guest');

    const port = fakePort();
    emit('message', { ports: [port] });
    port.onmessage?.({ data: { type: 'sandbox-init', files: [] } });
    port.onmessage?.({ data: { type: 'shutdown' } });
    await settle();

    expect(scope.closed).toBe(true);
  });

  // A second port would give whoever sent it a second line into the engine. Only main
  // holds the first, through the preload.
  it('takes one port and ignores any other', async () => {
    const { emit } = fakeScope();
    vi.stubGlobal('importScripts', () => undefined);
    await import('../../../electron/extension-sandbox/extension-sandbox-guest');

    const first = fakePort();
    const second = fakePort();
    emit('message', { ports: [] });
    emit('message', { ports: [first] });
    emit('message', { ports: [second] });

    expect(first.onmessage).not.toBeNull();
    expect(second.onmessage).toBeNull();
  });

  // Uncaught errors have no call to fail; these are what report them. Without this a
  // Node API used from a timer never reaches the user.
  it('reports uncaught errors and rejections to main', async () => {
    const { emit } = fakeScope();
    vi.stubGlobal('importScripts', () => undefined);
    await import('../../../electron/extension-sandbox/extension-sandbox-guest');

    const port = fakePort();
    emit('message', { ports: [port] });
    port.onmessage?.({ data: { type: 'sandbox-init', files: [] } });
    await settle();

    emit('error', { error: new ReferenceError('process is not defined') });
    emit('error', { message: 'no error object' });
    emit('unhandledrejection', { reason: new Error('nobody awaited') });
    await settle();

    expect(port.posted.find((m) => m.type === 'unsupported-api')).toMatchObject({ api: 'process' });
    const logged = port.posted.filter((m) => m.type === 'log').map((m) => String(m.message));
    expect(logged.join('\n')).toContain('no error object');
    expect(logged.join('\n')).toContain('nobody awaited');
  });
});
