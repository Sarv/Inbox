import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The confinement of extension code. These pin the settings and the supervision;
 * whether those settings really stop a fetch is proved against real Electron by
 * `pnpm test:sandbox-escape` (test/sandbox-escape). A test here failing means one of:
 *   - a preference or a policy got looser, and a file or the network is one step closer;
 *   - extension code could start with no OS sandbox in a release build;
 *   - a hung, crashed or flooding extension is no longer stopped, or takes more with it;
 *   - quitting can be held up, or end in a crash.
 */

const h = vi.hoisted(() => ({
  views: [] as FakeView[],
  sessions: new Map<string, FakeSession>(),
  ports: [] as FakePort[],
  logs: [] as string[],
  noSandbox: false,
  sandboxed: true as boolean | undefined,
  persistent: false,
  loadError: null as Error | null,
  loadHangs: false,
  loadedUrl: null as string | null,
  guestFails: false,
  clearFails: false,
}));

class FakePort extends EventEmitter {
  posted: unknown[] = [];
  started = false;
  closed = false;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  start(): void {
    this.started = true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class FakeContents extends EventEmitter {
  destroyed = false;
  crashed = 0;
  closes = 0;
  openHandler: (() => { action: string }) | null = null;
  framePosts: { channel: string; message: unknown; ports: unknown[] }[] = [];
  url = '';
  mainFrame = {
    postMessage: (channel: string, message: unknown, ports: unknown[]) => {
      this.framePosts.push({ channel, message, ports });
    },
  };
  loadURL(url: string): Promise<void> {
    if (h.loadHangs) return new Promise(() => undefined);
    if (h.loadError) return Promise.reject(h.loadError);
    this.url = h.loadedUrl ?? url;
    return Promise.resolve();
  }
  getURL(): string {
    return this.url;
  }
  getOSProcessId(): number {
    return 4242;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    this.closes += 1;
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
  }
  forcefullyCrashRenderer(): void {
    this.crashed += 1;
  }
  setWindowOpenHandler(handler: () => { action: string }): void {
    this.openHandler = handler;
  }
}

class FakeView {
  webContents = new FakeContents();
  constructor(public options: { webPreferences: Record<string, unknown> }) {
    h.views.push(this);
  }
}

class FakeSession extends EventEmitter {
  handler: ((request: Request) => Promise<Response>) | null = null;
  scheme: string | null = null;
  beforeRequest: ((details: { url: string }, callback: (r: { cancel: boolean }) => void) => void) | null = null;
  permissionRequest: ((c: unknown, p: string, cb: (allow: boolean) => void) => void) | null = null;
  permissionCheck: (() => boolean) | null = null;
  devicePermission: (() => boolean) | null = null;
  spellcheck: boolean | null = null;
  storageCleared = 0;
  clearStorageData(): Promise<void> {
    this.storageCleared += 1;
    return h.clearFails ? Promise.reject(new Error('busy')) : Promise.resolve();
  }
  protocol = {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
      if (this.handler) throw new Error('already handled');
      this.scheme = scheme;
      this.handler = handler;
    },
  };
  webRequest = {
    onBeforeRequest: (listener: FakeSession['beforeRequest']) => {
      this.beforeRequest = listener;
    },
  };
  isPersistent(): boolean {
    return h.persistent;
  }
  setPermissionRequestHandler(handler: FakeSession['permissionRequest']): void {
    this.permissionRequest = handler;
  }
  setPermissionCheckHandler(handler: FakeSession['permissionCheck']): void {
    this.permissionCheck = handler;
  }
  setDevicePermissionHandler(handler: FakeSession['devicePermission']): void {
    this.devicePermission = handler;
  }
  setSpellCheckerEnabled(value: boolean): void {
    this.spellcheck = value;
  }
}

vi.mock('electron', () => ({
  app: {
    commandLine: { hasSwitch: (name: string) => name === 'no-sandbox' && h.noSandbox },
    getAppMetrics: () => [{ pid: 4242, sandboxed: h.sandboxed }],
    isPackaged: true,
  },
  MessageChannelMain: class {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      h.ports.push(this.port1);
    }
  },
  session: {
    fromPartition: (name: string, options: { cache?: boolean }) => {
      expect(options.cache).toBe(false);
      let ses = h.sessions.get(name);
      if (!ses) {
        ses = new FakeSession();
        h.sessions.set(name, ses);
      }
      return ses;
    },
  },
  WebContentsView: FakeView,
}));

vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: (...args: unknown[]) => h.logs.push(args.join(' ')),
    warn: (...args: unknown[]) => h.logs.push(args.join(' ')),
    error: (...args: unknown[]) => h.logs.push(args.join(' ')),
    debug: () => {},
  }),
}));

// The Worker's script comes from the build, which a unit test does not have.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('extension-sandbox-guest.js')) {
          return h.guestFails ? Promise.reject(new Error('no such file')) : Promise.resolve('/* the guest */');
        }
        return (actual.promises.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
      },
    },
  };
});

let rootDir: string;

async function loadRuntime() {
  vi.resetModules();
  return import('../../../../electron/services/extension-runtime');
}

/** A channel over a fresh fake sandbox for an extension folder holding `index.js`. */
async function startChannel(extensionId = 'demo') {
  const runtime = await loadRuntime();
  const channel = await runtime.createSandboxChannel({
    extensionId,
    rootDir,
    entryPoint: join(rootDir, 'index.js'),
  });
  const view = h.views[h.views.length - 1];
  const port = h.ports[h.ports.length - 1];
  const ses = h.sessions.get(runtime.sandboxPartition(extensionId)) as FakeSession;
  return { runtime, channel, view, port, contents: view.webContents, ses };
}

