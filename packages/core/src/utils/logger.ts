// Logging utilities

/**
 * Simple logger interface
 */
export interface Logger {
  /** TRACE = high-volume per-item detail (per-email, per-query). OFF even in
   *  debug mode — only prints when the level is explicitly set to 'trace'. */
  trace(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  /** Cheap check to skip building an expensive message when the level is off,
   *  e.g. `if (log.isLevelEnabled('trace')) log.trace(buildBigString())`. */
  isLevelEnabled(level: LogLevel): boolean;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

// Numeric severities (pino-style). A message prints only when its level is >=
// the configured minimum. Default 'info' → trace AND debug are dropped cheaply.
const LEVEL_VALUE: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

function envLogLevel(): LogLevel | undefined {
  const v = (typeof process !== 'undefined' ? process.env?.['SARV_LOG_LEVEL'] : undefined)?.toLowerCase();
  return v && v in LEVEL_VALUE ? (v as LogLevel) : undefined;
}

// Default 'debug' so the IMAP command trace + diagnostics are visible without
// extra config. High-volume per-item noise lives at 'trace' (below this), so it
// stays OFF at debug. Override with SARV_LOG_LEVEL (e.g. 'info' to quiet down,
// 'trace' for the full per-item firehose).
let minLevelValue = LEVEL_VALUE[envLogLevel() ?? 'debug'];

/** Set the process-wide minimum log level. Below it, calls are a near no-op. */
export function setLogLevel(level: LogLevel): void {
  minLevelValue = LEVEL_VALUE[level] ?? minLevelValue;
}

/** The current minimum log level (as a label). */
export function getLogLevel(): LogLevel {
  return (Object.keys(LEVEL_VALUE) as LogLevel[]).find((l) => LEVEL_VALUE[l] === minLevelValue) ?? 'info';
}

function levelEnabled(level: LogLevel): boolean {
  return LEVEL_VALUE[level] >= minLevelValue;
}

/**
 * Optional destination for log records, in addition to the console. The
 * Electron main process registers one to forward every log line into Sentry as
 * a breadcrumb, so a captured error carries the trail that led to it (e.g. the
 * IMAP connection-state transitions and reconnect attempts). Kept as a plain
 * callback so this module stays framework-agnostic and dependency-free — core
 * must not import Electron/Sentry.
 */
export type LogSink = (level: LogLevel, name: string, message: string, args: unknown[]) => void;

let logSink: LogSink | null = null;

/**
 * Register (or clear, with `null`) the process-wide log sink. Wrapped in
 * try/catch at each call site so a misbehaving sink can never break logging.
 */
export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

function emitToSink(level: LogLevel, name: string, message: string, args: unknown[]): void {
  if (!logSink) return;
  try {
    logSink(level, name, message, args);
  } catch {
    // A logging sink must never throw into the caller.
  }
}

/**
 * Get formatted timestamp in local timezone
 */
function getTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * Create a logger instance
 */
export function createLogger(name: string): Logger {
  return {
    trace: (message: string, ...args: any[]) => {
      if (!levelEnabled('trace')) return;
      console.debug(`[${getTimestamp()}] [TRACE] [${name}] ${message}`, ...args);
      emitToSink('trace', name, message, args);
    },
    debug: (message: string, ...args: any[]) => {
      if (!levelEnabled('debug')) return;
      console.debug(`[${getTimestamp()}] [DEBUG] [${name}] ${message}`, ...args);
      emitToSink('debug', name, message, args);
    },
    info: (message: string, ...args: any[]) => {
      if (!levelEnabled('info')) return;
      console.log(`[${getTimestamp()}] [INFO] [${name}] ${message}`, ...args);
      emitToSink('info', name, message, args);
    },
    warn: (message: string, ...args: any[]) => {
      if (!levelEnabled('warn')) return;
      console.warn(`[${getTimestamp()}] [WARN] [${name}] ${message}`, ...args);
      emitToSink('warn', name, message, args);
    },
    error: (message: string, ...args: any[]) => {
      if (!levelEnabled('error')) return;
      console.error(`[${getTimestamp()}] [ERROR] [${name}] ${message}`, ...args);
      emitToSink('error', name, message, args);
    },
    isLevelEnabled: (level: LogLevel) => levelEnabled(level),
  };
}

/**
 * Default logger
 */
export const logger = createLogger('sarvinbox');
