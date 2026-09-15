/**
 * File Logger (dev AND release)
 *
 * Tees the main-process console output to a rolling `app.log` in the userData
 * dir (next to sarvinbox.db), capped at 20 MB — once past the cap the oldest
 * half is dropped so it never grows unbounded. Enabled in BOTH dev and packaged
 * builds so a shipped release has a log to attach to bug reports; safe to ship
 * because every line is run through redactSecrets() first (no passwords/tokens).
 *
 * NOTE: previously this gated on `!app.isPackaged`, but this dev setup runs a
 * renamed Electron binary and `app.isPackaged` misreports `true` in dev — which
 * silently disabled logging locally. It's now unconditional (bounded + redacted),
 * which also gives release logs. In dev the file is gitignored via `*.log`.
 */

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { inspect } from 'util';

import { app } from 'electron';
import pino from 'pino';

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB hard cap on the file

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

// Credential-ish key/value pairs, matched in both JSON (`"password":"x"`) and
// util.inspect (`password: 'x'`) forms, so a stray console.log(config) or an
// error carrying a token can never land in app.log in plaintext. Over-redaction
// is the safe side here — a log file is not worth a leaked secret.
const SECRET_KV_RE = /(["']?(?:password|passwd|pass|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|api[_-]?key|client[_-]?secret|secret)["']?\s*[:=]\s*)(["'`])(?:\\.|(?!\2).)*\2/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;

/**
 * Replace secret values with [REDACTED] before a line is written to disk (or,
 * reused by the Sentry breadcrumb path, before it leaves the machine).
 */
export function redactSecrets(s: string): string {
  return s
    .replace(SECRET_KV_RE, (_m, key: string, quote: string) => `${key}${quote}[REDACTED]${quote}`)
    .replace(BEARER_RE, '$1[REDACTED]');
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
    const message = redactSecrets(raw.replace(LOGGER_PREFIX, ''));
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
 */
export function appendExternalLog(source: string, level: string, name: string, text: string): void {
  if (!active || !stream) return;
  try {
    const tag = name ? `[${source}] [${name}] ` : `[${source}] `;
    const message = redactSecrets(`${tag}${text}`);
    const line = `[${timestamp()}] [${(level || 'info').toUpperCase()}] ${message}\n`;
    stream.write(line);
    bytesWritten += Buffer.byteLength(line);
    if (bytesWritten >= MAX_BYTES) trimIfNeeded();
  } catch {
    // ignore
  }
}

/**
 * Patch the main-process console so every call is also written to app.log.
 * Enabled in dev AND release. Safe to call once at startup.
 */
export function initFileLogger(): string | null {
  if (active) return logPath;

  logPath = join(app.getPath('userData'), 'app.log');
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* dir exists */ }
  bytesWritten = existsSync(logPath) ? statSync(logPath).size : 0;
  // Open the async destination (buffered, non-blocking; creates the file/dir).
  stream = pino.destination({ dest: logPath, sync: false, mkdir: true });
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