/** What the Worker would say back. */
const fromWorker = (port: FakePort, data: unknown) => port.emit('message', { data });

// Whether the OS sandbox is on is read from Electron's process metrics on macOS and
// Windows, and from the kernel's /proc on Linux (os-sandbox-state.test.ts covers
// both). These fake the metrics, so they run as macOS on every host. Breaks: on a
// Linux runner the real /proc has no such process, the state reads as unknown, and
// every start in this file is refused (39 failures in CI on 2026-11-07).
const HOST_PLATFORM = process.platform;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  h.views.length = 0;
  h.sessions.clear();
  h.ports.length = 0;
  h.logs.length = 0;
  h.noSandbox = false;
  h.sandboxed = true;
  h.persistent = false;
  h.loadError = null;
  h.loadHangs = false;
  h.loadedUrl = null;
  h.guestFails = false;
  h.clearFails = false;
  vi.stubEnv('SARVINBOX_BUILD_MODE', 'production');
  rootDir = mkdtempSync(join(tmpdir(), 'sarv-sandbox-'));
  writeFileSync(join(rootDir, 'index.js'), 'exports.activate = () => {};');
  mkdirSync(join(rootDir, 'lib'));
  writeFileSync(join(rootDir, 'lib', 'a b.js'), 'exports.a = 1;');
  writeFileSync(join(rootDir, 'data.json'), '{"x":1}');
  writeFileSync(join(rootDir, 'notes.txt'), 'not code');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: HOST_PLATFORM, configurable: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(rootDir, { recursive: true, force: true });
});

describe('the renderer extension code runs in', () => {
  // Each of these is a step towards Node or the disk. A renderer with a Node bridge or
  // no isolation would make everything else in this file decoration.
  it('is sandboxed, isolated and has no Node, with only its own preload', async () => {
    const { view, ses } = await startChannel();

    expect(view.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      navigateOnDragDrop: false,
      session: ses,
    });
    // Not the app's preload: that one's bridge reaches every IPC channel.
    expect(String(view.options.webPreferences.preload)).toMatch(/extension-sandbox-preload\.js$/);
  });

  // A release build gets no DevTools on a page holding a live port into main.
  it('has DevTools only in a dev run', async () => {
    const { view } = await startChannel();
    expect(view.options.webPreferences.devTools).toBe(false);

    vi.stubEnv('SARVINBOX_BUILD_MODE', 'development');
    const dev = await startChannel('other');
    expect(dev.view.options.webPreferences.devTools).toBe(true);
  });

  // Hidden for good: a throttled renderer would run an extension's timers late.
  it('is not throttled for being hidden', async () => {
    const { view } = await startChannel();
    expect(view.options.webPreferences.backgroundThrottling).toBe(false);
  });

  // The measured reason for one each: a Worker out of memory crashes its renderer,
  // and two Workers of one origin read each other's IndexedDB. Sessions are what
  // keep their storage apart, so a shared partition would undo it silently.
  it('gets a session of its own, per extension, never persisted', async () => {
    const first = await startChannel('one');
    const second = await startChannel('two');

    expect(first.ses).not.toBe(second.ses);
    expect(first.view.options.webPreferences.session).toBe(first.ses);
    expect(second.view.options.webPreferences.session).toBe(second.ses);
    expect(first.runtime.sandboxPartition('one').startsWith('persist:')).toBe(false);
  });

  // In-memory is a promise that nothing it stores reaches the disk.
  it('refuses a session that would persist', async () => {
    h.persistent = true;
    await expect(startChannel()).rejects.toThrow('persistent session');
    expect(h.views).toHaveLength(0);
  });

  // Nowhere to go: a navigation would leave the policy behind with the page.
  it('cannot navigate, open a window or embed a page', async () => {
    const { contents } = await startChannel();

    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      const preventDefault = vi.fn();
      contents.emit(event, { preventDefault, url: 'https://evil.example/' });
      expect(preventDefault, event).toHaveBeenCalled();
    }
    expect(contents.openHandler?.()).toEqual({ action: 'deny' });
  });

  // A hidden window would stop `window-all-closed` from ever firing and be found by
  // every `BrowserWindow.getAllWindows()[0]` looking for the app's own.
  it('is a view, not a window', async () => {
    const { runtime } = await startChannel();
    expect(Object.keys(runtime)).not.toContain('BrowserWindow');
    const electron = await import('electron');
    expect(electron.WebContentsView).toBe(FakeView);
    expect(h.views).toHaveLength(1);
  });
});

