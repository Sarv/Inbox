/**
 * Shared state and utilities for the Electron main process
 *
 * This module provides centralized access to singleton instances
 * like storage, sync engine, extension manager, and the main window.
 */

import type { BrowserWindow } from 'electron';
import type { SQLiteStorage } from '@sarvinbox/storage-node';
import type { SyncEngine, SMTPClient, ExtensionManager } from '@sarvinbox/core';
import type { AICategorizationService } from './services/ai-categorization-service';

// Process-global singletons (not per-account).
let mainWindow: BrowserWindow | null = null;
let extensionManager: ExtensionManager | null = null;
let aiCategorizationService: AICategorizationService | null = null;
let isQuitting = false;
// True between a powerMonitor 'suspend' and the next real user wake ('resume' /
// 'unlock-screen'). While set, background reconnects are suppressed so a macOS
// Power Nap dark-wake (which fires no 'resume') can't open a fresh IMAP
// connection that immediately freezes into a Gmail-cap zombie.
let systemSuspended = false;

// ===== Multi-account runtime registry (Stage 2) ============================
// Each account owns its storage (a per-account DB file), sync engine, and SMTP
// client. getStorage()/getSyncEngine()/getSmtpClient() resolve the CURRENTLY
// active account, so the ~40 existing IPC handlers (which call these with no
// account argument) keep working — switching accounts just flips the pointer.
//
// Before any account is made active, a single `__default__` slot holds the
// startup-created instances (opened on the existing sarvinbox.db). The PRIMARY
// account CLAIMS that slot (claimDefaultRuntime, driven by accounts-handlers),
// so its existing database + live connection are reused — no data loss, no
// reconnect, and single-account behavior is unchanged. Which account is primary
// is persisted (primary-account.json), so a secondary account active on restart
// never claims the primary's database.
export interface AccountRuntime {
  storage: SQLiteStorage | null;
  syncEngine: SyncEngine | null;
  smtpClient: SMTPClient | null;
}
const DEFAULT_SLOT = '__default__';
const runtimes = new Map<string, AccountRuntime>();
let currentAccountId: string = DEFAULT_SLOT;

function currentRuntime(): AccountRuntime {
  let rt = runtimes.get(currentAccountId);
  if (!rt) {
    rt = { storage: null, syncEngine: null, smtpClient: null };
    runtimes.set(currentAccountId, rt);
  }
  return rt;
}

/** The active account id, or null while still on the pre-account default slot. */
export function getCurrentAccountId(): string | null {
  return currentAccountId === DEFAULT_SLOT ? null : currentAccountId;
}

export function getAccountRuntime(accountId: string): AccountRuntime | undefined {
  return runtimes.get(accountId);
}

export function hasAccountRuntime(accountId: string): boolean {
  const rt = runtimes.get(accountId);
  return !!rt?.storage;
}

/** All real account ids that currently have an initialized storage runtime
 *  (excludes the pre-account default slot). */
export function getAllAccountIds(): string[] {
  return [...runtimes.entries()]
    .filter(([id, rt]) => id !== DEFAULT_SLOT && !!rt.storage)
    .map(([id]) => id);
}

/** [accountId, runtime] pairs for every real, initialized account. Use this to
 *  fan a read/operation across accounts (unified inbox, unread summary). */
export function getAllAccountRuntimes(): Array<[string, AccountRuntime]> {
  return [...runtimes.entries()].filter(([id, rt]) => id !== DEFAULT_SLOT && !!rt.storage);
}

// ---- Account-scoped accessors (resolve a SPECIFIC account, not the active one) --
// These back multi-account reads/operations where the target account is known
// (e.g. acting on a row in the unified view). They fall back to the active-account
// accessors' contract of returning null when the runtime/instance is absent.
export function getStorageFor(accountId: string): SQLiteStorage | null {
  return runtimes.get(accountId)?.storage ?? null;
}

export function getSyncEngineFor(accountId: string): SyncEngine | null {
  return runtimes.get(accountId)?.syncEngine ?? null;
}

/** The sync engine belonging to the SAME account as `storage`. `storage` is the
 *  reliable per-account identity the pipeline already threads everywhere (it's
 *  how each email is read/written against its own DB), so this maps it back to
 *  that account's engine WITHOUT needing an accountId on the email row. Returns
 *  null if the storage isn't a known account runtime. */
export function getSyncEngineForStorage(storage: SQLiteStorage | null): SyncEngine | null {
  if (!storage) return null;
  for (const [, rt] of runtimes) {
    if (rt.storage === storage) return rt.syncEngine;
  }
  return null;
}

/** The account id owning `storage` (reverse of getStorageFor). For per-account
 *  logging/diagnostics so interleaved multi-account output is attributable.
 *  Returns null for the pre-account default slot or an unknown storage. */
export function getAccountIdForStorage(storage: SQLiteStorage | null): string | null {
  if (!storage) return null;
  for (const [id, rt] of runtimes) {
    if (rt.storage === storage) return id === DEFAULT_SLOT ? null : id;
  }
  return null;
}

export function getSmtpClientFor(accountId: string): SMTPClient | null {
  return runtimes.get(accountId)?.smtpClient ?? null;
}

