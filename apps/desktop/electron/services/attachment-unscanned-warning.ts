import { randomUUID } from 'node:crypto';

import { getMainWindow } from '../shared';

import { unscannedWarningPreferences } from './attachment-warning-preferences';

export type UnscannedWarningAction = 'view' | 'open' | 'download' | 'calendar';
export type UnscannedWarningChoice = 'continue' | 'setup' | 'cancel';
export interface UnscannedWarningRequest {
  id: string;
  filename: string;
  accountId: string;
  action: UnscannedWarningAction;
}
export interface UnscannedWarningResponse {
  id: string;
  choice: UnscannedWarningChoice;
  dontShowAgain: boolean;
}

interface WarningTarget {
  messageId: string;
  accountId: string;
  filename: string;
  action: UnscannedWarningAction;
}
interface WarningPreferences {
  revision(accountId: string): string;
  read(accountId: string): boolean;
  remember(accountId: string, expectedRevision: string): void;
}
interface WarningWindow {
  isDestroyed(): boolean;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
    once(event: string, listener: () => void): unknown;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  };
}
interface PendingWarning {
  payload: UnscannedWarningRequest;
  window: WarningWindow;
  signal: AbortSignal;
  assertCurrent: () => Promise<void>;
  preferenceRevision: string;
  answering: boolean;
  cleanup(): void;
  resolve(choice: UnscannedWarningChoice): void;
  reject(error: unknown): void;
}

const WINDOW_UNAVAILABLE = 'The attachment window is unavailable.';
const WARNING_INVALID = 'This antivirus warning is no longer available.';

/** Only a captured, host-owned operation can create a warning; renderer answers contain no target data. */
export class AttachmentUnscannedWarningBroker {
  private readonly pending = new Map<string, PendingWarning>();
  private activeId: string | undefined;

  constructor(private readonly deps: {
    window(): WarningWindow | null;
    preferences: WarningPreferences;
    id?: () => string;
    timeoutMs?: number;
  }) {}

  snapshot(): UnscannedWarningRequest | null {
    const pending = this.activeId ? this.pending.get(this.activeId) : undefined;
    if (!pending) return null;
    this.assertWindow(pending);
    return { ...pending.payload };
  }

  async confirm(target: WarningTarget, signal: AbortSignal, assertCurrent: () => Promise<void>): Promise<UnscannedWarningChoice> {
    signal.throwIfAborted();
    const window = this.deps.window();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error(WINDOW_UNAVAILABLE);
    if (typeof target.filename !== 'string' || typeof target.accountId !== 'string' || !target.accountId ||
      typeof target.messageId !== 'string' || !target.messageId || typeof assertCurrent !== 'function' ||
      !['view', 'open', 'download', 'calendar'].includes(target.action)) throw new Error(WARNING_INVALID);
    const preferenceRevision = this.deps.preferences.revision(target.accountId);
    if (this.deps.preferences.read(target.accountId)) {
      await assertCurrent();
      signal.throwIfAborted();
      if (this.deps.window() !== window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error(WINDOW_UNAVAILABLE);
      if (this.deps.preferences.revision(target.accountId) !== preferenceRevision) throw new Error('Antivirus warning preferences changed. Try again.');
      return 'continue';
    }
    if (this.pending.size >= 4) throw new Error('Too many attachment warnings are open. Close one and try again.');
    const id = (this.deps.id ?? randomUUID)();
    if (this.pending.has(id)) throw new Error(WARNING_INVALID);
    return new Promise<UnscannedWarningChoice>((resolve, reject) => {
      const onAbort = () => this.finish(id, undefined, signal.reason ?? new Error('Download cancelled.'));
      const onClosed = () => this.finish(id, undefined, new Error(WINDOW_UNAVAILABLE));
      const onNavigation = (_event: unknown, _url: unknown, _isInPlace: unknown, isMainFrame: unknown) => {
        if (isMainFrame === true) onClosed();
      };
      const timeout = setTimeout(() => this.finish(id, undefined, new Error('The antivirus warning expired. Try again.')), this.deps.timeoutMs ?? 5 * 60_000);
      timeout.unref?.();
      const pending: PendingWarning = {
        // MIME filenames may contain slashes. Display metadata exactly; never treat it as a filesystem path.
        payload: { id, filename: target.filename || 'attachment', accountId: target.accountId, action: target.action },
        window, signal, assertCurrent, preferenceRevision, answering: false, resolve, reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
          window.removeListener('closed', onClosed);
          window.webContents.removeListener('destroyed', onClosed);
          window.webContents.removeListener('render-process-gone', onClosed);
          window.webContents.removeListener('did-start-navigation', onNavigation);
        },
      };
      this.pending.set(id, pending);
      signal.addEventListener('abort', onAbort, { once: true });
      window.once('closed', onClosed);
      window.webContents.once('destroyed', onClosed);
      window.webContents.once('render-process-gone', onClosed);
      window.webContents.on('did-start-navigation', onNavigation);
      if (signal.aborted) onAbort();
      else this.presentNext();
    });
  }