describe('what the sandbox may reach', () => {
  // The browser-process half: refused where a compromised renderer cannot reach it.
  it.each([
    ['https://evil.example/', true],
    ['http://127.0.0.1:631/', true],
    ['wss://evil.example/', true],
    ['file:///etc/passwd', true],
    ['sarv-extension://victim/index.js', true],
    ['sarv-extension-sandboxx://guest/guest.js', true],
    ['sarv-extension-sandbox://other/guest.js', true],
    ['sarv-extension-sandbox://guest/guest.js', false],
    ['sarv-extension-sandbox://guest/ext/index.js', false],
  ])('%s: cancelled %s', async (url, cancel) => {
    const { ses } = await startChannel();
    const callback = vi.fn();
    ses.beforeRequest?.({ url }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel });
  });

  // Every grant answered no, so no API that asks can get anywhere.
  it('is granted nothing', async () => {
    const { ses } = await startChannel();
    const callback = vi.fn();
    ses.permissionRequest?.(null, 'notifications', callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect(ses.permissionCheck?.()).toBe(false);
    expect(ses.devicePermission?.()).toBe(false);
    // A spellchecker fetches dictionaries from a Google CDN.
    expect(ses.spellcheck).toBe(false);
    const preventDefault = vi.fn();
    ses.emit('will-download', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });

  // A session outlives its sandbox, and a second `protocol.handle` throws: a restart
  // after a crash would otherwise fail, and the extension could never come back.
  it('locks a session once, however many times its sandbox restarts', async () => {
    const runtime = await loadRuntime();
    const target = { extensionId: 'demo', rootDir, entryPoint: join(rootDir, 'index.js') };

    await runtime.createSandboxChannel(target);
    await expect(runtime.createSandboxChannel(target)).resolves.toBeDefined();
  });

  // The scheme is handled in this session and nowhere else, so nothing else can load it.
  it('handles its scheme in its own session', async () => {
    const { ses } = await startChannel();
    expect(ses.scheme).toBe('sarv-extension-sandbox');
  });
});

describe('the policy on what it loads', () => {
  const directive = (csp: string, name: string) =>
    csp.split('; ').find((part) => part.startsWith(`${name} `));

  // `webRequest` does not see WebTransport. This line is all that stops it, and
  // fetch, XHR, WebSocket and EventSource a second time.
  it("lets the Worker connect nowhere", async () => {
    const { SANDBOX_WORKER_CSP } = await loadRuntime();
    expect(directive(SANDBOX_WORKER_CSP, 'connect-src')).toBe("connect-src 'none'");
    expect(directive(SANDBOX_WORKER_CSP, 'default-src')).toBe("default-src 'none'");
    expect(directive(SANDBOX_WORKER_CSP, 'font-src')).toBe("font-src 'none'");
    expect(directive(SANDBOX_WORKER_CSP, 'img-src')).toBe("img-src 'none'");
  });

  // importScripts and import() of anything but its own files, and any way to build a
  // script from a string. A loosened source list here is how a file gets read.
  it('lets the Worker run only its own scripts', async () => {
    const { SANDBOX_WORKER_CSP } = await loadRuntime();
    expect(directive(SANDBOX_WORKER_CSP, 'script-src')).toBe("script-src 'self'");
    expect(SANDBOX_WORKER_CSP).not.toMatch(/unsafe-eval|unsafe-inline|blob:|data:|https?:|file:/);
  });

  // A nested Worker from a blob: would start clean of anything set up on this one.
  it('lets the Worker start no Worker', async () => {
    const { SANDBOX_WORKER_CSP } = await loadRuntime();
    expect(directive(SANDBOX_WORKER_CSP, 'worker-src')).toBe("worker-src 'none'");
  });

  // The page runs nothing of its own and can start only the sandbox's own Worker.
  it('lets the page run no script and start only its own Worker', async () => {
    const { SANDBOX_PAGE_CSP } = await loadRuntime();
    expect(directive(SANDBOX_PAGE_CSP, 'default-src')).toBe("default-src 'none'");
    expect(directive(SANDBOX_PAGE_CSP, 'worker-src')).toBe("worker-src 'self'");
    expect(SANDBOX_PAGE_CSP).not.toMatch(/script-src/);
    expect(directive(SANDBOX_PAGE_CSP, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  // A dedicated Worker takes its policy from its own script's response, not the page:
  // served without this header, the Worker runs under no policy at all.
  it('travels on the response of the Worker script and of every module', async () => {
    const { ses, runtime } = await startChannel();
    const guest = await ses.handler?.(new Request('sarv-extension-sandbox://guest/guest.js'));
    const module = await ses.handler?.(new Request('sarv-extension-sandbox://guest/ext/index.js'));
    const page = await ses.handler?.(new Request('sarv-extension-sandbox://guest/index.html'));

    expect(guest?.headers.get('Content-Security-Policy')).toBe(runtime.SANDBOX_WORKER_CSP);
    expect(module?.headers.get('Content-Security-Policy')).toBe(runtime.SANDBOX_WORKER_CSP);
    expect(page?.headers.get('Content-Security-Policy')).toBe(runtime.SANDBOX_PAGE_CSP);
    expect(guest?.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(guest?.headers.get('Cache-Control')).toBe('no-store');
  });

  // Registered privileges are the other way to loosen a scheme: `bypassCSP` would
  // switch off everything above, and `supportFetchAPI` opens a route for no reason.
  it('is registered with nothing beyond an origin', async () => {
    const { SANDBOX_SCHEME_PRIVILEGES } = await loadRuntime();
    expect(SANDBOX_SCHEME_PRIVILEGES.privileges).toEqual({ standard: true, secure: true });
  });
});

describe('what a sandbox can read', () => {
  const body = async (ses: FakeSession, url: string) => {
    const response = await ses.handler?.(new Request(url));
    return { status: response?.status, text: await response?.text() };
  };

  // The real path, wrapped so `importScripts` can run it. Failing here, no extension runs.
  it('serves a listed module as a call to the loader', async () => {
    const { ses } = await startChannel();
    const { status, text } = await body(ses, 'sarv-extension-sandbox://guest/ext/index.js');

    expect(status).toBe(200);
    expect(text).toContain('__sarvDefineModule("index.js",function(exports,require,module,__filename,__dirname){');
    expect(text).toContain('exports.activate');
  });

  // Measured: `import('./big.js?1')`, `?2` and so on read a 15 MB file 400 times into this
  // process's heap, and ran it out of memory in 0.7 seconds, with no permissions at all.
  it('refuses a query string, on anything', async () => {
    const { ses } = await startChannel();
    for (const url of ['ext/index.js?1', 'guest.js?1', 'index.html?1']) {
      expect((await body(ses, `sarv-extension-sandbox://guest/${url}`)).status).toBe(404);
    }
  });

  // `require` caches, so a second request is only ever an attempt to make this process
  // read the file again. Same for the bootstrap.
  it('serves each file once per sandbox', async () => {
    const { ses } = await startChannel();
    for (const url of ['ext/index.js', 'guest.js', 'index.html']) {
      expect((await body(ses, `sarv-extension-sandbox://guest/${url}`)).status).toBe(200);
      expect((await body(ses, `sarv-extension-sandbox://guest/${url}`)).status).toBe(404);
    }
  });

  // A restart is a new load: it must get everything again.
  it('serves everything again to a restarted sandbox', async () => {
    const runtime = await loadRuntime();
    const target = { extensionId: 'demo', rootDir, entryPoint: join(rootDir, 'index.js') };
    await runtime.createSandboxChannel(target);
    const ses = h.sessions.get(runtime.sandboxPartition('demo')) as FakeSession;
    expect((await body(ses, 'sarv-extension-sandbox://guest/ext/index.js')).status).toBe(200);

    await runtime.createSandboxChannel(target);

    expect((await body(ses, 'sarv-extension-sandbox://guest/ext/index.js')).status).toBe(200);
  });

  // Once each still adds up across a folder of large files read at the same moment.
  it('stops serving past the total for one sandbox', async () => {
    const { MAX_SERVED_BYTES_PER_SANDBOX } = await loadRuntime();
    const size = 15 * 1024 * 1024;
    const count = Math.ceil(MAX_SERVED_BYTES_PER_SANDBOX / size) + 1;
    for (let i = 0; i < count; i += 1) writeFileSync(join(rootDir, `big${i}.js`), 'x'.repeat(size));
    const { ses } = await startChannel();

    const statuses: (number | undefined)[] = [];
    for (let i = 0; i < count; i += 1) {
      statuses.push((await body(ses, `sarv-extension-sandbox://guest/ext/big${i}.js`)).status);
    }

    expect(statuses[0]).toBe(200);
    expect(statuses[count - 1]).toBe(404);
  });

  // Names are encoded on the way in, and may hold anything.
  it('decodes a path segment to find the file', async () => {
    const { ses } = await startChannel();
    expect((await body(ses, 'sarv-extension-sandbox://guest/ext/lib/a%20b.js')).status).toBe(200);
  });

  it('serves JSON as a module exporting it', async () => {
    const { ses } = await startChannel();
    expect((await body(ses, 'sarv-extension-sandbox://guest/ext/data.json')).text).toContain('module.exports={"x":1};');
  });

  // Each of these is a way out of the folder, or a file that is none of a Worker's
  // business. The list makes them all the same thing: not on it.
  it.each([
    ['climbing out', 'sarv-extension-sandbox://guest/ext/../../secret.js'],
    ['encoded climbing', 'sarv-extension-sandbox://guest/ext/%2e%2e%2f%2e%2e%2fsecret.js'],
    ['encoded separators', 'sarv-extension-sandbox://guest/ext/..%2Fsecret.js'],
    ['a Windows path', 'sarv-extension-sandbox://guest/ext/..%5C..%5Csecret.js'],
    ['an absolute path', 'sarv-extension-sandbox://guest/ext/%2Fetc%2Fpasswd'],
    ['a file that is not code', 'sarv-extension-sandbox://guest/ext/notes.txt'],
    ['a missing file', 'sarv-extension-sandbox://guest/ext/nope.js'],
    ['bad percent encoding', 'sarv-extension-sandbox://guest/ext/%E0%A4%A.js'],
    ['outside the module path', 'sarv-extension-sandbox://guest/index.js'],
    ['another host', 'sarv-extension-sandbox://other/ext/index.js'],
  ])('refuses %s', async (_name, url) => {
    writeFileSync(join(rootDir, '..', 'secret.js'), 'SECRET');
    const { ses } = await startChannel();
    expect((await body(ses, url)).status).toBe(404);
    rmSync(join(rootDir, '..', 'secret.js'));
  });

  // A link into the rest of the disk, planted in the folder before or after the
  // sandbox started: `notes.js -> ~/.aws/credentials` must serve nothing.
  it('does not serve through a symbolic link', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'sarv-outside-'));
    writeFileSync(join(outside, 'secret.js'), 'SECRET');
    symlinkSync(join(outside, 'secret.js'), join(rootDir, 'before.js'));
    symlinkSync(outside, join(rootDir, 'linked'));

    const { ses, port } = await startChannel();

    const init = port.posted[0] as { files: string[] };
    expect(init.files).not.toContain('before.js');
    expect(init.files.some((file) => file.startsWith('linked'))).toBe(false);
    expect((await body(ses, 'sarv-extension-sandbox://guest/ext/before.js')).status).toBe(404);
    expect((await body(ses, 'sarv-extension-sandbox://guest/ext/linked/secret.js')).status).toBe(404);

    // Listed as a real file at startup, swapped for a link later.
    rmSync(join(rootDir, 'data.json'));
    symlinkSync(join(outside, 'secret.js'), join(rootDir, 'data.json'));
    expect((await body(ses, 'sarv-extension-sandbox://guest/ext/data.json')).status).toBe(404);
    rmSync(outside, { recursive: true, force: true });
  });

  // A build without the Worker file is a packaging mistake, and must say so.
  it('logs when the Worker script cannot be read', async () => {
    h.guestFails = true;
    const { ses } = await startChannel();
    expect((await body(ses, 'sarv-extension-sandbox://guest/guest.js')).status).toBe(404);
    expect(h.logs.join('\n')).toContain('Could not read the extension Worker script');
  });

  // After a restart, the new sandbox's list is the one that counts, even when the old
  // one finishes closing after the new one started.
  it('keeps a restarted sandbox serving when the old one closes late', async () => {
    const runtime = await loadRuntime();
    const target = { extensionId: 'demo', rootDir, entryPoint: join(rootDir, 'index.js') };
    await runtime.createSandboxChannel(target);
    const firstContents = h.views[0].webContents;
    await runtime.createSandboxChannel(target);

    firstContents.close();

    const ses = h.sessions.get(runtime.sandboxPartition('demo')) as FakeSession;
    expect((await body(ses, 'sarv-extension-sandbox://guest/ext/index.js')).status).toBe(200);
  });
});

describe('the operating system sandbox', () => {
  const OFF = 'Extensions are off because';

  // The rule the design stands on: extension code never starts without it in a
  // release build. No port goes out, so no Worker exists to run anything.
  it.each([
    ['--no-sandbox was passed', () => { h.noSandbox = true; }],
    ['the renderer reports it is not sandboxed', () => { h.sandboxed = false; }],
    ['nothing can say either way', () => { h.sandboxed = undefined; }],
  ])('refuses in a release build when %s', async (_name, setup) => {
    setup();

    await expect(startChannel()).rejects.toThrow(OFF);

    const contents = h.views[0].webContents;
    expect(contents.framePosts).toHaveLength(0);
    expect(contents.destroyed).toBe(true);
    expect(h.logs.join('\n')).toContain('Not starting demo');
  });

  // A dev run passes --no-sandbox by vite-plugin-electron's default, so refusing there
  // would make extensions impossible to work on. It says so instead.
  it('warns and runs in a dev run', async () => {
    vi.stubEnv('SARVINBOX_BUILD_MODE', 'development');
    h.noSandbox = true;

    const { contents } = await startChannel();

    expect(contents.framePosts).toHaveLength(1);
    expect(h.logs.join('\n')).toContain('A release build would refuse to run it');
  });

  it('runs in a release build when it is on', async () => {
    const { contents } = await startChannel();
    expect(contents.framePosts).toHaveLength(1);
  });
});

describe('starting up', () => {
  // A list first, then the protocol: the loader must know what it may load before the
  // engine can be asked to load it.
  it('hands over the port in the top frame, then the list of files', async () => {
    const { contents, port } = await startChannel();

    expect(contents.framePosts).toHaveLength(1);
    expect(contents.framePosts[0].channel).toBe('extension-sandbox:port');
    expect(contents.framePosts[0].ports).toHaveLength(1);
    expect(port.started).toBe(true);
    expect(port.posted[0]).toEqual({
      type: 'sandbox-init',
      files: ['data.json', 'index.js', 'lib/a b.js'],
    });
  });

  // The port is the capability. If the page is anywhere but the sandbox's own URL it
  // goes to nobody.
  it('refuses to hand the port to any other page', async () => {
    h.loadedUrl = 'https://evil.example/';

    await expect(startChannel()).rejects.toThrow('did not load');

    expect(h.views[0].webContents.framePosts).toHaveLength(0);
    expect(h.views[0].webContents.destroyed).toBe(true);
  });

  it('surfaces a page that fails to load, and leaves nothing running', async () => {
    h.loadError = new Error('ERR_FAILED');

    await expect(startChannel()).rejects.toThrow('ERR_FAILED');

    expect(h.views[0].webContents.destroyed).toBe(true);
  });

  // An install must not hang with no error anywhere.
  it('gives up on a page that never loads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    h.loadHangs = true;
    const { PAGE_LOAD_TIMEOUT_MS } = await loadRuntime();

    const pending = startChannel().then(
      () => 'started',
      (error: Error) => error.message
    );
    await vi.waitFor(() => expect(h.views).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(PAGE_LOAD_TIMEOUT_MS + 1);

    expect(await pending).toContain('did not load');
    expect(h.views[0].webContents.destroyed).toBe(true);
  });

  // A folder that cannot be read fails before any renderer exists.
  it('fails before starting anything when the folder cannot be read', async () => {
    const runtime = await loadRuntime();
    await expect(
      runtime.createSandboxChannel({ extensionId: 'x', rootDir: join(rootDir, 'nope'), entryPoint: 'x' })
    ).rejects.toThrow();
    expect(h.views).toHaveLength(0);
  });
});

describe('a hung extension', () => {
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

  // A `while (true)` never sees a polite request. Without this it spins a core until
  // the app quits, while workflows waiting on it time out one by one.
  it('is killed once it has not answered for the allowed number of asks', async () => {
    fake();
    const { channel, contents, runtime } = await startChannel();
    const closed = vi.fn();
    channel.onClose(closed);

    const { HEARTBEAT_INTERVAL_MS, HEARTBEAT_MISSES_ALLOWED } = runtime;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISSES_ALLOWED);
    expect(contents.crashed).toBe(0);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(contents.crashed).toBe(1);
    // Deliberate: it would only hang again, so it is not started again by itself.
    expect(closed).toHaveBeenCalledWith('This extension stopped responding and was stopped.', { transient: false });
    expect(contents.destroyed).toBe(true);
  });

  // The other way to get it wrong: killing an extension for doing its job.
  it('is left alone while it answers', async () => {
    fake();
    const { contents, port, runtime } = await startChannel();

    for (let i = 0; i < runtime.HEARTBEAT_MISSES_ALLOWED * 4; i += 1) {
      vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS);
      const ping = port.posted.filter((m) => (m as { type: string }).type === 'ping').pop() as { nonce: number };
      fromWorker(port, { type: 'pong', nonce: ping.nonce });
    }

    expect(contents.crashed).toBe(0);
  });

  // Code in a loop can post pongs ahead of time, but cannot read the ask it is meant
  // to answer. Counting any pong would let it hang forever.
  it('cannot stay alive by sending answers it never read', async () => {
    fake();
    const { contents, port, runtime } = await startChannel();

    for (let i = 0; i < runtime.HEARTBEAT_MISSES_ALLOWED + 2; i += 1) {
      fromWorker(port, { type: 'pong', nonce: -1 });
      vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS);
    }

    expect(contents.crashed).toBe(1);
  });

  // Counted in timer ticks: a laptop waking from an hour's sleep has missed no ticks,
  // and killing every extension on wake would look like a mass crash.
  it('survives a jump in the clock', async () => {
    fake();
    const { contents, port, runtime } = await startChannel();

    vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS);
    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS);
    const ping = port.posted.filter((m) => (m as { type: string }).type === 'ping').pop() as { nonce: number };
    fromWorker(port, { type: 'pong', nonce: ping.nonce });

    expect(contents.crashed).toBe(0);
  });

  // `ready` arriving before anyone listens would be lost, and the sandbox would read as
  // one that never started, thirty seconds later.
  it('holds what arrives before anyone is listening', async () => {
    const { channel, port } = await startChannel();
    fromWorker(port, { type: 'ready' });

    const received: unknown[] = [];
    channel.onMessage((message) => received.push(message));

    expect(received).toEqual([{ type: 'ready' }]);
  });

  // Measured: main doing 5.2 second tasks back to back got a healthy extension killed, because
  // each answer arrived after the next ask had gone out and only the latest counted.
  it('takes an answer to any ask it has not heard back about, not just the latest', async () => {
    fake();
    const { contents, port, runtime } = await startChannel();

    for (let i = 0; i < runtime.HEARTBEAT_MISSES_ALLOWED * 4; i += 1) {
      vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS);
      const pings = port.posted.filter((m) => (m as { type: string }).type === 'ping') as { nonce: number }[];
      // The answer to the ask before this one: main was busy when this one went out.
      if (pings.length >= 2) fromWorker(port, { type: 'pong', nonce: pings[pings.length - 2].nonce });
    }

    expect(contents.crashed).toBe(0);
  });

  // Code in a loop cannot read an ask it was not sent, so a nonce ahead of the last one
  // sent is a guess, and a good one must not buy it more time.
  it('does not take an answer to an ask that has not been made', async () => {
    fake();
    const { contents, port, runtime } = await startChannel();

    for (let i = 0; i < runtime.HEARTBEAT_MISSES_ALLOWED + 2; i += 1) {
      fromWorker(port, { type: 'pong', nonce: 1_000_000 + i });
      vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS);
    }

    expect(contents.crashed).toBe(1);
  });

  // An answer the transport has no use for is the bridge's to count: otherwise replaying
  // old pongs in a loop would be a flood nothing sees.
  it('passes on a pong it has no use for', async () => {
    const { channel, port } = await startChannel();
    const received: unknown[] = [];
    channel.onMessage((message) => received.push(message));

    fromWorker(port, { type: 'pong', nonce: 1 });
    fromWorker(port, { type: 'ready' });

    expect(received).toEqual([{ type: 'pong', nonce: 1 }, { type: 'ready' }]);
  });

  // The transport's own traffic is not for the engine.
  it('keeps an answer it took from the protocol handlers', async () => {
    fake();
    const { channel, port, runtime } = await startChannel();
    const received: unknown[] = [];
    channel.onMessage((message) => received.push(message));

    vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS);
    const ping = port.posted.filter((m) => (m as { type: string }).type === 'ping').pop() as { nonce: number };
    fromWorker(port, { type: 'pong', nonce: ping.nonce });

    expect(received).toEqual([]);
  });
});

