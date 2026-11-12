/**
 * Runs one extension's code where it cannot read the user's files or reach the
 * network on its own, and supervises it there.
 *
 * Extensions used to run as full Node in a `utilityProcess`, with everything the
 * user's account can touch. Node cannot confine itself: Electron drops the
 * `--permission` flag for a utility process, the `NODE_OPTIONS` fuse is off, Node
 * has no network permission at all, and `vm` can be escaped. So the code runs where
 * a web page runs, and Chromium does the confining. Each extension gets:
 *
 *   - a Web Worker, so no DOM, no navigation and no `Image`;
 *   - in a hidden `sandbox: true` renderer of its own, because a Worker that runs
 *     out of memory crashes its whole renderer, measured, and so must not share one;
 *   - in an in-memory session of its own, because two Workers of one origin read
 *     each other's IndexedDB and BroadcastChannel, also measured, and nothing about
 *     the session should touch the disk.
 *
 * Then the network and the disk are closed twice, in the browser process and in
 * the renderer:
 *
 *   - `webRequest` in that session cancels every request but the sandbox's own;
 *   - the worker's Content-Security-Policy is `default-src 'none'`. This is not
 *     redundant: `webRequest` does not see WebTransport, and only CSP stops it;
 *   - the custom scheme is handled only in that session, and serves only the fixed
 *     bootstrap plus the extension's listed files (`extension-sandbox-files.ts`).
 *
 * What the extension can then do is ask, over one `MessageChannelMain` port. Main
 * reads that port as this extension and nobody else, so nothing on it is believed
 * about who sent it. The page has a preload only to receive the port, and no way
 * to call `ipcMain` (`ipc-sender-guard.ts` refuses it: it is not the app's window).
 *
 * A `WebContentsView` with no window, not a hidden `BrowserWindow`: a window would
 * stop `window-all-closed` from ever firing, and would be found by every
 * `BrowserWindow.getAllWindows()` looking for the app's own.
 *
 * In a release build, code does not start unless the operating system's sandbox is
 * really on for that renderer (`os-sandbox-state.ts`). The extension is held back
 * and the user told. A dev run passes `--no-sandbox` by default and gets a warning.
 */

import * as fs from 'fs';
import { join } from 'path';

import {
  createLogBudget,
  createLogger,
  MAX_EXTENSION_LOG_LINE,
  refusalInConsoleLine,
  withTimeout,
  type ExtensionChannel,
  type SandboxCloseDetails,
  type SandboxTarget,
} from '@sarvinbox/core';
import {
  app,
  MessageChannelMain,
  session,
  WebContentsView,
  type MessagePortMain,
  type Session,
  type WebContents,
  type WebPreferences,
} from 'electron';

import {
  SANDBOX_GUEST_URL,
  SANDBOX_HOST,
  SANDBOX_MODULE_PATH_PREFIX,
  SANDBOX_ORIGIN,
  SANDBOX_PAGE_URL,
  SANDBOX_PORT_CHANNEL,
  SANDBOX_SCHEME,
  type SandboxInitMessage,
} from '../extension-sandbox/constants';
import { isReleaseBundle } from '../utils/dev-mode';

import { listModuleFiles, readModuleFile, wrapModuleSource } from './extension-sandbox-files';
import { osSandboxRefusal, readOsSandboxState } from './os-sandbox-state';

const logger = createLogger('extension-runtime');

/** How long a closing sandbox gets to run `deactivate()` before it is killed. */
export const SHUTDOWN_GRACE_MS = 5_000;

/** How long the empty page gets to load before the sandbox is given up on. */
export const PAGE_LOAD_TIMEOUT_MS = 15_000;

/** How often a sandbox is asked whether it is still running. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Unanswered asks before it is killed: 30 seconds of a Worker whose event loop has
 * not run once. Counted in ticks of a timer rather than by the clock, so a laptop
 * waking from sleep, where time jumped and no timer fired, does not look like a hang.
 */
