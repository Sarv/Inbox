/**
 * In-memory stand-in for `services/core-db.ts` (TEST SUPPORT ONLY).
 *
 * The real module opens `better-sqlite3`, whose native binding is compiled for
 * ELECTRON's ABI — loading it in a plain-node vitest run fails with
 * ERR_DLOPEN_FAILED. So every core-DB-backed store is tested against this fake,
 * which implements the same surface (meta / blobs / app_settings) plus just
 * enough of a `prepare()` shim for the `account_registry` statements the
 * registry issues.
 *
 * Usage:  vi.mock('./core-db', async () => await import('./__testing__/fake-core-db'));
 */

export const CORE_DB_FILE = 'sarvinbox-core.db';

export interface RegistryRow {
  id: string;
  email: string;
  name: string | null;
  imap_config: string | null;
  smtp_config: string | null;
  smtp_configured: number;
  auth_method: string | null;
  oauth_provider: string | null;
  color: string | null;
  include_in_unified: number | null;
  background_sync: number | null;
  notify: number | null;
  created_at: number;
  updated_at: number;
}

type FailPoint = 'select' | 'insert' | 'delete' | 'transaction' | 'settings';

interface FakeState {
  rows: Map<string, RegistryRow>;
  meta: Map<string, string>;
  blobs: Map<string, Buffer>;
  settings: Map<string, string>;
  /** Whether the core DB "file" exists on disk. */
  exists: boolean;
  /** Statement kinds that should throw, to exercise the error branches. */
  fail: Set<FailPoint>;
  /** When true, every setBlob throws — models a failed DB write. */
  failBlobWrite: boolean;
  backups: number;
}

// The state is parked on globalThis rather than in module scope on purpose: a
// test that calls `vi.resetModules()` (to reset a store's own module-level
// cache) creates a NEW instance of this helper while the mocked './core-db'
// keeps the memoized one — a per-module Map would then silently diverge from the
// one the test writes to. One shared singleton keeps them in lockstep.
const globalStore = globalThis as typeof globalThis & { __sarvinboxFakeCoreDb?: FakeState };

export const state: FakeState = (globalStore.__sarvinboxFakeCoreDb ??= {
  rows: new Map<string, RegistryRow>(),
  meta: new Map<string, string>(),
  blobs: new Map<string, Buffer>(),
  settings: new Map<string, string>(),
  exists: true,
  fail: new Set<FailPoint>(),
  failBlobWrite: false,
  backups: 0,
});

export function resetFakeCoreDb(): void {
  state.rows.clear();
  state.meta.clear();
  state.blobs.clear();
  state.settings.clear();
  state.exists = true;
  state.fail.clear();
  state.failBlobWrite = false;
  state.backups = 0;
}

interface FakeStatement {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => { changes: number };
}

const boom = (kind: FailPoint): never => {
  throw new Error(`fake core-db: ${kind} failed`);
};

function prepare(sql: string): FakeStatement {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const isSelect = /^SELECT .* FROM account_registry/i.test(normalized);
  const isInsert = /^INSERT INTO account_registry/i.test(normalized);
  const isDelete = /^DELETE FROM account_registry/i.test(normalized);

  return {
    all: () => {
      if (!isSelect) throw new Error(`fake core-db: unexpected all() for ${normalized}`);
      if (state.fail.has('select')) boom('select');
      return [...state.rows.values()].sort((a, b) => a.created_at - b.created_at);
    },
    get: () => {
      if (state.fail.has('select')) boom('select');
      return undefined;
    },
    run: (...args: unknown[]) => {
      if (isInsert) {
        if (state.fail.has('insert')) boom('insert');
        const p = args[0] as Record<string, unknown>;
        const existing = state.rows.get(p.id as string);
        const row: RegistryRow = {
          id: p.id as string,
          email: p.email as string,
          name: (p.name ?? null) as string | null,
          imap_config: (p.imap_config ?? null) as string | null,
          smtp_config: (p.smtp_config ?? null) as string | null,
          smtp_configured: p.smtp_configured as number,
          auth_method: (p.auth_method ?? null) as string | null,
          oauth_provider: (p.oauth_provider ?? null) as string | null,
          color: (p.color ?? null) as string | null,
          include_in_unified: p.include_in_unified as number,
          background_sync: p.background_sync as number,
          notify: p.notify as number,
          // ON CONFLICT DO UPDATE does not touch created_at — an existing row
          // keeps its original insertion time (and therefore its list order).
          created_at: existing?.created_at ?? (p.now as number),
          updated_at: p.now as number,
        };
        state.rows.set(row.id, row);
        return { changes: 1 };
      }
      if (isDelete) {
        if (state.fail.has('delete')) boom('delete');
        return { changes: state.rows.delete(args[0] as string) ? 1 : 0 };
      }
      throw new Error(`fake core-db: unexpected run() for ${normalized}`);
    },
  };
}

export function getCoreDb(): {
  prepare: (sql: string) => FakeStatement;
  transaction: <T>(fn: (arg: T) => void) => (arg: T) => void;
  pragma: (s: string) => void;
} {
  return {
    prepare,
    transaction: <T>(fn: (arg: T) => void) => (arg: T) => {
      if (state.fail.has('transaction')) boom('transaction');
      fn(arg);
    },
    pragma: () => {},
  };
}

export function coreDbExists(): boolean {
  return state.exists;
}

export function backupCoreDb(): void {
  state.backups += 1;
}

export function getMeta(key: string): string | null {
  return state.meta.get(key) ?? null;
}

export function setMeta(key: string, value: string | null): void {
  if (value == null) state.meta.delete(key);
  else state.meta.set(key, value);
}

export function isMigrationDone(flag: string): boolean {
  return getMeta(flag) === '1';
}

export function markMigrationDone(flag: string): void {
  setMeta(flag, '1');
}

export function getAllAppSettings(): Record<string, string> {
  return Object.fromEntries(state.settings);
}

/** The strict read: throws when the 'settings' fail point is set, like an unreadable DB. */
export function readAppSetting(key: string): string | null {
  if (state.fail.has('settings')) boom('settings');
  return state.settings.get(key) ?? null;
}

export function setAppSetting(key: string, value: string): void {
  if (!key) return;
  state.settings.set(key, value);
}

export function deleteAppSetting(key: string): void {
  state.settings.delete(key);
}

export function getBlob(key: string): Buffer | null {
  return state.blobs.get(key) ?? null;
}

export function setBlob(key: string, data: Buffer): void {
  if (!key) return;
  if (state.failBlobWrite) throw new Error('fake core-db: setBlob failed');
  state.blobs.set(key, Buffer.from(data));
}

export function deleteBlob(key: string): void {
  state.blobs.delete(key);
}

export function hasBlob(key: string): boolean {
  return state.blobs.has(key);
}
