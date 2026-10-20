import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The console -> app.log tee. It ships in RELEASE builds, so the load-bearing
 * property is redaction: no password / token / bearer may ever reach the file,
 * and in a release no email address either (CASA L-7). Also pinned: the level
 * from a core-logger prefix wins over the console method, the file rotates
 * (O(1) rename, never a 20 MB synchronous read), it is owner-only (0600), a
 * renderer-forwarded record can't forge lines, and every I/O failure is
 * swallowed — logging must not be able to crash the app.
 */

const h = vi.hoisted(() => ({
  userData: '',
  streams: [] as Array<{
    opts: Record<string, unknown>;
    lines: string[];
    flushes: number;
    reopens: number;
    writeThrows: boolean;
    flushThrows: boolean;
  }>,
  appListeners: [] as string[],
  appOnThrows: false,
  chmodThrows: false,
}));

// Only chmodSync is wrapped (to make it fail on demand); everything else is the
// real filesystem under a tmp userData.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (h.chmodThrows) throw new Error('EPERM: operation not permitted');
      return actual.chmodSync(...args);
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userData,
    getName: () => 'Sarv Inbox Test',
    isPackaged: false,
    on: (event: string) => {
      if (h.appOnThrows) throw new Error('app not ready');
      h.appListeners.push(event);
    },
  },
}));

vi.mock('pino', () => ({
  default: {
    destination: (opts: Record<string, unknown>) => {
      const stream = {
        opts,
        lines: [] as string[],
        flushes: 0,
        reopens: 0,
        writeThrows: false,
        flushThrows: false,
        write(line: string) {
          if (stream.writeThrows) throw new Error('disk gone');
          stream.lines.push(line);
        },
        flushSync() {
          stream.flushes += 1;
          if (stream.flushThrows) throw new Error('flush failed');
        },
        reopen() { stream.reopens += 1; },
      };
      h.streams.push(stream);
      return stream;
    },
  },
}));

type Logger = typeof import('../../../../electron/utils/file-logger');

/** Fresh module — `active` / `terminalMuted` / byte counter are module state. */
const load = async (): Promise<Logger> => {
  vi.resetModules();
  return import('../../../../electron/utils/file-logger');
};

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
let originals: Partial<Record<typeof CONSOLE_METHODS[number], typeof console.log>> = {};

const stream = () => h.streams[h.streams.length - 1];

// Each init() registers a process 'exit' flush hook; the suite re-inits the
// module many times, which would trip Node's default 10-listener warning.
const originalMaxListeners = process.getMaxListeners();

beforeAll(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-filelog-'));
  process.setMaxListeners(100);
});

