/* eslint-disable no-console -- the capture silences the console while it runs and puts it back */
import { inspect } from 'node:util';

import type { LogLevel, LogSink } from '../utils/logger';

/**
 * The logger controls of ONE module instance. Core tests pass the source
 * module's; desktop tests pass `@sarvinbox/core`'s (the built copy their code
 * under test logs through), since each instance keeps its own sink and level.
 */
export interface LoggerControls {
  setLogSink(sink: LogSink | null): void;
  setLogLevel(level: LogLevel): void;
  getLogLevel(): LogLevel;
}

export interface CapturedLogs {
  /**
   * Every record written while capturing, as app.log would show it: level,
   * logger name, message, then each argument (objects through util.inspect, as
   * the file logger prints them). A raw `console.*` call is a line too, as
   * `[CONSOLE.<method>] …`: in the main process the file logger writes the
   * console to app.log, a release build included.
   */
  readonly lines: string[];
  /** The captured lines that contain `needle` (a test's sentinel). */
  containing(needle: string): string[];
  /** Stop capturing and put the previous level, sink-less logger and console back. */
  stop(): void;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** The head of the logger's own console write: `[<timestamp>] [LEVEL] [`. */
const LOGGER_WRITE = /^\[[^\]]*\] \[(?:TRACE|DEBUG|INFO|WARN|ERROR)\] \[/;

function render(head: string, args: readonly unknown[]): string {
  return [head, ...args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 6 })))].join(' ');
}

/**
 * Capture what a module logs, for a test that proves a value (mail text, a
 * file name, a typed search) never reaches app.log. Captures at `level`
 * ('trace' by default, so a debug line counts too), records raw `console.*`
 * calls as well, and keeps the console quiet while it runs. Always `stop()`
 * it, in an `afterEach` or a `finally`.
 */
export function captureLogs(controls: LoggerControls, options: { level?: LogLevel } = {}): CapturedLogs {
  const lines: string[] = [];
  const previousLevel = controls.getLogLevel();
  const saved = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
  // The logger writes the console first and then the sink, both in one call.
  // Its console write is recorded without the timestamp (so a logger instance
  // other than `controls`' still counts) and the sink's identical record right
  // after it is then not recorded twice.
  let loggerWrite: string | null = null;
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      const [first, ...rest] = args;
      if (typeof first === 'string' && LOGGER_WRITE.test(first)) {
        loggerWrite = render(first.slice(first.indexOf('] ') + 2), rest);
        lines.push(loggerWrite);
        return;
      }
      loggerWrite = null;
      lines.push(render(`[CONSOLE.${method}]`, args));
    };
  }
  controls.setLogLevel(options.level ?? 'trace');
  controls.setLogSink((level, name, message, args) => {
    const line = render(`[${level.toUpperCase()}] [${name}] ${message}`, args);
    const echoed = line === loggerWrite;
    loggerWrite = null;
    if (!echoed) lines.push(line);
  });
  return {
    lines,
    containing: (needle) => lines.filter((line) => line.includes(needle)),
    stop() {
      controls.setLogSink(null);
      controls.setLogLevel(previousLevel);
      for (const [method, fn] of saved) console[method] = fn;
    },
  };
}