export function setSmtpClientFor(accountId: string, client: SMTPClient | null): void {
  const rt = runtimes.get(accountId);
  if (rt) rt.smtpClient = client;
}

export function registerAccountRuntime(accountId: string, rt: AccountRuntime): void {
  runtimes.set(accountId, rt);
}

/**
 * Drop an account's runtime from the registry (on account removal). If the
 * removed account was the active one, reset the pointer to the pre-account
 * default slot so no stale/closed storage is resolved as "current".
 */
export function unregisterRuntime(accountId: string): void {
  runtimes.delete(accountId);
  if (currentAccountId === accountId) currentAccountId = DEFAULT_SLOT;
}

/**
 * Re-key an in-memory runtime after account-id canonicalization: move the
 * runtime map entry and the active-account pointer from `oldId` to `newId`.
 * No-op when nothing is registered under `oldId`; never clobbers an already-open
 * runtime already sitting under `newId`.
 */
export function rekeyRuntime(oldId: string, newId: string): void {
  if (!oldId || !newId || oldId === newId) return;
  const rt = runtimes.get(oldId);
  if (rt) {
    runtimes.delete(oldId);
    if (!runtimes.get(newId)?.storage) runtimes.set(newId, rt);
  }
  if (currentAccountId === oldId) currentAccountId = newId;
}

/**
 * Make `accountId` the active account (creating an empty slot if it has none).
 * Does NOT decide DB ownership — the caller (accounts handler) claims the
 * default sarvinbox.db slot only for the persisted PRIMARY account, so a
 * secondary account active on restart never grabs the primary's database.
 */
export function setCurrentAccount(accountId: string): AccountRuntime {
  currentAccountId = accountId;
  return currentRuntime();
}

/**
 * Move the startup default runtime (the already-open sarvinbox.db) under
 * `accountId`. Returns true if a default runtime with storage existed and was
 * claimed. Call this ONLY for the primary account.
 */
export function claimDefaultRuntime(accountId: string): boolean {
  const def = runtimes.get(DEFAULT_SLOT);
  if (def && def.storage) {
    runtimes.delete(DEFAULT_SLOT);
    runtimes.set(accountId, def);
    // The legacy database was opened before anyone knew whose it was. Now we
    // know — tell it, so the shared contact directory files this mailbox's
    // contacts under the account id every other mailbox uses.
    def.storage.adoptAccountId(accountId);
    return true;
  }
  return false;
}

// Getters (resolve the active account's runtime)
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getStorage(): SQLiteStorage | null {
  return currentRuntime().storage;
}

export function getSyncEngine(): SyncEngine | null {
  return currentRuntime().syncEngine;
}

export function getSmtpClient(): SMTPClient | null {
  return currentRuntime().smtpClient;
}

export function getExtensionManager(): ExtensionManager | null {
  return extensionManager;
}

export function getAICategorizationService(): AICategorizationService | null {
  return aiCategorizationService;
}

export function getIsQuitting(): boolean {
  return isQuitting;
}

export function getSystemSuspended(): boolean {
  return systemSuspended;
}

export function setSystemSuspended(suspended: boolean): void {
  systemSuspended = suspended;
}

// Setters (target the active account's slot)
export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

export function setStorage(s: SQLiteStorage | null): void {
  currentRuntime().storage = s;
}

export function setSyncEngine(engine: SyncEngine | null): void {
  currentRuntime().syncEngine = engine;
}

export function setSmtpClient(client: SMTPClient | null): void {
  currentRuntime().smtpClient = client;
}

export function setExtensionManager(manager: ExtensionManager | null): void {
  extensionManager = manager;
}

export function setAICategorizationService(service: AICategorizationService | null): void {
  aiCategorizationService = service;
}

export function setIsQuitting(quitting: boolean): void {
  isQuitting = quitting;
}

// Helper to require storage (throws if not initialized)
export function requireStorage(): SQLiteStorage {
  const storage = getStorage();
  if (!storage) {
    throw new Error('Storage not initialized');
  }
  return storage;
}

// Helper to require sync engine (throws if not initialized)
export function requireSyncEngine(): SyncEngine {
  const syncEngine = getSyncEngine();
  if (!syncEngine) {
    throw new Error('Sync engine not initialized');
  }
  return syncEngine;
}

// Helper to require main window (throws if not available)
export function requireMainWindow(): BrowserWindow {
  if (!mainWindow) {
    throw new Error('Main window not available');
  }
  return mainWindow;
}

/**
 * Safely send an IPC message to the current main window.
 *
 * Resolves the live window on every call (never a stale reference captured in a
 * long-lived listener closure, which after a reload/recreate points at the old,
 * destroyed window) and skips the send when the window — or its webContents —
 * has been destroyed. Without this guard, `win?.webContents.send()` still throws
 * "Object has been destroyed" because `?.` only guards a *null* window, not a
 * destroyed one. Returns true if the message was dispatched.
 *
 * This is the single source for main->renderer sends; prefer it over
 * hand-rolling `if (win && !win.isDestroyed()) win.webContents.send(...)`.
 */
export function sendToWindow(channel: string, ...args: unknown[]): boolean {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  win.webContents.send(channel, ...args);
  return true;
}