describe('a flooding extension', () => {
  // Measured: `for (;;) console.log('x')` took main to 4.6 GB and a crash in 50 seconds with
  // no permissions at all, and a burst-and-sleep loop that kept answering asks reached 2.7 GB.
  // Nothing about the console passes through the port, so it has to be counted here.
  it('is killed for writing too many console lines', async () => {
    const { channel, contents, runtime } = await startChannel();
    const closed = vi.fn();
    channel.onClose(closed);

    for (let i = 0; i <= runtime.CONSOLE_LINES_PER_TICK; i += 1) contents.emit('console-message', { level: 'info', message: 'x' });

    expect(contents.crashed).toBe(1);
    expect(closed).toHaveBeenCalledWith(expect.stringContaining('far too much to its console'), { transient: false });
  });

  // One enormous line costs what thousands of short ones do.
  it('is killed for writing too much in a few lines', async () => {
    const { contents, runtime } = await startChannel();
    const line = 'x'.repeat(Math.ceil(runtime.CONSOLE_CHARS_PER_TICK / 2));

    contents.emit('console-message', { level: 'info', message: line });
    contents.emit('console-message', { level: 'info', message: line });
    expect(contents.crashed).toBe(0);
    contents.emit('console-message', { level: 'info', message: line });

    expect(contents.crashed).toBe(1);
  });

  // The limit is a rate. A chatty extension over a long day must never add up to it.
  it('starts counting console lines again each tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { contents, port, runtime } = await startChannel();

    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < runtime.CONSOLE_LINES_PER_TICK; i += 1) contents.emit('console-message', { level: 'info', message: 'x' });
      vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS);
      const ping = port.posted.filter((m) => (m as { type: string }).type === 'ping').pop() as { nonce: number };
      fromWorker(port, { type: 'pong', nonce: ping.nonce });
    }

    expect(contents.crashed).toBe(0);
  });

  // `console` in a loop is a log flood through a side door.
  it('has its console output budgeted, attributed and capped', async () => {
    const { contents } = await startChannel();

    for (let i = 0; i < 1000; i += 1) contents.emit('console-message', { level: 'info', message: `line ${i}` });
    contents.emit('console-message', { level: 'error', message: 'x'.repeat(100_000) });

    const lines = h.logs.filter((line) => line.startsWith('[Extension:demo]'));
    expect(lines.length).toBeLessThan(250);
    expect(lines[0]).toBe('[Extension:demo] line 0');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(5_000);
  });

  it('logs console warnings and errors at their own level', async () => {
    const { contents } = await startChannel();
    contents.emit('console-message', { level: 'warning', message: 'careful' });
    contents.emit('console-message', { level: 'error', message: 'refused by CSP' });
    expect(h.logs.join('\n')).toContain('careful');
    expect(h.logs.join('\n')).toContain('refused by CSP');
  });

  // Each request runs a handler in this process. Once its own files are loaded an extension
  // has no use for more, and a loop of them spends main's time whatever they answer.
  it('is killed for asking for files too many times', async () => {
    const { contents, ses, runtime } = await startChannel();

    for (let i = 0; i <= runtime.REQUESTS_PER_TICK; i += 1) {
      await ses.handler?.(new Request(`sarv-extension-sandbox://guest/ext/nope${i}.js`));
    }

    expect(contents.crashed).toBe(1);
  });

  // The bridge's call, made through this: a flood seen there has to be able to end it.
  it('can be killed by the bridge', async () => {
    const { channel, contents } = await startChannel();
    const closed = vi.fn();
    channel.onClose(closed);

    channel.kill?.('This extension sent far too many messages to the app and was stopped.');

    expect(contents.crashed).toBe(1);
    expect(closed).toHaveBeenCalledWith(expect.stringContaining('far too many'), { transient: false });
    expect(contents.destroyed).toBe(true);
  });
});

