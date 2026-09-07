import { vi } from 'vitest';

// Shared harness for connection-slice tests. The slice is a zustand slice that
// reaches for `window.electronAPI` and `localStorage` at call time, so every
// test needs the same three things: an in-memory localStorage, an electronAPI
// mock, and the slice instantiated against a plain mutable state bag. Extracted
// so each new connection-slice test file doesn't hand-roll its own copy.

/** In-memory localStorage — the slice persists accounts/credentials through it. */
export const installLocalStorage = (): void => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
};

/** Undo installLocalStorage + the window mock. Call from afterEach. */
export const teardownStoreEnv = (): void => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
};

/** A minimal account row shaped like the store's own. */
export const account = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@example.com`,
  imapConfig: {},
  smtpConfig: null,
  smtpConfigured: false,
  ...over,
});

interface LoadOptions {
  /** Runs after localStorage is installed and BEFORE the slice module is
   *  imported — the window for seeding anything the module reads on load. */
  seed?: () => void;
}

/**
 * Instantiate the connection slice with a mutable state bag + electronAPI mock.
 * Returns the bag: `state.someAction()` calls the real slice code, and `state`
 * reflects every `set()` it made.
 */
export const loadConnectionSlice = async (
  initial: Record<string, any>,
  electronAPI: any,
  options: LoadOptions = {},
): Promise<{ state: any }> => {
  vi.resetModules();
  installLocalStorage();
  options.seed?.();
  (globalThis as any).window = { electronAPI };
  const mod = await import('../../../../../src/store/slices/connection-slice');
  const state: any = {};
  const set = (partial: any) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial);
  const get = () => state;
  const slice = mod.createConnectionSlice(set, get, {} as any);
  // The slice returns its OWN initial fields (accounts: [], activeAccountId: null,
  // …) alongside its methods; apply those first, then let the test's overrides win.
  Object.assign(state, slice, {
    accounts: [],
    activeAccountId: null,
    deletingAccountIds: [],
    accountActionError: null,
    ...initial,
  });
  return { state };
};