beforeEach(() => {
  h.streams.length = 0;
  h.appListeners.length = 0;
  h.appOnThrows = false;
  h.chmodThrows = false;
  originals = {};
  for (const m of CONSOLE_METHODS) originals[m] = console[m];
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterEach(() => {
  // The logger patches the global console in place and never restores it.
  for (const m of CONSOLE_METHODS) console[m] = originals[m]!;
});

afterAll(() => {
  rmSync(h.userData, { recursive: true, force: true });
  process.setMaxListeners(originalMaxListeners);
});

// Changed deliberately (relocated): the redactSecrets unit tests moved,
// assertions unchanged, to core's telemetry-scrub suite with the function
// itself (CASA L-7). What stays here is that every line the file gets is run
// through it — see the tee and appendExternalLog.

describe('initFileLogger', () => {
  it('opens an async destination at userData/app.log and returns its path', async () => {
    const logger = await load();
    logger.muteTerminalOutput(); // keep the test output clean
    const path = logger.initFileLogger();
    expect(path).toBe(join(h.userData, 'app.log'));
    expect(stream().opts).toMatchObject({ dest: path, sync: false, mkdir: true });
    // It announces itself, then flushes so the file proves itself on startup.
    expect(stream().lines.some((l) => l.includes('[file-logger] writing local logs to'))).toBe(true);
    expect(stream().flushes).toBeGreaterThan(0);
  });

  it('is idempotent — a second call returns the same path and opens no new stream', async () => {
    const logger = await load();
    logger.muteTerminalOutput();
    const first = logger.initFileLogger();
    expect(logger.initFileLogger()).toBe(first);
    expect(h.streams).toHaveLength(1);
  });

  it('registers the shutdown flush hooks, and survives an app that refuses them', async () => {
    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();
    expect(h.appListeners).toEqual(['before-quit']);

    const logger2 = await load();
    logger2.muteTerminalOutput();
    h.appOnThrows = true;
    expect(() => logger2.initFileLogger()).not.toThrow();
  });

  it('ROTATES an oversized existing log to app.log.1 and reopens the stream', async () => {
    const path = join(h.userData, 'app.log');
    writeFileSync(path, '');
    truncateSync(path, 21 * 1024 * 1024); // sparse: instantly "over the 20 MB cap"

    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();

    expect(existsSync(join(h.userData, 'app.log.1'))).toBe(true);
    expect(stream().reopens).toBe(1);
  });

  it('replaces an existing archive when rotating again', async () => {
    const path = join(h.userData, 'app.log');
    writeFileSync(join(h.userData, 'app.log.1'), 'older archive');
    writeFileSync(path, '');
    truncateSync(path, 21 * 1024 * 1024);

    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();
    expect(existsSync(join(h.userData, 'app.log.1'))).toBe(true);
    expect(stream().reopens).toBe(1);
  });

  it('swallows a rotation whose rename fails', async () => {
    // Oversized log + a NON-EMPTY DIRECTORY where the archive goes: the unlink
    // and the rename both fail, and trimIfNeeded must swallow it.
    const path = join(h.userData, 'app.log');
    writeFileSync(path, '');
    truncateSync(path, 21 * 1024 * 1024);
    mkdirSync(join(h.userData, 'app.log.1'));
    writeFileSync(join(h.userData, 'app.log.1', 'inner'), 'x');

    const logger = await load();
    logger.muteTerminalOutput();
    expect(() => logger.initFileLogger()).not.toThrow();
    expect(existsSync(path)).toBe(true);      // still there — rotation failed
    expect(stream().reopens).toBe(0);
  });

  it('swallows a rotation that cannot even stat the target', async () => {
    // A DIRECTORY at app.log: size lookup works, renameSync fails -> swallowed.
    mkdirSync(join(h.userData, 'app.log'));
    const logger = await load();
    logger.muteTerminalOutput();
    expect(() => logger.initFileLogger()).not.toThrow();
  });
});

// POSIX modes: honoured on macOS/Linux, not on Windows (NTFS ACLs), where the
// chmod is a documented no-op — so the on-disk mode is only asserted off Windows.
const posixOnly = it.skipIf(process.platform === 'win32');
const modeOf = (path: string) => statSync(path).mode & 0o777;

describe('app.log is owner-only (0600)', () => {
  // Breaks if a NEW app.log (and the fresh one after each rotation, which
  // sonic-boom creates with the same options) is world-readable: it names the
  // user's accounts, folders and correspondents.
  it('opens the destination with mode 0600', async () => {
    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();
    expect(stream().opts.mode).toBe(0o600);
  });

  // Breaks if an app.log / app.log.1 left 0644 by an older version stays
  // readable by every local account after the update.
  posixOnly('tightens an existing 0644 log and archive at startup', async () => {
    const path = join(h.userData, 'app.log');
    writeFileSync(path, 'old line\n');
    writeFileSync(`${path}.1`, 'older line\n');
    chmodSync(path, 0o644);
    chmodSync(`${path}.1`, 0o644);

    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();

    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(`${path}.1`)).toBe(0o600);
  });

  // Breaks if rotation renames a 0644 log into an archive that keeps its mode.
  posixOnly('tightens the archive a rotation produces', async () => {
    const path = join(h.userData, 'app.log');
    writeFileSync(path, '');
    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();
    chmodSync(path, 0o644); // e.g. replaced behind our back, or a legacy file

    console.log('x'.repeat(21 * 1024 * 1024)); // past the cap -> rotate
    expect(stream().reopens).toBe(1);
    expect(modeOf(`${path}.1`)).toBe(0o600);
  });

  // Breaks if a filesystem that refuses chmod (or a log path we may not
  // change) takes logging down with it.
  it('swallows a chmod that fails', async () => {
    writeFileSync(join(h.userData, 'app.log'), 'old line\n');
    h.chmodThrows = true;
    const logger = await load();
    logger.muteTerminalOutput();
    expect(() => logger.initFileLogger()).not.toThrow();
    expect(stream().lines.some((l) => l.includes('[file-logger] writing local logs to'))).toBe(true);
  });

  // Breaks if the chmod follows a symlink planted at app.log and changes the
  // mode of a file that is not ours, or touches a directory squatting there.
  posixOnly('changes regular files only — not a symlink target, not a directory', async () => {
    const target = join(h.userData, 'elsewhere.txt');
    writeFileSync(target, 'not a log');
    chmodSync(target, 0o644);
    symlinkSync(target, join(h.userData, 'app.log'));
    mkdirSync(join(h.userData, 'app.log.1'), { mode: 0o755 });

    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();

    expect(modeOf(target)).toBe(0o644);
    expect(modeOf(join(h.userData, 'app.log.1'))).toBe(0o755);
  });
});

describe('email addresses (CASA L-7)', () => {
  const ADDRESS_LINE = 'synced 3 for jane.doe@example.com from bob@corp.example.org';

  // Breaks if a RELEASE app.log names the user's accounts and correspondents —
  // the OAuth "granted scopes" line, the per-message sender lines, every core
  // logger line that interpolates an address.
  it('redacts them from main-process lines when asked (release)', async () => {
    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger({ redactAddresses: true });
    stream().lines.length = 0;

    console.log(`[2026-06-15 12:00:00.000] [INFO] [oauth] ${ADDRESS_LINE}`);
    console.error('failed for', { user: 'jane.doe@example.com', password: 'hunter2' });

    expect(stream().lines.join('')).not.toContain('@example.com');
    expect(stream().lines.join('')).not.toContain('@corp.example.org');
    expect(stream().lines[0]).toContain('[oauth] synced 3 for [email] from [email]');
    // Secrets are still redacted alongside.
    expect(stream().lines[1]).not.toContain('hunter2');
  });

  // Breaks if renderer-forwarded lines bypass the release redaction.
  it('redacts them from renderer-forwarded lines when asked (release)', async () => {
    const logger = await load();
    logger.initFileLogger({ redactAddresses: true });
    stream().lines.length = 0;

    logger.appendExternalLog('renderer', 'info', 'compose:jane@example.com', ADDRESS_LINE);

    expect(stream().lines[0]).not.toContain('@example.com');
    expect(stream().lines[0]).toContain('[renderer] [compose:[email]] synced 3 for [email] from [email]');
  });

  // Breaks if the DEV log loses the addresses the developer debugs with.
  it('keeps them in a dev run (the default)', async () => {
    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();
    stream().lines.length = 0;

    console.log(ADDRESS_LINE);
    logger.appendExternalLog('renderer', 'info', '', ADDRESS_LINE);

    expect(stream().lines[0]).toContain('jane.doe@example.com');
    expect(stream().lines[1]).toContain('bob@corp.example.org');
  });
});

describe('the console tee', () => {
  const initMuted = async (): Promise<Logger> => {
    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();
    stream().lines.length = 0; // drop the startup banner
    return logger;
  };

  it('writes one timestamped line per console call, mapping method -> level', async () => {
    await initMuted();
    console.log('plain log');
    console.info('an info');
    console.warn('a warning');
    console.error('an error');
    console.debug('a debug');

    const levels = stream().lines.map((l) => /^\[[^\]]+\] \[([A-Z]+)\]/.exec(l)?.[1]);
    expect(levels).toEqual(['INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG']);
    expect(stream().lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] plain log\n$/);
  });

  // CHANGED 2026-08-27: this used to assert the component name was STRIPPED
  // (`not.toContain('body-reheal')`). That was the bug, not the contract — it made
  // every component logger anonymous in app.log, so no line could be grepped by
  // component and two accounts' identical backfill lines were indistinguishable.
  // The name is now preserved; only the logger's own timestamp is re-stamped.
  it('keeps a core-logger line’s OWN level AND name, re-stamping the time', async () => {
    await initMuted();
    console.log('[2026-06-15 12:00:00.000] [TRACE] [body-reheal] re-decoded e1');

    expect(stream().lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[TRACE\] \[body-reheal\] re-decoded e1\n$/,
    );
    // The line carries exactly ONE timestamp — the logger's own is stripped.
    expect(stream().lines[0]).not.toContain('2026-06-15');
  });

  // The name is what makes a multi-account install debuggable: the backfills label
  // their logger with the account database they work on, and if app.log drops that
  // label the lines are identical and unattributable — which is exactly how a
  // false "a writer bypassed rawBodyForStorage" warning cost an afternoon.
  it('keeps a name that identifies WHICH account database a line is about', async () => {
    await initMuted();
    console.log(
      '[2026-06-15 12:00:00.000] [WARN] [inline-image-backfill:sarvinbox-abc123.db] repaired 112',
    );

    expect(stream().lines[0]).toContain('[inline-image-backfill:sarvinbox-abc123.db] repaired 112');
  });

  // A raw console.* call has no prefix to take a name from, and must not gain a
  // stray empty `[]` — the tee handles both shapes of caller.
  it('adds no empty name to a raw console call', async () => {
    await initMuted();
    console.log('plain, unprefixed');

    expect(stream().lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] plain, unprefixed\n$/,
    );
  });

  it('REDACTS secrets before they reach the file', async () => {
    await initMuted();
    console.log('connect config', { host: 'imap.example.com', password: 'hunter2' });
    const line = stream().lines[0];
    expect(line).not.toContain('hunter2');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('imap.example.com');
  });

  it('renders objects and Errors (stack included)', async () => {
    await initMuted();
    console.log({ nested: { a: 1 } });
    expect(stream().lines[0]).toContain('nested');

    const error = new Error('kaboom');
    console.error(error);
    expect(stream().lines[1]).toContain('kaboom');
    expect(stream().lines[1]).toContain('at '); // the stack
  });

  // Breaks if the renderer's one-line rule is applied to the main process's
  // own (trusted) lines, flattening every stack trace in app.log.
  it('keeps a main-process stack on its own lines', async () => {
    await initMuted();
    console.error(new Error('kaboom'));
    expect(stream().lines[0]).toMatch(/kaboom\n\s+at /);
  });

  it('still tees to the terminal until muted', async () => {
    const logger = await load();
    const seen: unknown[][] = [];
    // Replace the real terminal writer BEFORE patching, so nothing is printed.
    console.log = ((...args: unknown[]) => { seen.push(args); }) as typeof console.log;
    logger.initFileLogger();

    console.log('to both');
    expect(seen.some((args) => args[0] === 'to both')).toBe(true);
    expect(stream().lines.some((l) => l.includes('to both'))).toBe(true);

    // After muting, the terminal half stops but the file keeps recording.
    const before = seen.length;
    logger.muteTerminalOutput();
    console.log('file only');
    expect(seen).toHaveLength(before);
    expect(stream().lines.some((l) => l.includes('file only'))).toBe(true);
  });

  it('swallows a failing stream write (logging never crashes the app)', async () => {
    await initMuted();
    stream().writeThrows = true;
    expect(() => console.log('into the void')).not.toThrow();
  });

  it('rotates once the running byte count passes the cap', async () => {
    // The real app.log has to exist for the O(1) rename to succeed (pino, and so
    // the actual file creation, is mocked here).
    writeFileSync(join(h.userData, 'app.log'), '');
    await initMuted();
    // One ~21 MB line takes the counter past MAX_BYTES in a single write.
    console.log('x'.repeat(21 * 1024 * 1024));
    expect(stream().reopens).toBe(1);
    expect(existsSync(join(h.userData, 'app.log.1'))).toBe(true);
  });
});