describe('what a refused call tells the user', () => {
  const blocked = "Connecting to 'https://x/' violates the following Content Security Policy directive: \"connect-src 'none'\".";

  // An extension's own `catch` swallows "Failed to fetch". Chromium's line about it is the
  // only thing left that can say why an old extension does nothing at all.
  it('reports a network refusal from the console, once', async () => {
    const { channel, contents } = await startChannel();
    const received: unknown[] = [];
    channel.onMessage((message) => received.push(message));

    contents.emit('console-message', { level: 'error', message: blocked });
    contents.emit('console-message', { level: 'error', message: blocked });

    expect(received).toEqual([{ type: 'unsupported-api', extensionId: 'demo', api: 'network' }]);
  });

  it('reports loading remote code separately', async () => {
    const { channel, contents } = await startChannel();
    const received: unknown[] = [];
    channel.onMessage((message) => received.push(message));

    contents.emit('console-message', { level: 'error', message: blocked });
    contents.emit('console-message', {
      level: 'error',
      message: "Loading the script 'https://x/' violates the following Content Security Policy directive: \"script-src 'self'\".",
    });

    expect(received).toEqual([
      { type: 'unsupported-api', extensionId: 'demo', api: 'network' },
      { type: 'unsupported-api', extensionId: 'demo', api: 'remote-code' },
    ]);
  });

  it('says nothing about ordinary logging', async () => {
    const { channel, contents } = await startChannel();
    const received: unknown[] = [];
    channel.onMessage((message) => received.push(message));

    contents.emit('console-message', { level: 'info', message: 'hello' });

    expect(received).toEqual([]);
  });
});

