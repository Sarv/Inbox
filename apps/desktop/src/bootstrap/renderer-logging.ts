// Renderer logging setup — import FIRST (before any module that logs) so the
// app.log forwarder is in place from the very first line.
//
// The renderer logs via raw console.* (not the shared @sarvinbox/core logger),
// and those lines otherwise live ONLY in DevTools — missing from the app.log you
// attach to a bug report. We patch console.* so every line is ALSO shipped to the
// main process, which writes it into the SAME pino app.log (redacted there).
//
// IMPORTANT: this file imports NOTHING from '@sarvinbox/core'. That barrel
// transitively pulls Node-only modules (mailparser → 'stream') into the renderer
// bundle, which throws "Dynamic require of 'stream' is not supported" at load.
// Keep this dependency-free.

type Method = 'log' | 'info' | 'warn' | 'error' | 'debug';

// console method → log level, matching the main-process file-logger mapping.
const LEVEL_BY_METHOD: Record<Method, string> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

// Level policy, mirroring electron/main.ts: dev forwards everything; release drops
// debug so the shipped app.log stays lean (warn/error/info still captured). A
// build-time VITE_LOG_LEVEL=debug override re-enables debug in release for QA.
const FORWARD_DEBUG = import.meta.env.DEV || (import.meta.env.VITE_LOG_LEVEL as string | undefined)?.toLowerCase() === 'debug';

// Render one console arg to a string (the browser has no util.inspect). Errors
// keep their stack; objects are JSON'd; anything unserialisable falls back to
// String(). Never throws.
function renderArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

const methods: Method[] = ['log', 'info', 'warn', 'error', 'debug'];
for (const method of methods) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(...args); // keep DevTools output
    try {
      if (method === 'debug' && !FORWARD_DEBUG) return;
      if (args.length === 0) return;
      const text = args.map(renderArg).join(' ');
      // Fire-and-forget (ipcRenderer.send under the hood) so logging never blocks
      // the UI on an IPC round-trip. electronAPI is injected by the preload.
      window.electronAPI?.log?.forward?.({ level: LEVEL_BY_METHOD[method], name: '', text });
    } catch {
      // logging must never throw into the caller
    }
  };
}

// Main-thread stall detector. Chromium fires a 'longtask' PerformanceEntry for any
// task that blocks the thread >50ms; we log the ones long enough to surface a
// loader/jank (>=200ms) into app.log (via the console patch above). This turns the
// vague "1–3s rainbow loader in random places" into concrete evidence — correlate
// the logged timestamp + duration with the surrounding log lines to see exactly
// which operation blocked. Best-effort: guarded so it's a no-op where 'longtask'
// or PerformanceObserver isn't available (e.g. the node test env).
const LONG_TASK_MS = 200;
try {
  if (typeof PerformanceObserver !== 'undefined') {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= LONG_TASK_MS) {
          console.warn(`[perf] main-thread stall: ${Math.round(entry.duration)}ms long task (UI blocked → loader/jank)`);
        }
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  }
} catch {
  // longtask unsupported — skip; instrumentation must never break startup
}