export const HEARTBEAT_MISSES_ALLOWED = 6;

/**
 * Console lines per heartbeat tick above which an extension is killed. Each is an IPC to
 * this process, and nothing else limits them: measured, `for (;;) console.log('x')` took
 * main to 4.6 GB and a crash in 50 seconds, and a burst-and-sleep loop that kept answering
 * asks reached 2.7 GB. A thousand a second is far past anything worth reading.
 */
export const CONSOLE_LINES_PER_TICK = 5_000;

/** The same, in characters: one enormous line costs what thousands of short ones do. */
export const CONSOLE_CHARS_PER_TICK = 16 * 1024 * 1024;

/**
 * Requests to the sandbox's own scheme per tick above which an extension is killed. Each
 * runs a handler in this process. Loading its own files takes a handful, once.
 */
export const REQUESTS_PER_TICK = 2_000;

/**
 * The most of an extension's own files served to one sandbox. Files are read whole into
 * this process's heap, and an `import()` of a 15 MB file 400 times over ran it out of
 * memory in 0.7 seconds. A published extension is under 1 MB.
 */
export const MAX_SERVED_BYTES_PER_SANDBOX = 64 * 1024 * 1024;

/** How long to wait, after the port closes, for the process to say why. */
const CLOSE_REASON_GRACE_MS = 150;

/** Said when an extension's Worker ended without being asked and nothing says why. */
const STOPPED_UNEXPECTEDLY = 'This extension stopped unexpectedly.';

/**
 * Registered from `main.ts` BEFORE `app.whenReady()`, in the one call with the other
 * schemes. `standard` so a page and Worker can have an origin; `secure` so the origin
 * counts as a secure context. Nothing else: no fetch, no CORS, no bypassing CSP.
 */
export const SANDBOX_SCHEME_PRIVILEGES = {
  scheme: SANDBOX_SCHEME,
  privileges: { standard: true, secure: true },
} as const;

/** Headers on every response: nothing is cached, sniffed or shared with another origin. */
const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

/**
 * The page's policy. It runs no script of its own (the preload is outside CSP) and
 * can start only the sandbox's own Worker.
 */
export const SANDBOX_PAGE_CSP = [
  "default-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The policy the extension's code runs under. A dedicated Worker takes its policy
 * from its own script's response, not from the page, so this travels on `guest.js`.
 *
 * `connect-src 'none'` covers `fetch`, XHR, WebSocket, EventSource and WebTransport.
 * `script-src 'self'` covers `importScripts` and `import()` of anything but the
 * extension's own files, and forbids `eval`. `worker-src 'none'` stops a nested
 * Worker, which would start clean of anything set up on this one.
 */
export const SANDBOX_WORKER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'none'",
  "worker-src 'none'",
  "font-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Worker APIs turned off outright rather than left to refuse: devices, notifications
 * and the sandboxed filesystem, none of which an extension has any way to ask for.
 * `navigator.serial` and `navigator.gpu` do not go away with this, but the permission
 * handlers below answer no to the first, and neither reaches a file or a network.
 */
const DISABLED_BLINK_FEATURES =
  'WebSocketStream,WebUSB,WebHID,Notifications,BackgroundFetch,FileSystem,FileSystemAccess';

/** The sandbox page's security boundary, kept where a test can read it. */
export function sandboxWebPreferences(options: {
  preload: string;
  session: Session;
  devTools: boolean;
}): WebPreferences {
  return {
    session: options.session,
    preload: options.preload,
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
    images: false,
    webgl: false,
    spellcheck: false,
    enableWebSQL: false,
    disableDialogs: true,
    disableBlinkFeatures: DISABLED_BLINK_FEATURES,
    // Off screen for good, so the renderer must not be throttled for being hidden:
    // a card's countdown or a debounced save would run late.
    backgroundThrottling: false,
    devTools: options.devTools,
  };
}

/** The in-memory session of one extension, by name. Never `persist:`. */
export function sandboxPartition(extensionId: string): string {
  return `sarv-extension-sandbox-${extensionId}`;
}

/** The bundled Worker script, read once, from inside `app.asar` when packaged. */
let guestSource: Promise<string> | null = null;
function readGuestSource(): Promise<string> {
  guestSource ??= fs.promises.readFile(join(__dirname, 'extension-sandbox-guest.js'), 'utf8');
  guestSource.catch(() => {
    guestSource = null;
  });
  return guestSource;
}

/** One sandbox's files. A session outlives its sandbox, so a restart lists them afresh. */
interface ServedExtension {
  rootDir: string;
  files: ReadonlySet<string>;
  /**
   * What has been served already. `require` caches, so a file is loaded once and a second
   * request is only ever an attempt to make this process read it again.
   */
  alreadyServed: Set<string>;
  servedBytes: number;
  /** Told about every request, so that asking endlessly costs the extension its sandbox. */
  noteRequest(): void;
}

const served = new Map<string, ServedExtension>();

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: COMMON_HEADERS });
}

