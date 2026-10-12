import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { installIpcSenderGuard, isTrustedIpcSender, type IpcMainLike, type IpcSenderEvent } from '../../../../electron/utils/ipc-sender-guard';

/**
 * Every IPC listener only ever sees the app's own window (CASA L-1). What
 * breaks if this file fails: a second window, a frame given the preload
 * bridge, or a main frame that ended up on another page can call any of the
 * ~360 handlers — the credential vault, mailbox access, account removal — or
 * a refused synchronous message hangs its sender.
 *
 * Verified against real Electron 44 in a scratch harness (main frame trusted
 * before and after reload; a subframe with the bridge, a second window and a
 * navigated main frame refused; a refused sendSync returns null).
 */

const APP_URL = 'file:///Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html';
const webContents = { id: 1 };
const window = { isDestroyed: () => false, webContents };
const mainFrame = { url: `${APP_URL}?t=1`, parent: null };
const appEvent = (): IpcSenderEvent => ({ sender: webContents, senderFrame: mainFrame });

describe('isTrustedIpcSender', () => {
  it('trusts the main window\'s top frame on the app URL (query and hash ignored)', () => {
    expect(isTrustedIpcSender(appEvent(), window, APP_URL)).toBe(true);
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: { url: `${APP_URL}#x`, parent: null } }, window, APP_URL)).toBe(true);
  });

  // Each of these reaches every handler if trusted.
  it.each([
    ['another webContents (a second window)', { sender: { id: 2 }, senderFrame: mainFrame }],
    ['a subframe of the main window', { sender: webContents, senderFrame: { url: APP_URL, parent: mainFrame } }],
    ['the main frame on another local page', { sender: webContents, senderFrame: { url: 'file:///tmp/evil.html', parent: null } }],
    ['the main frame on a remote page', { sender: webContents, senderFrame: { url: 'https://evil.example/', parent: null } }],
    ['a destroyed frame', { sender: webContents, senderFrame: null }],
    ['a frame with no URL', { sender: webContents, senderFrame: { parent: null } }],
  ])('refuses %s', (_label, event) => {
    expect(isTrustedIpcSender(event, window, APP_URL)).toBe(false);
  });

  // Fails closed. Breaks: an early or odd event is let through.
  it('refuses with no main window, a destroyed one, no app URL yet, or anything that throws', () => {
    expect(isTrustedIpcSender(appEvent(), null, APP_URL)).toBe(false);
    expect(isTrustedIpcSender(appEvent(), { isDestroyed: () => true, webContents }, APP_URL)).toBe(false);
    expect(isTrustedIpcSender(appEvent(), window, null)).toBe(false);
    expect(isTrustedIpcSender(null, window, APP_URL)).toBe(false);
    const throwing = { sender: webContents, get senderFrame(): never { throw new Error('Render frame was disposed'); } };
    expect(isTrustedIpcSender(throwing, window, APP_URL)).toBe(false);
  });

  // Dev: the app is the dev server origin.
  it('matches the dev server by origin', () => {
    const devFrame = (url: string) => ({ sender: webContents, senderFrame: { url, parent: null } });
    expect(isTrustedIpcSender(devFrame('http://localhost:5173/?t=9'), window, 'http://localhost:5173')).toBe(true);
    expect(isTrustedIpcSender(devFrame('http://localhost:5173.evil.example/'), window, 'http://localhost:5173')).toBe(false);
  });
});

/** An ipcMain stand-in: handle() keeps the handler, the rest is EventEmitter. */
function fakeIpc() {
  const emitter = new EventEmitter();
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipc = Object.assign(emitter, {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => { handlers.set(channel, fn); },
    handleOnce: (channel: string, fn: (...a: unknown[]) => unknown) => { handlers.set(channel, fn); },
  });
  return { ipc: ipc as unknown as IpcMainLike & EventEmitter, handlers };
}

