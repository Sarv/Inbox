/**
 * Every IPC message must come from the app itself: the main window's top-level
 * frame, showing the app's own URL (CASA L-1).
 *
 * The preload bridge runs only in the main frame of the one window (no
 * `nodeIntegrationInSubFrames`), so the email body, the print frame and the
 * extension panels cannot reach `ipcRenderer` today. That is a property of how
 * the window happens to be configured, not something any of the ~360 handlers
 * checks: only a handful compared the sender. A future second window with the
 * preload, a frame given the bridge, or a main frame that ends up on another
 * page would otherwise reach every handler — mailbox access, the credential
 * vault, account removal. So the check is installed once, around `ipcMain`
 * itself, before anything registers: every `handle` and `on` listener, the
 * Sentry SDK's included, only ever sees trusted senders.
 *
 * Fails closed: until the app URL is known, with no main window, with a
 * destroyed frame, or when anything throws while deciding, the sender is not
 * trusted.
 */
import { isAppUrl } from './navigation-policy';

/** The parts of an IPC event the decision reads. */
export interface IpcSenderEvent {
  sender?: unknown;
  senderFrame?: { url?: unknown; parent?: unknown } | null;
  returnValue?: unknown;
}

/** The parts of the main window the decision reads. */
export interface MainWindowLike {
  isDestroyed(): boolean;
  webContents: unknown;
}

/**
 * Whether `event` comes from the app: the main window's webContents, its
 * top-level frame (`parent === null`), on the app URL.
 */
export function isTrustedIpcSender(
  event: IpcSenderEvent | null | undefined,
  mainWindow: MainWindowLike | null | undefined,
  appUrl: string | null | undefined,
): boolean {
  try {
    if (!event || !mainWindow || !appUrl || mainWindow.isDestroyed()) return false;
    if (event.sender !== mainWindow.webContents) return false;
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) return false;
    return typeof frame.url === 'string' && isAppUrl(frame.url, appUrl);
  } catch {
    return false;
  }
}

type Listener = (event: IpcSenderEvent, ...args: unknown[]) => unknown;

/** The `ipcMain` surface the guard wraps. */
export interface IpcMainLike {
  handle(channel: string, listener: Listener): void;
  handleOnce(channel: string, listener: Listener): void;
  on(channel: string, listener: Listener): unknown;
  once(channel: string, listener: Listener): unknown;
  addListener(channel: string, listener: Listener): unknown;
  prependListener(channel: string, listener: Listener): unknown;
  prependOnceListener(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
  off(channel: string, listener: Listener): unknown;
}

export interface IpcSenderGuardDeps {
  mainWindow(): MainWindowLike | null;
  /** The app URL (navigation-policy's): null until main has computed it. */
  appUrl(): string | null;
  /** Told about a refused message (once per channel). */
  onRefused?(channel: string, url: string): void;
}

const LISTENER_METHODS = ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'] as const;
const REMOVE_METHODS = ['removeListener', 'off'] as const;

/**
 * Wrap `ipc`'s registration methods so every listener registered from now on
 * is only called for a trusted sender. A refused `invoke` rejects; a refused
 * `send` is dropped; a refused `sendSync` gets `null` back instead of hanging
 * its sender. Call once, before anything registers a listener.
 */
export function installIpcSenderGuard(ipc: IpcMainLike, deps: IpcSenderGuardDeps): void {
  const refusedChannels = new Set<string>();
  const trusted = (channel: string, event: IpcSenderEvent): boolean => {
    if (isTrustedIpcSender(event, deps.mainWindow(), deps.appUrl())) return true;
    if (!refusedChannels.has(channel)) {
      refusedChannels.add(channel);
      let url = '(no frame)';
      try { if (typeof event?.senderFrame?.url === 'string') url = event.senderFrame.url; } catch { /* destroyed frame */ }
      deps.onRefused?.(channel, url);
    }
    return false;
  };

  // removeListener must find the wrapper it registered for (listener, channel).
  const wrappers = new WeakMap<Listener, Map<string, Listener>>();
  const wrapperFor = (channel: string, listener: Listener): Listener => {
    let byChannel = wrappers.get(listener);
    if (!byChannel) wrappers.set(listener, (byChannel = new Map()));
    let wrapped = byChannel.get(channel);
    if (!wrapped) {
      wrapped = (event, ...args) => {
        if (trusted(channel, event)) return listener(event, ...args);
        // A synchronous sender blocks until it gets a value.
        try { event.returnValue = null; } catch { /* not a sync message */ }
        return undefined;
      };
      byChannel.set(channel, wrapped);
    }
    return wrapped;
  };

  for (const method of ['handle', 'handleOnce'] as const) {
    const original = ipc[method].bind(ipc);
    ipc[method] = (channel: string, listener: Listener) => original(channel, (event, ...args) => {
      if (!trusted(channel, event)) throw new Error(`Refused IPC "${channel}": not from the app window`);
      return listener(event, ...args);
    });
  }
  for (const method of LISTENER_METHODS) {
    const original = ipc[method].bind(ipc);
    ipc[method] = (channel: string, listener: Listener) => original(channel, wrapperFor(channel, listener));
  }
  for (const method of REMOVE_METHODS) {
    const original = ipc[method].bind(ipc);
    ipc[method] = (channel: string, listener: Listener) =>
      original(channel, wrappers.get(listener)?.get(channel) ?? listener);
  }
}
