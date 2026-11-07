/**
 * The first code in an extension's Web Worker, and the thread it shares with it.
 *
 * Starts the sandbox engine on the port main handed over and gives it a CommonJS
 * loader. Nothing here is a security boundary: the extension can reach or replace
 * anything in this file, and main believes nothing that arrives on the port. What
 * confines this thread is outside it (see `services/extension-runtime.ts`).
 *
 * Bundled to one classic script, with no Node module anywhere in it.
 */
import {
  createCommonJsLoader,
  startExtensionSandbox,
  type CommonJsFactory,
  type ExtensionChannel,
  type SandboxExtensionModule,
} from '@sarvinbox/core/extension-sandbox-guest';

import {
  SANDBOX_DEFINE_GLOBAL,
  SANDBOX_MODULE_PATH_PREFIX,
  SANDBOX_ORIGIN,
  type SandboxInitMessage,
} from './constants';

/** The slice of a dedicated worker's global this needs. */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void): void;
  importScripts(...urls: string[]): void;
  close(): void;
  [SANDBOX_DEFINE_GLOBAL]?: (relativePath: string, factory: CommonJsFactory) => void;
}

const scope = globalThis as unknown as WorkerScope;

/**
 * APIs taken away before any extension code runs, none of which it needs.
 *
 * Writes to the origin-private file system land in the main process's memory, because
 * the session is in memory: measured, 3 GB written took main from 190 MB to 2.19 GB.
 * WebGPU survives `disableBlinkFeatures` and hands code a line to the GPU process, and
 * Web Serial survives it too. A Worker has no way to get these back: no iframe, no nested
 * Worker, and their interfaces cannot be constructed.
 */
function removeUnneededApis(): void {
  const remove = (from: object | undefined, name: string): void => {
    if (from) Reflect.deleteProperty(from, name);
  };
  const removeInterface = (name: string, member: string): void => {
    const owner = (globalThis as unknown as Record<string, { prototype?: object } | undefined>)[name];
    remove(owner?.prototype, member);
  };
  removeInterface('StorageManager', 'getDirectory');
  removeInterface('WorkerNavigator', 'gpu');
  removeInterface('WorkerNavigator', 'serial');
  removeInterface('WorkerNavigator', 'storageBuckets');
  for (const name of ['FileSystemHandle', 'FileSystemFileHandle', 'FileSystemDirectoryHandle', 'FileSystemSyncAccessHandle', 'FileSystemWritableFileStream', 'GPU', 'Serial', 'SerialPort']) {
    remove(globalThis, name);
  }
}

removeUnneededApis();

/** The URL a module file is served at. Each segment encoded, as its name may hold anything. */
const moduleUrl = (relativePath: string): string =>
  `${SANDBOX_ORIGIN}${SANDBOX_MODULE_PATH_PREFIX}${relativePath.split('/').map(encodeURIComponent).join('/')}`;

function start(port: MessagePort, init: SandboxInitMessage): void {
  const loader = createCommonJsLoader({
    files: init.files,
    loadFile: (relativePath) => scope.importScripts(moduleUrl(relativePath)),
  });
  scope[SANDBOX_DEFINE_GLOBAL] = loader.define;

  const channel: ExtensionChannel = {
    post: (message) => port.postMessage(message),
    onMessage: (handler) => {
      port.onmessage = (event) => handler(event.data);
    },
    // Main going away takes this whole renderer with it; there is nothing to do.
    onClose: () => undefined,
    // Reached once the extension has been deactivated, which is this Worker's
    // whole job done. Main's kill timer is only the backstop for a hook that hangs.
    close: () => scope.close(),
  };

  const sandbox = startExtensionSandbox(
    channel,
    (entryPoint) => loader.load(entryPoint) as SandboxExtensionModule
  );

  // An error nothing caught is reported, not fatal: this Worker holds nothing
  // durable, and an extension's stray throw should not end it. Main hears about it.
  scope.addEventListener('error', (event) => {
    sandbox.reportUncaught('Uncaught error', event.error ?? event.message);
  });
  scope.addEventListener('unhandledrejection', (event) => {
    sandbox.reportUncaught('Unhandled rejection', event.reason);
  });
}

// `once` by hand: the listener is only for the port that starts everything.
let started = false;
scope.addEventListener('message', (event: MessageEvent) => {
  const [port] = event.ports;
  if (started || !port) return;
  started = true;
  port.onmessage = (first) => {
    port.onmessage = null;
    start(port, first.data as SandboxInitMessage);
  };
});