const scriptResponse = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Security-Policy': SANDBOX_WORKER_CSP,
    },
  });

/**
 * Serve one request of one extension's sandbox: the empty page, the Worker's
 * script, or a file on that extension's list.
 */
async function handleSandboxRequest(partition: string, request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  // Not `url.origin`: Node answers 'null' for a scheme it does not know.
  if (url.protocol !== `${SANDBOX_SCHEME}:` || url.host !== SANDBOX_HOST) return notFound();
  const extension = served.get(partition);
  extension?.noteRequest();
  // Nothing here takes a query, and one is only a way past the browser's own module map:
  // `import('./big.js?1')`, `?2` and so on, each a separate read of the whole file here.
  if (url.search) return notFound();

  if (url.pathname === new URL(SANDBOX_PAGE_URL).pathname) {
    if (extension?.alreadyServed.has(url.pathname)) return notFound();
    extension?.alreadyServed.add(url.pathname);
    return new Response('<!doctype html><title>Extension sandbox</title>', {
      status: 200,
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': SANDBOX_PAGE_CSP,
      },
    });
  }

  if (url.pathname === new URL(SANDBOX_GUEST_URL).pathname) {
    if (extension?.alreadyServed.has(url.pathname)) return notFound();
    extension?.alreadyServed.add(url.pathname);
    try {
      return scriptResponse(await readGuestSource());
    } catch (error) {
      // A packaging mistake. The Worker will not start, and this says why.
      logger.error('Could not read the extension Worker script:', error);
      return notFound();
    }
  }

  if (!url.pathname.startsWith(SANDBOX_MODULE_PATH_PREFIX)) return notFound();
  if (!extension) return notFound();

  let relativePath: string;
  try {
    relativePath = url.pathname
      .slice(SANDBOX_MODULE_PATH_PREFIX.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
  } catch {
    return notFound();
  }
  if (!extension.files.has(relativePath)) return notFound();
  if (extension.alreadyServed.has(relativePath)) return notFound();
  extension.alreadyServed.add(relativePath);

  try {
    const text = await readModuleFile(extension.rootDir, relativePath);
    if (text === null) return notFound();
    extension.servedBytes += text.length;
    if (extension.servedBytes > MAX_SERVED_BYTES_PER_SANDBOX) return notFound();
    return scriptResponse(wrapModuleSource(relativePath, text));
  } catch {
    return notFound();
  }
}

/**
 * Every running sandbox's view. A view nothing refers to is collected, and its page
 * and Worker go with it, so this is what keeps a running extension running.
 */
const liveViews = new Set<WebContentsView>();

/**
 * Close whatever sandbox is still open as the process ends.
 *
 * Measured on Electron 44: exiting with one of these views still open is a
 * segmentation fault in the main process, on every platform's crash reporter and
 * in front of the user. A quit does normally close them first, but it gives the
 * whole teardown three seconds, then calls `process.exit` regardless: a hung IMAP
 * logout, or an extension's hook that will not return, must not turn into that.
 */
