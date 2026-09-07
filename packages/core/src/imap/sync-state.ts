// Sync State Machine - Clean state management for IMAP sync

import { EventEmitter } from 'events';

import { logger } from '../utils/logger';

/**
 * Sync state enum
 */
export type SyncState =
  | 'idle'           // Not syncing, ready
  | 'connecting'     // Establishing connection
  | 'syncing'        // Active sync in progress
  | 'realtime'       // Real-time monitoring active
  | 'error'          // Error state
  | 'disconnected';  // Not connected

/**
 * Folder sync state
 */
export interface FolderSyncState {
  path: string;
  status: 'pending' | 'syncing' | 'completed' | 'error';
  lastSyncTime: number | null;
  lastError: Error | null;
  messagesProcessed: number;
  totalMessages: number;
}

/**
 * Overall sync status
 */
export interface SyncStatus {
  state: SyncState;
  currentFolder: string | null;
  foldersCompleted: number;
  foldersTotal: number;
  messagesProcessed: number;
  messagesTotal: number;
  percentComplete: number;
  startTime: number | null;
  lastError: Error | null;
}

/**
 * Sync events
 */
export interface SyncStateEvents {
  'state-change': (state: SyncState, prevState: SyncState) => void;
  'folder-start': (folderPath: string) => void;
  'folder-progress': (folderPath: string, processed: number, total: number) => void;
  'folder-complete': (folderPath: string, success: boolean) => void;
  'sync-complete': (success: boolean) => void;
  'error': (error: Error) => void;
  'new-email': (emailId: string, folderPath: string) => void;
  'email-updated': (emailId: string, folderPath: string, changes: string[]) => void;
  'email-deleted': (emailId: string, folderPath: string) => void;
}

/**
 * Sync State Manager
 *
 * Provides a clean state machine for tracking sync state.
 * Uses events for notifications instead of callbacks.
 */
export class SyncStateManager extends EventEmitter {
  private _state: SyncState = 'idle';
  private _folderStates: Map<string, FolderSyncState> = new Map();
  private _startTime: number | null = null;
  private _lastError: Error | null = null;
  private _currentFolder: string | null = null;
  private _messagesProcessed = 0;
  private _messagesTotal = 0;

  // Track stale syncs
  private static readonly STALE_SYNC_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor() {
    super();
    this.setMaxListeners(20); // Allow more listeners for multiple components
  }

  /**
   * Get current state
   */
  get state(): SyncState {
    return this._state;
  }

  /**
   * Get current status snapshot
   */
  getStatus(): SyncStatus {
    const completedFolders = Array.from(this._folderStates.values())
      .filter(f => f.status === 'completed').length;

    return {
      state: this._state,
      currentFolder: this._currentFolder,
      foldersCompleted: completedFolders,
      foldersTotal: this._folderStates.size,
      messagesProcessed: this._messagesProcessed,
      messagesTotal: this._messagesTotal,
      percentComplete: this._messagesTotal > 0
        ? Math.round((this._messagesProcessed / this._messagesTotal) * 100)
        : 0,
      startTime: this._startTime,
      lastError: this._lastError,
    };
  }

  /**
   * Check if a specific folder is syncing
   */
  isFolderSyncing(folderPath: string): boolean {
    const state = this._folderStates.get(folderPath);
    if (!state) return false;

    if (state.status !== 'syncing') return false;

    // Check for stale sync
    if (state.lastSyncTime) {
      const age = Date.now() - state.lastSyncTime;
      if (age > SyncStateManager.STALE_SYNC_TIMEOUT_MS) {
        logger.warn(`Stale sync detected for ${folderPath}, marking as error`);
        this.setFolderError(folderPath, new Error('Sync timeout'));
        return false;
      }
    }

    return true;
  }

  /**
   * Check if any sync is in progress.
   *
   * Auto-recovers from a stuck "syncing" state — if the state has
   * been "syncing" for longer than STALE_SYNC_TIMEOUT_MS without
   * progress (no completeSync / setError call, e.g. because a network
   * hang aborted the operation outside the try/catch in syncAll),
   * force-resets to "idle" so the next sync click actually runs.
   *
   * Without this, the global state can wedge at "syncing" forever
   * — every subsequent sync silently returns "already in progress",
   * which surfaces in the UI as: "sync shows done but actually
   * nothing synced".
   */
  isSyncing(): boolean {
    if (this._state !== 'syncing') return false;
    if (this._startTime !== null) {
      const age = Date.now() - this._startTime;
      if (age > SyncStateManager.STALE_SYNC_TIMEOUT_MS) {
        logger.warn(
          `Stale global sync detected (running ${Math.round(age / 1000)}s without completion) — auto-resetting to idle`,
        );
        this._currentFolder = null;
        this._startTime = null;
        this._lastError = new Error('Sync timed out — auto-recovered');
        this.transition('idle');
        return false;
      }
    }
    return true;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._state !== 'disconnected' && this._state !== 'connecting';
  }