function guarded(appUrl: string | null = APP_URL) {
  const { ipc, handlers } = fakeIpc();
  const onRefused = vi.fn();
  installIpcSenderGuard(ipc, { mainWindow: () => window, appUrl: () => appUrl, onRefused });
  return { ipc, handlers, onRefused };
}

const foreign = (): IpcSenderEvent => ({ sender: { id: 2 }, senderFrame: mainFrame });

describe('installIpcSenderGuard', () => {
  it('runs an invoke handler for the app and rejects anyone else, saying why', async () => {
    const { ipc, handlers, onRefused } = guarded();
    const handler = vi.fn(() => 'ok');
    ipc.handle('secureCreds:delete', handler);
    expect(handlers.get('secureCreds:delete')!(appEvent(), 'acct')).toBe('ok');
    expect(handler).toHaveBeenCalledWith(expect.anything(), 'acct');
    expect(() => handlers.get('secureCreds:delete')!(foreign(), 'acct')).toThrow('Refused IPC "secureCreds:delete": not from the app window');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(onRefused).toHaveBeenCalledWith('secureCreds:delete', mainFrame.url);
  });

  it('wraps handleOnce too', () => {
    const { ipc, handlers } = guarded();
    ipc.handleOnce('one', () => 'ok');
    expect(() => handlers.get('one')!(foreign())).toThrow('Refused IPC');
  });

  // send / sendSync listeners, Sentry's and log:forward included.
  it.each(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'] as const)(
    'drops a refused %s message, and answers a synchronous one with null instead of hanging it',
    (method) => {
      const { ipc } = guarded();
      const listener = vi.fn((event: { returnValue?: unknown }) => { event.returnValue = 'real'; });
      ipc[method]('appSettings:getAllSync', listener);
      const bad = foreign();
      ipc.emit('appSettings:getAllSync', bad);
      expect(listener).not.toHaveBeenCalled();
      expect(bad.returnValue).toBeNull();
      // The app's own message still arrives: a refused one never consumed a
      // once() listener, so a forged message can't swallow the real reply.
      const good = appEvent();
      ipc.emit('appSettings:getAllSync', good);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(good.returnValue).toBe('real');
    },
  );

  it('delivers a trusted message to an on() listener with its arguments', () => {
    const { ipc } = guarded();
    const listener = vi.fn();
    ipc.on('log:forward', listener);
    ipc.emit('log:forward', appEvent(), { text: 'hi' });
    expect(listener).toHaveBeenCalledWith(expect.anything(), { text: 'hi' });
  });

  // extension-ai-backend removes its per-request listener by reference.
  // Breaks: the wrapper stays registered and every later response is handled
  // by a stale request, which leaks listeners.
  it.each(['removeListener', 'off'] as const)('%s removes the wrapper registered for that listener and channel', (method) => {
    const { ipc } = guarded();
    const listener = vi.fn();
    ipc.on('ai:complete-response', listener);
    ipc.on('other', listener);
    ipc[method]('ai:complete-response', listener);
    expect(ipc.listenerCount('ai:complete-response')).toBe(0);
    expect(ipc.listenerCount('other')).toBe(1);
    // Removing a listener that was never wrapped still goes through.
    const plain = vi.fn();
    (EventEmitter.prototype.on as (c: string, l: unknown) => void).call(ipc, 'raw', plain);
    ipc[method]('raw', plain);
    expect(ipc.listenerCount('raw')).toBe(0);
  });

  // Until main has computed the app URL nothing is trusted.
  it('refuses everything while the app URL is unknown', () => {
    const { ipc, handlers } = guarded(null);
    ipc.handle('ping', () => 'ok');
    expect(() => handlers.get('ping')!(appEvent())).toThrow('Refused IPC');
  });

  // An attacker spamming a channel must not flood app.log.
  it('reports a refused channel once', () => {
    const { ipc, handlers, onRefused } = guarded();
    ipc.handle('ping', () => 'ok');
    for (let i = 0; i < 3; i++) expect(() => handlers.get('ping')!(foreign())).toThrow();
    expect(onRefused).toHaveBeenCalledTimes(1);
  });
});