function closeEverySandbox(): void {
  for (const view of liveViews) {
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    } catch {
      // Exiting anyway.
    }
  }
  liveViews.clear();
}

let closingOnExit = false;
function closeSandboxesOnExit(): void {
  if (closingOnExit) return;
  closingOnExit = true;
  process.once('exit', closeEverySandbox);
}

/** Sessions already locked down. A session outlives its sandbox, and handlers are once only. */
const hardenedSessions = new Set<string>();

/**
 * Lock one extension's session: nothing leaves it, nothing is granted in it, and
 * nothing it holds reaches the disk. Refuses a session that is not in-memory.
 */
function hardenedSession(partition: string): Session {
  const ses = session.fromPartition(partition, { cache: false });
  if (ses.isPersistent()) throw new Error(`Refusing a persistent session: ${partition}`);
  if (hardenedSessions.has(partition)) return ses;

  ses.protocol.handle(SANDBOX_SCHEME, (request) => handleSandboxRequest(partition, request));

  // Checked in the browser process, where a compromised renderer cannot reach it.
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${SANDBOX_ORIGIN}/`) });
  });

  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.on('will-download', (event) => event.preventDefault());

  hardenedSessions.add(partition);
  return ses;
}

/** A page that has nowhere to go: no navigation, no window, no embedded page. */
function lockNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** A sentence for the user, from the process-gone reason Chromium gives. */
function goneReason(reason: string): string {
  if (reason === 'oom') return 'This extension ran out of memory and was stopped.';
  if (reason === 'killed') return 'This extension was stopped.';
  if (reason === 'clean-exit') return 'This extension stopped.';
  return 'This extension crashed and was stopped.';
}

/**
 * Refuse to run extension code unless the OS sandbox is really on for this renderer.
 * Runs after the empty page loads and before the Worker exists, so no extension
 * code has started when it refuses.
 */
function assertOsSandbox(contents: WebContents, extensionId: string): void {
  const state = readOsSandboxState({
    platform: process.platform,
    pid: contents.getOSProcessId(),
    noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
    metricSandboxed: (pid) => app.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed,
  });
  if (state === 'active') return;
  if (isReleaseBundle()) {
    logger.error(`Not starting ${extensionId}: the OS sandbox is ${state}`);
    throw new Error(osSandboxRefusal({ platform: process.platform, appImage: Boolean(process.env.APPIMAGE) }));
  }
  logger.warn(
    `The OS sandbox is ${state} (a dev run passes --no-sandbox): ${extensionId} is confined ` +
      'by the session and CSP only. A release build would refuse to run it.'
  );
}

/**
 * Start one extension's sandbox and return the channel to it.
 *
 * The channel is the only thing the caller gets: there is no handle to the process,
 * because nothing above this line should be making decisions about it. The sandbox
 * going away for any reason closes the channel, and the host treats that as that one
 * extension having stopped.
 */
export async function createSandboxChannel(target: SandboxTarget): Promise<ExtensionChannel> {
  const { extensionId, rootDir } = target;
  const partition = sandboxPartition(extensionId);
  logger.info(`Starting a sandbox for ${extensionId}`);

  const files = await listModuleFiles(rootDir);
  let requestsThisTick = 0;
  const servedFiles: ServedExtension = {
    rootDir,
    files: new Set(files),
    alreadyServed: new Set(),
    servedBytes: 0,
    noteRequest: () => {
      requestsThisTick += 1;
      if (requestsThisTick > REQUESTS_PER_TICK) {
        kill('This extension asked for its own files far too many times and was stopped.');
      }
    },
  };
  served.set(partition, servedFiles);

  const ses = hardenedSession(partition);
  const view = new WebContentsView({
    webPreferences: sandboxWebPreferences({
      preload: join(__dirname, 'extension-sandbox-preload.js'),
      session: ses,
      devTools: !isReleaseBundle(),
    }),
  });
  liveViews.add(view);
  closeSandboxesOnExit();
  const contents = view.webContents;
  lockNavigation(contents);

  const closeHandlers: ((reason?: string, details?: SandboxCloseDetails) => void)[] = [];
  let messageHandler: ((message: unknown) => void) | null = null;
  /** What arrived before the caller was listening: `ready` must never be lost to a race. */
  const backlog: unknown[] = [];
  const logBudget = createLogBudget();
  let port: MessagePortMain | null = null;
  let closed = false;
  let closing = false;
  let closeReason: string | undefined;
  let closeDetails: SandboxCloseDetails | undefined;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  /** Resolves once the page is really gone, which is what a quitting app waits for. */
  const destroyed = new Promise<void>((resolve) => contents.once('destroyed', () => resolve()));

  /** Everything the sandbox holds, gone. Safe to call from any path, more than once. */
  const destroyView = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    try {
      port?.close();
    } catch {
      // Already closed from the other end.
    }
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    liveViews.delete(view);
    // What it stored goes with it. This session is in memory, and in the case of OPFS that
    // memory is this process's: measured, 3 GB written took main from 190 MB to 2.19 GB,
    // and it stayed there after the extension had gone.
    void ses.clearStorageData().catch((error: unknown) => {
      logger.warn(`Could not clear the sandbox storage of ${extensionId}:`, error);
    });
    // Unless a restart has already put its own list here.
    if (served.get(partition) === servedFiles) served.delete(partition);
  };

  const notifyClosed = (reason?: string, details?: SandboxCloseDetails): void => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    closeDetails = details;
    destroyView();
    if (reason) logger.warn(`Sandbox for ${extensionId} closed: ${reason}`);
    else logger.info(`Sandbox for ${extensionId} closed`);
    for (const handler of closeHandlers) {
      try {
        handler(reason, details);
      } catch (error) {
        logger.warn('Extension sandbox close handler failed:', error);
      }
    }
  };

  /**
   * Ends a Worker whatever it is doing: a `while (true)` never sees a polite request. A kill
   * is deliberate, so it is not worth starting the extension again by itself.
   */
  const kill = (reason: string): void => {
    if (closed) return;
    if (!contents.isDestroyed()) contents.forcefullyCrashRenderer();
    notifyClosed(reason, { transient: false });
  };

  // Nothing here killed it (`kill` closes first), so it crashed or the OS took it.
  contents.on('render-process-gone', (_event, details) => {
    notifyClosed(goneReason(details.reason), { transient: true });
  });
  void destroyed.then(() =>
    notifyClosed(closing ? undefined : STOPPED_UNEXPECTEDLY, { transient: false })
  );

  // Whatever the extension writes with `console`, and the CSP refusals it runs into,
  // which is what its author needs to see first.
  let consoleLinesThisTick = 0;
  let consoleCharsThisTick = 0;
  const refusalsReported = new Set<string>();
  contents.on('console-message', (event) => {
    if (closed) return;
    consoleLinesThisTick += 1;
    consoleCharsThisTick += event.message.length;
    if (consoleLinesThisTick > CONSOLE_LINES_PER_TICK || consoleCharsThisTick > CONSOLE_CHARS_PER_TICK) {
      kill('This extension wrote far too much to its console and was stopped.');
      return;
    }
    // A blocked `fetch` throws a bare "Failed to fetch" that the extension's own `catch`
    // may well swallow. Chromium's line about it is what says why the extension does nothing.
    const refusal = refusalInConsoleLine(event.message);
    if (refusal && !refusalsReported.has(refusal)) {
      refusalsReported.add(refusal);
      deliver({ type: 'unsupported-api', extensionId, api: refusal });
    }
    const verdict = logBudget.take();
    if (verdict.dropped > 0) {
      logger.warn(`[Extension:${extensionId}] ${verdict.dropped} console lines dropped: too many`);
    }
    if (!verdict.allowed) return;
    const line = `[Extension:${extensionId}] ${event.message.slice(0, MAX_EXTENSION_LOG_LINE)}`;
    if (event.level === 'error') logger.error(line);
    else if (event.level === 'warning') logger.warn(line);
    else logger.info(line);
  });

  /** Hand a message to whoever is listening, or hold it until someone is. */
  const deliver = (message: unknown): void => {
    if (messageHandler) messageHandler(message);
    else backlog.push(message);
  };

  try {
    await withTimeout(contents.loadURL(SANDBOX_PAGE_URL), PAGE_LOAD_TIMEOUT_MS, 'The extension sandbox did not load');
    assertOsSandbox(contents, extensionId);
    // The port goes to this page, in this top frame, or to nobody.
    if (contents.getURL() !== SANDBOX_PAGE_URL) throw new Error('The extension sandbox did not load');
  } catch (error) {
    // Marked closed first: this is a failure to start, reported by the throw below.
    closed = true;
    destroyView();
    throw error;
  }

  const { port1, port2 } = new MessageChannelMain();
  port = port1;

  let unanswered = 0;
  let nonce = 0;
  let lastAnswered = 0;

  port1.on('message', ({ data }) => {
    const message = data as { type?: unknown; nonce?: unknown } | null;
    if (message?.type === 'pong') {
      // Any ask it has not answered yet will do. Holding out for the latest one kills a
      // healthy extension whenever main is too busy to read an answer before the next
      // tick. Code stuck in a loop cannot read an ask at all, so it cannot answer one
      // it was not sent, however many pongs it posts ahead of time.
      const answered = message.nonce;
      if (typeof answered === 'number' && answered > lastAnswered && answered <= nonce) {
        lastAnswered = answered;
        unanswered = 0;
        return;
      }
    }
    // Everything else is the bridge's to read and to count, this stale pong included.
    deliver(data);
  });
  port1.on('close', () => {
    // Asked for, so there is nothing to wait for.
    if (closing) {
      notifyClosed();
      return;
    }
    // Usually a moment ahead of `render-process-gone`, which is the event that
    // knows why, and the reason is what the user is shown.
    const timer = setTimeout(
      () => notifyClosed(STOPPED_UNEXPECTEDLY, { transient: false }),
      CLOSE_REASON_GRACE_MS
    );
    timer.unref?.();
  });
  port1.start();

  heartbeat = setInterval(() => {
    consoleLinesThisTick = 0;
    consoleCharsThisTick = 0;
    requestsThisTick = 0;
    if (unanswered >= HEARTBEAT_MISSES_ALLOWED) {
      kill('This extension stopped responding and was stopped.');
      return;
    }
    unanswered += 1;
    nonce += 1;
    port1.postMessage({ type: 'ping', nonce });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const init: SandboxInitMessage = { type: 'sandbox-init', files };
  contents.mainFrame.postMessage(SANDBOX_PORT_CHANNEL, null, [port2]);
  port1.postMessage(init);

  return {
    post: (message) => {
      if (closed) return;
      port1.postMessage(message);
    },
    onMessage: (handler) => {
      messageHandler = handler;
      for (const message of backlog.splice(0)) handler(message);
    },
    onClose: (handler) => {
      if (closed) {
        handler(closeReason, closeDetails);
        return;
      }
      closeHandlers.push(handler);
    },
    kill,
    close: async () => {
      if (!closed) {
        closing = true;
        // The host has already asked the sandbox to wind down, and the Worker closes
        // itself once `deactivate()` has returned. This is only the backstop: a hook
        // that hangs must not be able to hold up quitting.
        const timer = setTimeout(() => {
          logger.warn(`Sandbox for ${extensionId} did not close in time; terminating`);
          kill('This extension was stopped.');
        }, SHUTDOWN_GRACE_MS);
        // Unreferenced so this timer alone never keeps the app alive.
        timer.unref?.();
        closeHandlers.push(() => clearTimeout(timer));
      }
      await destroyed;
    },
  };
}
