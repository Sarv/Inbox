/**
 * File Logger (dev AND release)
 *
 * Tees the main-process console output to a rolling `app.log` in the userData
 * dir (next to sarvinbox.db), capped at 20 MB — once past the cap the oldest
 * half is dropped so it never grows unbounded. Enabled in BOTH dev and packaged
 * builds so a shipped release has a log to attach to bug reports; safe to ship
 * because every line is run through redactSecrets() first (no passwords/tokens),
 * and in a release run through redactEmailAddresses() too (CASA L-7: account
 * and sender addresses are mailbox data). Dev keeps the addresses — the
 * developer debugs from the dev app.log. The file (and its rotated sibling) is
 * readable by the owner only (0600).
 *
 * NOTE: previously this gated on `!app.isPackaged`, but this dev setup runs a
 * renamed Electron binary and `app.isPackaged` misreports `true` in dev — which
 * silently disabled logging locally. It's now unconditional (bounded + redacted),
 * which also gives release logs. In dev the file is gitignored via `*.log`.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { inspect } from 'util';

import { isLogLevel, redactEmailAddresses, redactSecrets } from '@sarvinbox/core';
import { app } from 'electron';
import pino from 'pino';

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB hard cap on the file

// app.log names the user's accounts, folders and correspondents: owner-only.
// Honoured on macOS/Linux; on Windows (NTFS ACLs) it is a harmless no-op.
const LOG_FILE_MODE = 0o600;

// A renderer-forwarded record is untrusted text. Its message is capped at 8 KB
// (characters) in the file: enough for any real log line or stack, small
// enough that a runaway or hostile renderer can't fill the 20 MB cap — and
// push the main process's own trail out of the file — with a handful of calls.
// The whole record is redacted BEFORE the cut, so a secret or address
// straddling it is replaced whole, never half-written. That redaction is a
// linear scan, but address-matching costs ~150 ms per MB in the worst case, so
// a record over 64 KB (no real log line is) is not scanned or written at all:
// a one-line note with its size takes its place. A name over 64 characters
// is dropped too (the renderer's are '' or a short component label).
const MAX_EXTERNAL_TEXT = 8 * 1024;
const MAX_EXTERNAL_RECORD = 64 * 1024;
const MAX_EXTERNAL_NAME = 64;

// The core `createLogger` already prints `[timestamp] [LEVEL] [name] `. Capture
// the LEVEL (so a logger.trace/debug line keeps its true level, not the console
// method it rode in on) AND the NAME, then strip the prefix so the file gets one
// consistently-stamped line. Raw console.log calls (no such prefix) fall back to
// the console-method level below and have no name.
//
// The name used to be captured and thrown away, which quietly broke the one thing
// app.log is for. Every component logger — `[imap-pool]`, `[body-prefetch]`,
// `[inline-image-backfill]` — arrived at the file anonymous, so `grep` by
// component found nothing and the only names left were the ones a few call sites
// happened to repeat inside their message text. Debugging a multi-account install
// was guesswork: two accounts' backfills write identical lines, and there was
// nothing in the file to tell them apart.
const LOGGER_PREFIX =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[([A-Z]+)\] \[([^\]]+)\] /;

// Map the console method to a level label consistent with the core logger
// (console.log carries INFO-level messages).
const LEVEL_BY_METHOD: Record<string, string> = {
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

let active = false;
let logPath = '';
let bytesWritten = 0;
// Release runs: also redact email addresses from every line (set at init).
let redactAddresses = false;
// pino's async file destination (sonic-boom): buffered, NON-blocking writes on
// a background flush, with a reliable flushSync on exit. Replaces the old
// synchronous appendFileSync, which stalled the main-process event loop on every
// flush — the whole point of moving to pino's engine.
let stream: ReturnType<typeof pino.destination> | null = null;
// Once true, console output goes ONLY to app.log, not the terminal. Flipped on
// shutdown so Electron's ~1s of graceful-teardown logs don't spray onto the
// terminal after the shell prompt has already returned (the "stuck" command line).
let terminalMuted = false;

/** Stop tee-ing console output to the terminal (app.log keeps recording). Called
 *  at the very start of shutdown so Ctrl+C leaves a clean, usable prompt. */
export function muteTerminalOutput(): void {
  terminalMuted = true;
}