  async respond(input: unknown): Promise<void> {
    if (!input || typeof input !== 'object') throw new Error(WARNING_INVALID);
    const response = input as UnscannedWarningResponse;
    if (typeof response.id !== 'string' || !['continue', 'setup', 'cancel'].includes(response.choice) ||
      typeof response.dontShowAgain !== 'boolean') throw new Error(WARNING_INVALID);
    const pending = this.pending.get(response.id);
    if (!pending || this.activeId !== response.id || pending.answering) throw new Error(WARNING_INVALID);
    this.assertWindow(pending);
    pending.signal.throwIfAborted();
    pending.answering = true;
    try {
      if (response.choice === 'continue') {
        // Revalidate setup/account/scanner snapshots before storing or granting any remembered bypass.
        await pending.assertCurrent();
        if (this.pending.get(response.id) !== pending) throw new Error(WARNING_INVALID);
        this.assertWindow(pending);
        pending.signal.throwIfAborted();
        if (this.deps.preferences.revision(pending.payload.accountId) !== pending.preferenceRevision) throw new Error('Antivirus warning preferences changed. Try again.');
        if (response.dontShowAgain) this.deps.preferences.remember(pending.payload.accountId, pending.preferenceRevision);
      }
      this.finish(response.id, response.choice);
    } catch (error) {
      pending.answering = false;
      throw error;
    }
  }

  private assertWindow(pending: PendingWarning): void {
    if (this.deps.window() !== pending.window || pending.window.isDestroyed() || pending.window.webContents.isDestroyed()) {
      this.finish(pending.payload.id, undefined, new Error(WINDOW_UNAVAILABLE));
      throw new Error(WINDOW_UNAVAILABLE);
    }
  }

  private presentNext(): void {
    if (this.activeId) return;
    const pending = this.pending.values().next().value as PendingWarning | undefined;
    if (!pending) return;
    this.activeId = pending.payload.id;
    try {
      this.assertWindow(pending);
      pending.window.webContents.send('antivirus:unscannedWarning', pending.payload);
    } catch (error) {
      this.finish(pending.payload.id, undefined, error);
    }
  }

  private finish(id: string, choice?: UnscannedWarningChoice, error?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    const wasActive = this.activeId === id;
    if (wasActive) this.activeId = undefined;
    try {
      if (!pending.window.isDestroyed() && !pending.window.webContents.isDestroyed()) {
        pending.window.webContents.send('antivirus:unscannedWarningClosed', id);
      }
    } catch { /* A lost window cannot accept another answer. */ }
    if (choice) pending.resolve(choice);
    else pending.reject(error);
    if (wasActive) this.presentNext();
  }
}

const broker = new AttachmentUnscannedWarningBroker({
  window: () => getMainWindow() as unknown as WarningWindow | null,
  preferences: unscannedWarningPreferences,
});

export function confirmUnscannedAttachment(target: WarningTarget, signal: AbortSignal, assertCurrent: () => Promise<void>): Promise<UnscannedWarningChoice> {
  return broker.confirm(target, signal, assertCurrent);
}

export function respondUnscannedAttachmentWarning(response: unknown): Promise<void> {
  return broker.respond(response);
}

export function getPendingUnscannedAttachmentWarning(): UnscannedWarningRequest | null {
  return broker.snapshot();
}