describe('appendExternalLog (renderer → app.log)', () => {
  it('writes a source- and component-tagged, level-stamped line', async () => {
    const logger = await load();
    logger.initFileLogger();
    stream().lines.length = 0; // drop the startup banner
    logger.appendExternalLog('renderer', 'warn', 'sync-slice', 'something happened');
    expect(stream().lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[WARN\] \[renderer\] \[sync-slice\] something happened\n$/,
    );
  });

  it('omits the name segment entirely for a nameless line (raw console.* has no component)', async () => {
    const logger = await load();
    logger.initFileLogger();
    stream().lines.length = 0;
    logger.appendExternalLog('renderer', 'info', '', 'no name here');
    expect(stream().lines[0]).toMatch(/\[INFO\] \[renderer\] no name here\n$/);
    expect(stream().lines[0]).not.toContain('[] '); // never an empty bracket pair
  });

  it('defaults to INFO when the level is blank', async () => {
    const logger = await load();
    logger.initFileLogger();
    stream().lines.length = 0;
    logger.appendExternalLog('renderer', '', '', 'level-less');
    expect(stream().lines[0]).toContain('[INFO]');
  });

  it('redacts secrets in the forwarded text — it ships in release', async () => {
    const logger = await load();
    logger.initFileLogger();
    stream().lines.length = 0;
    logger.appendExternalLog('renderer', 'error', '', 'config {"password":"hunter2"}');
    expect(stream().lines[0]).toContain('[REDACTED]');
    expect(stream().lines[0]).not.toContain('hunter2');
  });

  it('is a no-op before init (no active stream) and never throws', async () => {
    const logger = await load(); // NOT initialized
    expect(() => logger.appendExternalLog('renderer', 'info', '', 'dropped')).not.toThrow();
    expect(h.streams).toHaveLength(0);
  });

  it('swallows a failing stream write (logging never crashes the app)', async () => {
    const logger = await load();
    logger.initFileLogger();
    stream().writeThrows = true;
    expect(() => logger.appendExternalLog('renderer', 'info', '', 'boom')).not.toThrow();
  });
});