describe('when a sandbox goes away', () => {
  // The reason reaches the user: "crashed" and "ran out of memory" tell them something.
  it.each([
    ['crashed', 'crashed and was stopped'],
    ['oom', 'ran out of memory'],
    ['killed', 'was stopped'],
    ['clean-exit', 'stopped'],
  ])('closes the channel with a reason when the process is gone (%s)', async (reason, expected) => {
    const { channel, contents } = await startChannel();
    const closed = vi.fn();
    channel.onClose(closed);

    contents.emit('render-process-gone', {}, { reason });

    // Nothing here killed it, so it may well run if started again.
    expect(closed).toHaveBeenCalledWith(expect.stringContaining(expected), { transient: true });
    expect(contents.destroyed).toBe(true);
  });

  // The port closes a moment before the process-gone event, measured, and the second
  // is the one that knows why. Reporting on the first would lose the reason every time.
  it('waits a moment after the port closes, for the reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { channel, contents, port } = await startChannel();
    const closed = vi.fn();
    channel.onClose(closed);

    port.close();
    expect(closed).not.toHaveBeenCalled();
    contents.emit('render-process-gone', {}, { reason: 'oom' });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(expect.stringContaining('ran out of memory'), { transient: true });
  });

  // An extension calling `self.close()` has no crash behind it, and nothing would ever
  // say so: a workflow left wired to it would fail on every message.
  it('reports a Worker that ended by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { channel, port } = await startChannel();
    const closed = vi.fn();
    channel.onClose(closed);

    port.close();
    vi.advanceTimersByTime(1_000);

    // Its own doing: a Worker closing itself is no crash to recover from.
    expect(closed).toHaveBeenCalledWith('This extension stopped unexpectedly.', { transient: false });
  });

  // A crash during startup can beat the host's own subscription.
  it('tells a late close handler, with the reason', async () => {
    const { channel, contents } = await startChannel();
    contents.emit('render-process-gone', {}, { reason: 'crashed' });

    const late = vi.fn();
    channel.onClose(late);

    expect(late).toHaveBeenCalledWith(expect.stringContaining('crashed'), { transient: true });
  });

  // One failure must reach every handler, and exactly once.
  it('tells each handler once, past one that throws', async () => {
    const { channel, contents } = await startChannel();
    const second = vi.fn();
    channel.onClose(() => {
      throw new Error('handler bug');
    });
    channel.onClose(second);

    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    contents.emit('render-process-gone', {}, { reason: 'crashed' });

    expect(second).toHaveBeenCalledTimes(1);
  });

  // Nothing to a dead port: an exception here lands in the bridge's post path.
  it('drops messages posted after it is gone', async () => {
    const { channel, contents, port } = await startChannel();
    channel.post({ type: 'one' });
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    channel.post({ type: 'two' });

    expect(port.posted).toContainEqual({ type: 'one' });
    expect(port.posted).not.toContainEqual({ type: 'two' });
  });

  // Stopped timers: a heartbeat left running would ask a dead port forever.
  it('stops asking once it is gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { contents, port, runtime } = await startChannel();
    contents.emit('render-process-gone', {}, { reason: 'crashed' });

    const before = port.posted.length;
    vi.advanceTimersByTime(runtime.HEARTBEAT_INTERVAL_MS * 3);

    expect(port.posted.length).toBe(before);
  });
});