/**
 * Formatted timestamp in local timezone, matching the core logger style.
 */
function timestamp(): string {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Render a single console argument to a string (objects/errors included).
 */
function render(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  return inspect(arg, { depth: 4, breakLength: Infinity });
}

/** The redaction every line gets before it is written: secrets always, email
 *  addresses too in a release run. */
function scrub(text: string): string {
  const safe = redactSecrets(text);
  return redactAddresses ? redactEmailAddresses(safe) : safe;
}

/**
 * Restrict app.log and its rotated sibling to the owner. A file created by
 * this logger already is (the destination is opened with LOG_FILE_MODE), but
 * one left by an older version was created 0644, and a rename keeps the mode
 * it had. Regular files only: a symlink is not followed (its target is not
 * ours to change) and a directory squatting on the name is left alone.
 * Best-effort: a missing file or a filesystem without POSIX modes is not an
 * error worth surfacing.
 */
function restrictLogFileModes(): void {
  for (const path of [logPath, `${logPath}.1`]) {
    try {
      if (lstatSync(path).isFile()) chmodSync(path, LOG_FILE_MODE);
    } catch { /* missing, or no POSIX modes here — best-effort */ }
  }
}

/**
 * One forwarded record = one line in app.log. CR and LF become the visible
 * escapes `\r` / `\n`, and every other control character (ESC, NUL, the
 * Unicode line/paragraph separators, …) becomes `\uXXXX`, so text from the
 * renderer can neither start a fake line that reads as the main process's own
 * nor drive a terminal that later `cat`s the file.
 */
function toOneLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return c;
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** `text` cut to `max` characters, saying so when it was. */
function capLength(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

/**
 * When the file exceeds the cap, ROTATE it: keep one previous file (`app.log.1`)
 * via a cheap O(1) rename and start a fresh `app.log`. This deliberately avoids
 * the old approach's synchronous `readFileSync` of the whole 20 MB + 10 MB
 * `writeFileSync`, which blocked the main-process event loop (IPC/IMAP/UI stall)
 * every time the cap was hit. Total on-disk footprint is bounded at ~2×MAX (the
 * live file plus one archive). Best-effort — any I/O failure is swallowed so
 * logging never crashes the app.
 */
function trimIfNeeded(): void {
  try {
    const rotated = `${logPath}.1`;
    try { if (existsSync(rotated)) unlinkSync(rotated); } catch { /* ignore */ }
    renameSync(logPath, rotated);
    bytesWritten = 0;
    // sonic-boom keeps writing to the old (renamed) fd until reopen() points it
    // back at the original path → a fresh app.log. O(1), no giant read/write.
    stream?.reopen();
    // The archive keeps whatever mode it had — tighten a legacy 0644 one.
    restrictLogFileModes();
  } catch {
    // ignore
  }
}

/** Force-flush buffered lines to disk SYNCHRONOUSLY. Only needed on shutdown —
 *  sonic-boom flushes on its own in the background during normal operation. */
export function flushFileLogger(): void {
  if (!active || !stream) return;
  try { stream.flushSync(); } catch { /* ignore */ }
}

/**
 * Write one console call to the async pino/sonic-boom stream. Non-blocking:
 * sonic-boom buffers and flushes on a background tick, so this never does a
 * synchronous disk write on the event loop (the old appendFileSync did).
 */
function write(method: string, args: unknown[]): void {
  if (!active || !stream) return;
  try {
    const raw = args.map(render).join(' ');
    // Keep a logger line's OWN level (TRACE/DEBUG/…) captured from its prefix;
    // fall back to the console method for raw console.* calls.
    const prefix = LOGGER_PREFIX.exec(raw);
    const level = prefix?.[1] ?? LEVEL_BY_METHOD[method] ?? method.toUpperCase();
    const name = prefix?.[2];
    const message = scrub(raw.replace(LOGGER_PREFIX, ''));
    const line = `[${timestamp()}] [${level}] ${name ? `[${name}] ` : ''}${message}\n`;
    stream.write(line);
    bytesWritten += Buffer.byteLength(line);
    if (bytesWritten >= MAX_BYTES) trimIfNeeded();
  } catch {
    // ignore
  }
}

/**
 * Write a log line that originated OUTSIDE the main-process console — e.g. the
 * RENDERER, forwarded over IPC — into the SAME app.log stream, redacted and
 * rotated exactly like the tee'd console output. Tagged with its source so
 * renderer lines are greppable and can't be mistaken for main-process ones.
 * Non-blocking (async sonic-boom) and never throws — logging must not crash the
 * app or block the event loop.
 *
 * The record is untrusted (any renderer code can send one), so it can't forge
 * the file's structure: the text is ONE line (see toOneLine) capped at 8 KB,
 * the level must be one of the logger's levels (anything else is INFO), and the
 * name is one line without brackets, at most 64 characters. Main-process
 * lines (write above) are trusted and keep their multi-line stacks.
 */
export function appendExternalLog(source: string, level: unknown, name: unknown, text: string): void {
  if (!active || !stream) return;
  try {
    const lowered = typeof level === 'string' ? level.toLowerCase() : '';
    const label = isLogLevel(lowered) ? lowered.toUpperCase() : 'INFO';
    // The name is a component label: one line, none of its own brackets (it
    // sits inside `[...]`), and short — a longer one is dropped, not cut.
    const safeName = typeof name === 'string' && name.length <= MAX_EXTERNAL_NAME
      ? toOneLine(scrub(name.replace(/[[\]]/g, '')))
      : '';
    // Redact the whole record, THEN cut (see MAX_EXTERNAL_TEXT).
    const message = text.length > MAX_EXTERNAL_RECORD
      ? `[record of ${text.length} characters not written: over the ${MAX_EXTERNAL_RECORD / 1024} KB limit]`
      : capLength(toOneLine(scrub(text)), MAX_EXTERNAL_TEXT);
    const tag = safeName ? `[${source}] [${safeName}] ` : `[${source}] `;
    const line = `[${timestamp()}] [${label}] ${tag}${message}\n`;
    stream.write(line);
    bytesWritten += Buffer.byteLength(line);
    if (bytesWritten >= MAX_BYTES) trimIfNeeded();
  } catch {
    // ignore
  }
}

export interface FileLoggerOptions {
  /**
   * Redact email addresses from every line. main.ts passes `!isDev`: a
   * release's app.log must not name the user's accounts or correspondents,
   * while the dev log keeps them for debugging. Decided by `isDevBuild()`, not
   * `app.isPackaged`, which misreports in dev (see the header).
   */
  redactAddresses?: boolean;
}

/**
 * Patch the main-process console so every call is also written to app.log.
 * Enabled in dev AND release. Safe to call once at startup.
 */
export function initFileLogger(options: FileLoggerOptions = {}): string | null {
  if (active) return logPath;

  redactAddresses = options.redactAddresses === true;
  logPath = join(app.getPath('userData'), 'app.log');
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* dir exists */ }
  bytesWritten = existsSync(logPath) ? statSync(logPath).size : 0;
  restrictLogFileModes();
  // Open the async destination (buffered, non-blocking; creates the file/dir
  // owner-only — `mode` applies when sonic-boom creates it, here and on reopen).
  stream = pino.destination({ dest: logPath, sync: false, mkdir: true, mode: LOG_FILE_MODE });
  active = true;
  if (bytesWritten > MAX_BYTES) trimIfNeeded();

  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      // Skip the TERMINAL write once shutdown starts. In dev, Electron is a child
      // of pnpm/vite; on Ctrl+C those exit and hand the shell its prompt back, but
      // Electron lingers ~1s doing graceful teardown and keeps spraying these logs
      // onto the same terminal AFTER the prompt — which reads as a "stuck" command
      // line. Muting the terminal half here keeps the prompt clean; app.log still
      // records the full shutdown.
      if (!terminalMuted) original(...args);
      write(method, args);
    };
  }

  // Flush any buffered tail on shutdown so the last lines aren't lost.
  try {
    app.on('before-quit', flushFileLogger);
    process.on('exit', flushFileLogger);
  } catch { /* ignore */ }

  console.log(`[file-logger] writing local logs to ${logPath} (cap ${MAX_BYTES / (1024 * 1024)} MB)`);
  // Flush the first line immediately so app.log proves itself on startup rather
  // than depending on the 1s timer / a later burst.
  flushFileLogger();
  return logPath;
}