  /**
   * Transition to a new state
   */
  private transition(newState: SyncState): void {
    if (newState === this._state) return;

    const prevState = this._state;
    this._state = newState;

    logger.debug(`Sync state: ${prevState} -> ${newState}`);
    this.emit('state-change', newState, prevState);
  }

  /**
   * Start sync operation
   */
  startSync(folders: string[]): void {
    if (this._state === 'syncing') {
      logger.warn('Sync already in progress');
      return;
    }

    this._startTime = Date.now();
    this._lastError = null;
    this._messagesProcessed = 0;
    this._messagesTotal = 0;
    this._folderStates.clear();

    // Initialize folder states
    for (const folder of folders) {
      this._folderStates.set(folder, {
        path: folder,
        status: 'pending',
        lastSyncTime: null,
        lastError: null,
        messagesProcessed: 0,
        totalMessages: 0,
      });
    }

    this.transition('syncing');
  }

  /**
   * Start folder sync
   */
  startFolder(folderPath: string, totalMessages: number = 0): void {
    this._currentFolder = folderPath;

    const state = this._folderStates.get(folderPath);
    if (state) {
      state.status = 'syncing';
      state.lastSyncTime = Date.now();
      state.totalMessages = totalMessages;
      this._messagesTotal += totalMessages;
    }

    this.emit('folder-start', folderPath);
  }

  /**
   * Update folder progress
   */
  updateFolderProgress(folderPath: string, processed: number, total?: number): void {
    const state = this._folderStates.get(folderPath);
    if (state) {
      const delta = processed - state.messagesProcessed;
      state.messagesProcessed = processed;
      this._messagesProcessed += delta;

      if (total !== undefined && total !== state.totalMessages) {
        this._messagesTotal += (total - state.totalMessages);
        state.totalMessages = total;
      }
    }

    this.emit('folder-progress', folderPath, processed, total ?? 0);
  }

  /**
   * Complete folder sync
   */
  completeFolder(folderPath: string): void {
    const state = this._folderStates.get(folderPath);
    if (state) {
      state.status = 'completed';
    }

    if (this._currentFolder === folderPath) {
      this._currentFolder = null;
    }

    this.emit('folder-complete', folderPath, true);
  }

  /**
   * Set folder error
   */
  setFolderError(folderPath: string, error: Error): void {
    const state = this._folderStates.get(folderPath);
    if (state) {
      state.status = 'error';
      state.lastError = error;
    }

    if (this._currentFolder === folderPath) {
      this._currentFolder = null;
    }

    this.emit('folder-complete', folderPath, false);
  }

  /**
   * Complete sync operation
   */
  completeSync(success: boolean = true): void {
    this._currentFolder = null;

    if (success) {
      this.transition('idle');
    } else {
      this.transition('error');
    }

    this.emit('sync-complete', success);
  }

  /**
   * Set error state
   */
  setError(error: Error): void {
    this._lastError = error;
    this.transition('error');
    // EventEmitter throws synchronously on 'error' with no listener
    // (Node default) — setError is called from catch blocks, so guard.
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  /**
   * Set connecting state
   */
  setConnecting(): void {
    this.transition('connecting');
  }

  /**
   * Set connected (idle) state
   */
  setConnected(): void {
    this.transition('idle');
  }

  /**
   * Set disconnected state
   */
  setDisconnected(): void {
    this.transition('disconnected');
  }

  /**
   * Set real-time monitoring state
   */
  setRealTimeActive(): void {
    if (this._state !== 'syncing') {
      this.transition('realtime');
    }
  }

  /**
   * Stop real-time monitoring
   */
  stopRealTime(): void {
    if (this._state === 'realtime') {
      this.transition('idle');
    }
  }

  /**
   * Emit new email event
   */
  emitNewEmail(emailId: string, folderPath: string): void {
    this.emit('new-email', emailId, folderPath);
  }

  /**
   * Emit email updated event
   */
  emitEmailUpdated(emailId: string, folderPath: string, changes: string[]): void {
    this.emit('email-updated', emailId, folderPath, changes);
  }

  /**
   * Emit email deleted event
   */
  emitEmailDeleted(emailId: string, folderPath: string): void {
    this.emit('email-deleted', emailId, folderPath);
  }

  /**
   * Reset state
   */
  reset(): void {
    this._state = 'idle';
    this._folderStates.clear();
    this._startTime = null;
    this._lastError = null;
    this._currentFolder = null;
    this._messagesProcessed = 0;
    this._messagesTotal = 0;
  }

  /**
   * Type-safe event subscription
   */
  on<K extends keyof SyncStateEvents>(event: K, listener: SyncStateEvents[K]): this {
    return super.on(event, listener);
  }

  emit<K extends keyof SyncStateEvents>(event: K, ...args: Parameters<SyncStateEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

// Singleton for global access
let globalSyncState: SyncStateManager | null = null;

export function getSyncState(): SyncStateManager {
  if (!globalSyncState) {
    globalSyncState = new SyncStateManager();
  }
  return globalSyncState;
}

export function resetSyncState(): void {
  if (globalSyncState) {
    globalSyncState.reset();
    globalSyncState.removeAllListeners();
    globalSyncState = null;
  }
}