describe('what it leaves behind', () => {
  // Measured: 3 GB written to OPFS took main from 190 MB to 2.19 GB, and stayed there after
  // the extension had gone. The session outlives the sandbox, so it has to be told.
  it('clears the session storage when it goes', async () => {
    const { contents, ses } = await startChannel();
    expect(ses.storageCleared).toBe(0);

    contents.emit('render-process-gone', {}, { reason: 'crashed' });

    expect(ses.storageCleared).toBe(1);
  });

  it('logs a failure to clear it, and carries on', async () => {
    h.clearFails = true;
    const { contents } = await startChannel();

    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(contents.destroyed).toBe(true);
    expect(h.logs.join('\n')).toContain('Could not clear the sandbox storage');
  });
});

describe('closing', () => {
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

  // Graceful first: the Worker closes itself once deactivate() has run. The kill exists
  // only for a hook that never returns, and must not fire when it leaves on its own.
  it('waits for a clean exit and never kills what leaves by itself', async () => {
    fake();
    const { channel, contents, port, runtime } = await startChannel();

    const closing = channel.close();
    port.close();
    await closing;
    vi.advanceTimersByTime(runtime.SHUTDOWN_GRACE_MS * 2);

    expect(contents.crashed).toBe(0);
    expect(contents.destroyed).toBe(true);
  });

  // A hook that hangs must not hold up quitting.
  it('kills what will not exit within the grace period', async () => {
    fake();
    const { channel, contents, runtime } = await startChannel();

    const closing = channel.close();
    vi.advanceTimersByTime(runtime.SHUTDOWN_GRACE_MS + 1);
    await closing;

    expect(contents.crashed).toBe(1);
    expect(contents.destroyed).toBe(true);
  });

  // Quitting waits on this: a promise that resolves before the page is gone means the
  // process exits with a live view, which is a segmentation fault (measured).
  it('resolves only once the page is gone', async () => {
    const { channel, contents, port } = await startChannel();
    let done = false;
    const closing = (channel.close() as Promise<void>).then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(done).toBe(false);

    port.close();
    await closing;
    expect(done).toBe(true);
    expect(contents.destroyed).toBe(true);
  });

  // Asked for, so not reported as a failure.
  it('gives no reason for a close it was asked for', async () => {
    const { channel, port } = await startChannel();
    const closed = vi.fn();
    channel.onClose(closed);

    const closing = channel.close();
    port.close();
    await closing;

    expect(closed).toHaveBeenCalledWith(undefined, undefined);
  });

  it('is harmless once already closed', async () => {
    const { channel, contents } = await startChannel();
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await expect(channel.close()).resolves.toBeUndefined();
  });

  // Measured: `process.exit` with one of these views still open is a segmentation
  // fault in the main process. The quit path gives teardown three seconds and exits
  // regardless, so a hung IMAP logout must not turn into a crash report.
  it('closes every sandbox as the process exits', async () => {
    const before = process.listeners('exit').length;
    const { contents } = await startChannel();
    const added = process.listeners('exit').slice(before);

    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    process.removeListener('exit', added[0] as () => void);

    expect(contents.destroyed).toBe(true);
  });

  // Registered once, not once per sandbox: a dozen restarts would otherwise warn about
  // a listener leak.
  it('registers the exit hook only once', async () => {
    const before = process.listeners('exit').length;
    const runtime = await loadRuntime();
    const target = { extensionId: 'demo', rootDir, entryPoint: join(rootDir, 'index.js') };
    await runtime.createSandboxChannel(target);
    await runtime.createSandboxChannel(target);
    const added = process.listeners('exit').slice(before);

    expect(added).toHaveLength(1);
    process.removeListener('exit', added[0] as () => void);
  });
});
