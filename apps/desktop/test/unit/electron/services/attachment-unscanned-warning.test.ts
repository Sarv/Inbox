import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  window: null as any,
  preferences: { read: vi.fn(), remember: vi.fn(), revision: vi.fn() },
}));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: () => h.window }));
vi.mock('../../../../electron/services/attachment-warning-preferences', () => ({ unscannedWarningPreferences: h.preferences }));

import { AttachmentUnscannedWarningBroker, confirmUnscannedAttachment, getPendingUnscannedAttachmentWarning, respondUnscannedAttachmentWarning } from '../../../../electron/services/attachment-unscanned-warning';

const target = { messageId: 'synthetic-message', accountId: 'synthetic-account', filename: 'arakiri_A_50186774_/_3.pdf', action: 'view' as const };
const controllers: AbortController[] = [];
const current = vi.fn(async (): Promise<void> => undefined);

function fixture(options: { timeoutMs?: number; id?: () => string } = {}) {
  let destroyed = false;
  let contentsDestroyed = false;
  const send = vi.fn();
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => contentsDestroyed, send }),
  });
  let activeWindow: typeof window | null = window;
  const remembered = new Set<string>();
  let revision = 0;
  const preferences = {
    revision: vi.fn(() => `synthetic-${revision}`),
    read: vi.fn((accountId: string) => remembered.has(accountId)),
    remember: vi.fn((accountId: string) => { remembered.add(accountId); }),
  };
  const broker = new AttachmentUnscannedWarningBroker({ window: () => activeWindow, preferences, ...options });
  const start = (overrides: Partial<typeof target> = {}, assertion = current) => {
    const controller = new AbortController(); controllers.push(controller);
    const promise = broker.confirm({ ...target, ...overrides }, controller.signal, assertion);
    void promise.catch(() => undefined);
    return { promise, controller };
  };
  const answer = (choice: 'continue' | 'setup' | 'cancel', dontShowAgain = false, id = broker.snapshot()!.id) => broker.respond({ id, choice, dontShowAgain });
  return { broker, window, send, preferences, remembered, start, answer,
    destroy: () => { destroyed = true; window.emit('closed'); },
    destroyContents: () => { contentsDestroyed = true; window.webContents.emit('destroyed'); },
    replaceWindow: () => { activeWindow = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: window.webContents }); },
    missingWindow: () => { activeWindow = null; },
    resetPreference: () => { revision += 1; remembered.clear(); },
  };
}

beforeEach(() => { vi.resetAllMocks(); current.mockResolvedValue(undefined); h.preferences.read.mockReturnValue(false); h.preferences.revision.mockReturnValue('singleton-revision'); });
afterEach(async () => { controllers.splice(0).forEach(controller => controller.abort(new Error('Download cancelled.'))); await Promise.resolve(); vi.useRealTimers(); });

