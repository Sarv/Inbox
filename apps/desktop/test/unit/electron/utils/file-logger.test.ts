import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The console -> app.log tee. It ships in RELEASE builds, so the load-bearing
 * property is redaction: no password / token / bearer may ever reach the file.
 * Also pinned: the level from a core-logger prefix wins over the console method,
 * the file rotates (O(1) rename, never a 20 MB synchronous read), and every I/O
 * failure is swallowed — logging must not be able to crash the app.
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
}));

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

describe('redactSecrets', () => {
  it('redacts credential-ish keys in JSON form', async () => {
    const { redactSecrets } = await load();
    const input = '{"password":"hunter2","host":"imap.example.com"}';
    expect(redactSecrets(input)).toBe('{"password":"[REDACTED]","host":"imap.example.com"}');
  });

  it('redacts credential-ish keys in util.inspect form', async () => {
    const { redactSecrets } = await load();
    expect(redactSecrets("{ password: 'hunter2', port: 993 }")).toBe(
      "{ password: '[REDACTED]', port: 993 }",
    );
  });

  it.each([
    'password', 'passwd', 'pass', 'access_token', 'accessToken', 'refresh-token',
    'refreshToken', 'id_token', 'token', 'authorization', 'api_key', 'apiKey',
    'client_secret', 'secret',
  ])('redacts the %s field', async (key) => {
    const { redactSecrets } = await load();
    expect(redactSecrets(`{"${key}":"leak-me"}`)).not.toContain('leak-me');
  });

  it('redacts a Bearer token anywhere in the line', async () => {
    const { redactSecrets } = await load();
    expect(redactSecrets('Authorization header: Bearer ya29.A0ARrdaM-abc_def=='))
      .toBe('Authorization header: Bearer [REDACTED]');
  });

  it('redacts EVERY occurrence, not just the first', async () => {
    const { redactSecrets } = await load();
    const out = redactSecrets('{"password":"a","token":"b","note":"keep"}');
    expect(out).not.toContain('"a"');
    expect(out).not.toContain('"b"');
    expect(out).toContain('keep');
  });

  it('leaves ordinary text untouched', async () => {
    const { redactSecrets } = await load();
    const text = 'Synced 42 emails for me@example.com in 1.2s';
    expect(redactSecrets(text)).toBe(text);
  });
});

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
