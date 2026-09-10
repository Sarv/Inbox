/**
 * Is the compiled `better-sqlite3` addon loadable by THIS process, and if not,
 * why?
 *
 * The addon is valid for exactly one ABI at a time — Electron's for the app,
 * plain Node's for the test suites — and the failure mode is nastier than a
 * crash: better-sqlite3 dlopens lazily, on the first `new Database(...)`, so
 * nothing throws at import. The throw lands inside whichever call opens a
 * database, and every core-DB read wraps that in a `try/catch` returning an
 * empty result. An unreadable store and an empty store are the same value and
 * opposite facts: the app then boots looking like a fresh install rather than
 * like an error, which is how a startup sweep once deleted live mailbox DBs.
 *
 * So the load has to be provoked deliberately, early, by something that reports
 * the failure instead of absorbing it. Everything here is pure except the
 * probe's single `open()` call, so the parsing and the message are unit
 * testable without an actually-broken binding.
 *
 * This module deliberately does NOT import `better-sqlite3` — the opener is
 * always passed in. Three suites hand a mock to `vi.mock('better-sqlite3', …)`,
 * and a static import here would make the mock factory depend on the module it
 * is replacing: "Cannot access '__vi_import_6__' before initialization", every
 * SQLiteStorage suite dead. The addon-touching default lives one file over, in
 * native-abi-probe.ts.
 */

/** The two ABI numbers out of Node's dlopen mismatch message. */
export interface NativeAbiMismatch {
  /** NODE_MODULE_VERSION the addon on disk was compiled against. */
  builtAbi: string;
  /** NODE_MODULE_VERSION the running process requires. */
  requiredAbi: string;
}

/**
 * Pull the ABI numbers out of a load failure.
 *
 * Node's message names the built ABI first and the required one second:
 *
 *   The module '…better_sqlite3.node' was compiled against a different Node.js
 *   version using NODE_MODULE_VERSION 137. This version of Node.js requires
 *   NODE_MODULE_VERSION 148.
 *
 * A truncated variant naming only one number still identifies the binary, so
 * the running process's own ABI stands in for the second. `null` means the
 * failure was something else entirely (a missing file, a corrupt build) and
 * must not be reported as an ABI mismatch.
 */
export function parseAbiMismatch(
  cause: unknown,
  runningAbi: string = process.versions.modules,
): NativeAbiMismatch | null {
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const found = [...message.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map((match) => match[1]);
  if (found.length === 0) return null;
  return { builtAbi: found[0], requiredAbi: found[1] ?? runningAbi };
}

export type NativeSqliteProbe = { ok: true } | { ok: false; cause: unknown };

/**
 * Force the lazy dlopen by opening and closing whatever database `open` returns.
 *
 * `probeBundledSqlite` supplies the real one; the opener is a parameter so a
 * test can stand in a broken binding — and so this module never has to import
 * the addon itself.
 */
export function probeNativeSqlite(open: () => { close: () => void }): NativeSqliteProbe {
  try {
    open().close();
    return { ok: true };
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * One line naming what is wrong, for the top of any diagnostic. Callers add
 * their own remedy — the app's and the test suite's are different commands.
 */
export function describeNativeAbiFailure(
  cause: unknown,
  runningAbi: string = process.versions.modules,
): string {
  const mismatch = parseAbiMismatch(cause, runningAbi);
  if (!mismatch) return 'better-sqlite3 could not be loaded.';
  return `better-sqlite3 is compiled for ABI ${mismatch.builtAbi}, but this process requires ABI ${mismatch.requiredAbi}.`;
}