// Breaks: a slash-bearing MIME filename is truncated, a foreign/late answer grants a bypass, or remembered consent outlives its snapshot.
describe('trusted custom unscanned warning broker', () => {
  it.each(['cancel', 'setup', 'continue'] as const)('displays the full metadata filename and resolves %s', async choice => {
    const f = fixture(); const pending = f.start(); const snapshot = f.broker.snapshot()!;
    expect(snapshot).toEqual({ id: expect.any(String), filename: target.filename, accountId: target.accountId, action: 'view' });
    expect(snapshot.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.send).toHaveBeenCalledWith('antivirus:unscannedWarning', snapshot);
    await f.answer(choice);
    expect(await pending.promise).toBe(choice);
    expect(f.send).toHaveBeenCalledWith('antivirus:unscannedWarningClosed', snapshot.id);
    expect(f.broker.snapshot()).toBeNull();
    expect(f.preferences.remember).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(choice === 'continue' ? 1 : 0);
    expect(f.window.listenerCount('closed')).toBe(0);
    expect(f.window.webContents.listenerCount('did-start-navigation')).toBe(0);
  });

  it('uses fallback for empty display names while preserving control characters as plain metadata', async () => {
    const f = fixture(); const first = f.start({ filename: '' });
    expect(f.broker.snapshot()!.filename).toBe('attachment'); await f.answer('cancel'); await first.promise;
    const next = f.start({ filename: 'file\n.pdf' });
    expect(f.broker.snapshot()!.filename).toBe('file\n.pdf'); await f.answer('cancel'); await next.promise;
  });

  it('returns independent snapshot copies, queues up to four warnings, and rejects answering a queued target', async () => {
    const f = fixture(); const pending = Array.from({ length: 4 }, () => f.start());
    const snapshot = f.broker.snapshot()!; snapshot.filename = 'tampered.pdf';
    expect(f.broker.snapshot()!.filename).toBe(target.filename);
    expect(f.send.mock.calls.filter(call => call[0] === 'antivirus:unscannedWarning')).toHaveLength(1);
    await expect(f.start().promise).rejects.toThrow('Too many attachment warnings');
    await expect(f.broker.respond({ id: 'unknown-target', choice: 'continue', dontShowAgain: true })).rejects.toThrow('no longer available');
    for (const item of pending) { await f.answer('cancel'); expect(await item.promise).toBe('cancel'); }
    expect(f.send.mock.calls.filter(call => call[0] === 'antivirus:unscannedWarning')).toHaveLength(4);
    expect(f.preferences.remember).not.toHaveBeenCalled();
  });

  it('ignores a known but queued ID and cancellation dismisses only the cancelled operation', async () => {
    let index = 0; const f = fixture({ id: () => `opaque-${++index}` });
    const first = f.start(); const second = f.start(); const third = f.start();
    await expect(f.answer('continue', true, 'opaque-2')).rejects.toThrow('no longer available');
    second.controller.abort(new Error('Download cancelled.'));
    await expect(second.promise).rejects.toThrow('Download cancelled.');
    expect(f.broker.snapshot()!.id).toBe('opaque-1');
    await f.answer('cancel'); await first.promise;
    expect(f.broker.snapshot()!.id).toBe('opaque-3'); await f.answer('cancel'); await third.promise;
  });

  it.each([null, {}, { id: 1, choice: 'continue', dontShowAgain: true }, { id: 'synthetic', choice: 'invalid', dontShowAgain: true }, { id: 'synthetic', choice: 'continue' }])('rejects malformed input without advancing or persisting', async input => {
    const f = fixture(); const pending = f.start(); const id = f.broker.snapshot()!.id;
    await expect(f.broker.respond(input)).rejects.toThrow('no longer available');
    expect(f.broker.snapshot()!.id).toBe(id); expect(f.preferences.remember).not.toHaveBeenCalled();
    await f.answer('cancel'); await pending.promise;
  });

  it.each(['cancel', 'setup'] as const)('does not remember a %s choice even when the flag is true', async choice => {
    const f = fixture(); const pending = f.start(); await f.answer(choice, true); await pending.promise;
    expect(f.preferences.remember).not.toHaveBeenCalled();
  });

  it('remembers only an explicit Continue after snapshot validation and only for the captured account', async () => {
    const f = fixture(); const pending = f.start(); const id = f.broker.snapshot()!.id;
    await f.answer('continue', true); expect(await pending.promise).toBe('continue');
    expect(current.mock.invocationCallOrder[0]).toBeLessThan(f.preferences.remember.mock.invocationCallOrder[0]!);
    expect(f.preferences.remember).toHaveBeenCalledWith(target.accountId, 'synthetic-0');
    await expect(f.answer('continue', true, id)).rejects.toThrow('no longer available');
    const remembered = f.start(); expect(await remembered.promise).toBe('continue');
    expect(f.send.mock.calls.filter(call => call[0] === 'antivirus:unscannedWarning')).toHaveLength(1);
    const otherAccount = f.start({ accountId: 'other-account' });
    expect(f.broker.snapshot()!.accountId).toBe('other-account'); await f.answer('cancel'); await otherAccount.promise;
    expect(current).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed snapshot before persisting and does not silently bypass remembered warnings', async () => {
    const f = fixture(); const pending = f.start(); current.mockRejectedValue(new Error('Antivirus setup changed. Try again.'));
    await expect(f.answer('continue', true)).rejects.toThrow('Antivirus setup changed');
    expect(f.preferences.remember).not.toHaveBeenCalled(); await f.answer('cancel'); await pending.promise;
    f.remembered.add(target.accountId);
    await expect(f.start().promise).rejects.toThrow('Antivirus setup changed');
  });

  it('fails closed on unreadable preference stores, and write errors leave a warning cancellable', async () => {
    const f = fixture(); f.preferences.read.mockImplementationOnce(() => { throw new Error('Store unreadable'); });
    await expect(f.start().promise).rejects.toThrow('Store unreadable'); expect(f.send).not.toHaveBeenCalled();
    const pending = f.start(); f.preferences.remember.mockImplementationOnce(() => { throw new Error('Store unwritable'); });
    await expect(f.answer('continue', true)).rejects.toThrow('Store unwritable');
    expect(f.broker.snapshot()).not.toBeNull(); await f.answer('cancel'); await pending.promise;
  });

  it.each(['window', 'contents', 'renderer', 'navigation'] as const)('rejects all captured warnings when the %s is lost', async lost => {
    const f = fixture(); const pending = [f.start(), f.start()];
    if (lost === 'window') f.destroy();
    if (lost === 'contents') f.destroyContents();
    if (lost === 'renderer') f.window.webContents.emit('render-process-gone');
    if (lost === 'navigation') {
      f.window.webContents.emit('did-start-navigation', {}, 'https://frame.test', false, false);
      expect(f.broker.snapshot()).not.toBeNull();
      f.window.webContents.emit('did-start-navigation', {}, 'app://reload', false, true);
    }
    for (const item of pending) await expect(item.promise).rejects.toThrow('window is unavailable');
    expect(f.broker.snapshot()).toBeNull(); expect(f.preferences.remember).not.toHaveBeenCalled();
  });

  it.each(['snapshot', 'response', 'remembered'] as const)('rejects a replaced main window during %s', async where => {
    const f = fixture();
    if (where === 'remembered') {
      f.remembered.add(target.accountId); current.mockImplementationOnce(async () => { f.replaceWindow(); });
      await expect(f.start().promise).rejects.toThrow('window is unavailable');
    } else {
      const pending = f.start(); const id = f.broker.snapshot()!.id; f.replaceWindow();
      if (where === 'snapshot') expect(() => f.broker.snapshot()).toThrow('window is unavailable');
      else await expect(f.answer('continue', true, id)).rejects.toThrow('window is unavailable');
      await expect(pending.promise).rejects.toThrow('window is unavailable');
    }
    expect(f.preferences.remember).not.toHaveBeenCalled();
  });

  it('does not open a warning for an unavailable window or already aborted operation', async () => {
    const f = fixture(); f.missingWindow(); await expect(f.start().promise).rejects.toThrow('window is unavailable');
    const controller = new AbortController(); controller.abort(new Error('Download cancelled.'));
    await expect(f.broker.confirm(target, controller.signal, current)).rejects.toThrow('Download cancelled.');
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['messageId', 'accountId', 'filename', 'action', 'assertion'] as const)('rejects an invalid %s target before preference lookup', async field => {
    const f = fixture(); const input: any = { ...target }; if (field !== 'assertion') input[field] = undefined;
    await expect(f.broker.confirm(input, new AbortController().signal, field === 'assertion' ? undefined as any : current)).rejects.toThrow('no longer available');
    expect(f.preferences.read).not.toHaveBeenCalled();
  });

  it('rejects duplicate generated IDs and bounds an unanswered warning lifetime', async () => {
    vi.useFakeTimers(); const f = fixture({ id: () => 'synthetic-duplicate', timeoutMs: 50 });
    const pending = f.start(); await expect(f.start().promise).rejects.toThrow('no longer available');
    await vi.advanceTimersByTimeAsync(50); await expect(pending.promise).rejects.toThrow('expired');
    expect(f.broker.snapshot()).toBeNull();
  });

  it('rejects late and duplicate responses while validation is pending without remembering after cancellation', async () => {
    let finish!: () => void; current.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const f = fixture(); const pending = f.start(); const id = f.broker.snapshot()!.id;
    const answer = f.answer('continue', true); void answer.catch(() => undefined);
    await expect(f.answer('continue', true)).rejects.toThrow('no longer available');
    pending.controller.abort(new Error('Download cancelled.')); await expect(pending.promise).rejects.toThrow('Download cancelled.');
    finish(); await expect(answer).rejects.toThrow('no longer available');
    await expect(f.answer('continue', true, id)).rejects.toThrow('no longer available');
    expect(f.preferences.remember).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after a remembered assertion before automatically continuing', async () => {
    const f = fixture(); f.remembered.add(target.accountId);
    const controller = new AbortController();
    await expect(f.broker.confirm(target, controller.signal, async () => { controller.abort(new Error('Download cancelled.')); })).rejects.toThrow('Download cancelled.');
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['prompt', 'remembered'] as const)('rejects a preference reset between the %s proof resolution and continuation', async mode => {
    const f = fixture(); if (mode === 'remembered') f.remembered.add(target.accountId);
    let finish!: () => void; current.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = f.start();
    const continuation = mode === 'prompt' ? f.answer('continue', true) : pending.promise;
    void continuation.catch(() => undefined);
    // Breaks: reset/config save wins the microtask gap but a late Continue re-saves the obsolete choice.
    finish(); f.resetPreference();
    await expect(continuation).rejects.toThrow('warning preferences changed');
    expect(f.preferences.remember).not.toHaveBeenCalled();
    if (mode === 'prompt') { await f.answer('cancel'); await pending.promise; }
  });

  it('propagates presentation failure and ignores a failed close notification', async () => {
    const f = fixture(); f.send.mockImplementation(() => { throw new Error('Renderer unavailable'); });
    await expect(f.start().promise).rejects.toThrow('Renderer unavailable'); expect(f.broker.snapshot()).toBeNull();
  });

  it('uses the singleton bridge for host warnings and active snapshot responses', async () => {
    const f = fixture(); h.window = f.window;
    const controller = new AbortController(); controllers.push(controller);
    const pending = confirmUnscannedAttachment(target, controller.signal, current);
    const snapshot = getPendingUnscannedAttachmentWarning()!;
    expect(snapshot.filename).toBe(target.filename);
    await respondUnscannedAttachmentWarning({ id: snapshot.id, choice: 'continue', dontShowAgain: true });
    expect(await pending).toBe('continue'); expect(h.preferences.remember).toHaveBeenCalledWith(target.accountId, 'singleton-revision');
    expect(getPendingUnscannedAttachmentWarning()).toBeNull(); h.window = null;
  });
});