describe('appendExternalLog keeps a forwarded record to ONE line (log forging, CASA L-7)', () => {
  const initExternal = async (): Promise<Logger> => {
    const logger = await load();
    logger.initFileLogger();
    stream().lines.length = 0;
    return logger;
  };
  const LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[[A-Z]+\] \[renderer\] /;

  // Breaks if renderer text can start a new line that reads as the main
  // process's own — e.g. a fake "[ERROR] [oauth] token revoked" entry.
  it('escapes CR and LF so the record cannot start a second line', async () => {
    const logger = await initExternal();
    const forged = 'ok\n[2026-06-15 12:00:00.000] [ERROR] [oauth] forged\r\nmore\rend';
    logger.appendExternalLog('renderer', 'info', '', forged);

    expect(stream().lines).toHaveLength(1);
    const line = stream().lines[0];
    expect(line.indexOf('\n')).toBe(line.length - 1); // only the terminator
    expect(line).not.toContain('\r');
    expect(line).toMatch(LINE);
    expect(line).toContain('ok\\n[2026-06-15 12:00:00.000] [ERROR] [oauth] forged\\r\\nmore\\rend');
  });

  // Breaks if other control characters (ESC sequences that repaint a terminal
  // running `tail -f app.log`, NUL, Unicode line separators) pass through raw.
  it('escapes every other control character, keeping tabs', async () => {
    const logger = await initExternal();
    logger.appendExternalLog('renderer', 'info', '', 'a\u001b[2Jb\u0000c\u2028d\u0085e\tf');
    const line = stream().lines[0];
    expect(line).toContain('a\\u001b[2Jb\\u0000c\\u2028d\\u0085e\tf');
    // eslint-disable-next-line no-control-regex -- asserting none survive
    expect(line.slice(0, -1)).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/);
  });

  // Breaks if the renderer can stamp an invented level ("FATAL", a level with
  // spaces or brackets in it) or a non-string one onto the file.
  it('accepts only the logger’s levels, case-insensitively, else INFO', async () => {
    const logger = await initExternal();
    logger.appendExternalLog('renderer', 'Warn', '', 'a');
    logger.appendExternalLog('renderer', 'trace', '', 'b');
    logger.appendExternalLog('renderer', 'FATAL', '', 'c');
    logger.appendExternalLog('renderer', 'INFO] [main', '', 'd');
    logger.appendExternalLog('renderer', 42, '', 'e');
    logger.appendExternalLog('renderer', undefined, '', 'f');

    const levels = stream().lines.map((l) => /^\[[^\]]+\] \[([^\]]+)\]/.exec(l)?.[1]);
    expect(levels).toEqual(['WARN', 'TRACE', 'INFO', 'INFO', 'INFO', 'INFO']);
  });

  // Breaks if the component name can break out of its brackets or the line,
  // or be long enough to bury the message.
  it('keeps the name to one short bracket-free label', async () => {
    const logger = await initExternal();
    logger.appendExternalLog('renderer', 'info', 'sync] [ERROR] [main\nx', 'a');
    logger.appendExternalLog('renderer', 'info', 'n'.repeat(64), 'b');
    logger.appendExternalLog('renderer', 'info', 'n'.repeat(65), 'c');
    logger.appendExternalLog('renderer', 'info', { evil: true }, 'd');

    expect(stream().lines[0]).toContain('[renderer] [sync ERROR main\\nx] a');
    expect(stream().lines[1]).toContain(`[renderer] [${'n'.repeat(64)}] b`);
    expect(stream().lines[2]).toMatch(/\[INFO\] \[renderer\] c\n$/); // over 64: dropped, not cut
    expect(stream().lines[3]).toMatch(/\[INFO\] \[renderer\] d\n$/);
  });

  // Breaks if one forwarded record can be arbitrarily large — a runaway or
  // hostile renderer filling the 20 MB file and rotating the main process's
  // own trail away in a handful of calls.
  it('caps the text at 8 KB and says it was cut', async () => {
    const logger = await initExternal();
    logger.appendExternalLog('renderer', 'info', '', 'x'.repeat(8 * 1024));
    logger.appendExternalLog('renderer', 'info', '', 'y'.repeat(8 * 1024 + 1));
    logger.appendExternalLog('renderer', 'info', '', `${'\n'.repeat(8 * 1024)}tail`); // escaping doubles it

    expect(stream().lines[0]).toContain(`${'x'.repeat(8 * 1024)}\n`);
    expect(stream().lines[0]).not.toContain('[truncated]');
    expect(stream().lines[1]).toContain(`${'y'.repeat(8 * 1024)}… [truncated]\n`);
    expect(stream().lines[1]).not.toContain('y'.repeat(8 * 1024 + 1));
    expect(stream().lines[2]).toContain('… [truncated]');
    expect(stream().lines[2]).not.toContain('tail');
    expect(stream().lines[2].length).toBeLessThan(8 * 1024 + 100);
  });

  // Breaks if a huge record is scanned and written: redacting it costs main-
  // thread time in proportion to its size, and a partial write could cut
  // through a secret. A note with its size is written instead.
  it('writes only a note for a record over 64 KB', async () => {
    const logger = await initExternal();
    logger.appendExternalLog('renderer', 'warn', '', `{"token":"${'s'.repeat(70 * 1024)}"}`);
    logger.appendExternalLog('renderer', 'info', '', 'k'.repeat(64 * 1024));

    expect(stream().lines[0]).toMatch(/\[WARN\] \[renderer\] \[record of 71692 characters not written: over the 64 KB limit\]\n$/);
    expect(stream().lines[1]).toContain('… [truncated]'); // exactly 64 KB is still written, cut
  });

  // Breaks if the cut happens BEFORE redaction: a secret (or, in a release, an
  // address) straddling the 8 KB mark would be half-written in plaintext.
  it('redacts a secret or address that straddles the cap before cutting', async () => {
    const logger = await load();
    logger.initFileLogger({ redactAddresses: true });
    stream().lines.length = 0;
    const pad = 'p'.repeat(8 * 1024 - 15);
    logger.appendExternalLog('renderer', 'info', '', `${pad}{"password":"hunter2-and-more"}`);
    logger.appendExternalLog('renderer', 'info', '', `${'q'.repeat(8 * 1024 - 6)} jane.doe@example.com`);

    expect(stream().lines[0]).not.toContain('hunter');
    expect(stream().lines[1]).not.toContain('jane');
  });
});

describe('flushFileLogger', () => {
  it('is a no-op before init', async () => {
    const logger = await load();
    expect(() => logger.flushFileLogger()).not.toThrow();
    expect(h.streams).toHaveLength(0);
  });

  it('flushes the buffered tail on demand', async () => {
    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();
    const before = stream().flushes;
    logger.flushFileLogger();
    expect(stream().flushes).toBe(before + 1);
  });

  it('swallows a failing flush', async () => {
    const logger = await load();
    logger.muteTerminalOutput();
    logger.initFileLogger();
    stream().flushThrows = true;
    expect(() => logger.flushFileLogger()).not.toThrow();
  });
});
