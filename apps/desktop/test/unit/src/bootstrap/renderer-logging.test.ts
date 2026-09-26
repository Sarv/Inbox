import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// renderer-logging patches the global console at import time (and never restores
// it), and reads window.electronAPI at CALL time. So we snapshot/restore console
// ourselves and install a fake bridge per test, re-importing the module fresh so
// its import-time console patch runs against the console we control.

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
let originals: Record<string, any> = {};
let forward: ReturnType<typeof vi.fn>;

const load = async (): Promise<void> => {
  vi.resetModules();
  await import('../../../../src/bootstrap/renderer-logging');
};

beforeEach(() => {
  originals = {};
  for (const m of CONSOLE_METHODS) originals[m] = (console as any)[m];
  forward = vi.fn();
  (globalThis as any).window = { electronAPI: { log: { forward } } };
});

afterEach(() => {
  for (const m of CONSOLE_METHODS) (console as any)[m] = originals[m];
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

describe('renderer console → app.log forwarder', () => {
  it('forwards info/warn/error to the bridge with the mapped level and joined text', async () => {
    await load();
    console.info('hello');
    expect(forward).toHaveBeenCalledWith({ level: 'info', name: '', text: 'hello' });
    console.warn('a', 'b');
    expect(forward).toHaveBeenCalledWith({ level: 'warn', name: '', text: 'a b' });
    console.error('boom');
    expect(forward).toHaveBeenCalledWith({ level: 'error', name: '', text: 'boom' });
  });

  it('maps console.log to the info level', async () => {
    await load();
    console.log('plain');
    expect(forward).toHaveBeenCalledWith({ level: 'info', name: '', text: 'plain' });
  });

  it('renders an Error with its stack and an object as JSON', async () => {
    await load();
    console.error(new Error('kaboom'));
    expect(forward.mock.calls[0][0].text).toContain('kaboom');

    forward.mockClear();
    console.info('cfg', { a: 1 });
    expect(forward).toHaveBeenCalledWith({ level: 'info', name: '', text: 'cfg {"a":1}' });
  });

  it('still calls the ORIGINAL console (DevTools passthrough is preserved)', async () => {
    const original = vi.fn();
    (console as any).info = original; // the wrapper captures this as the original
    await load();
    console.info('x');
    expect(original).toHaveBeenCalledWith('x');
  });

  it('does not forward when there are no args', async () => {
    await load();
    console.log();
    expect(forward).not.toHaveBeenCalled();
  });

  it('forwards debug in the dev/test env (vitest runs in DEV)', async () => {
    await load();
    console.debug('dbg');
    expect(forward).toHaveBeenCalledWith({ level: 'debug', name: '', text: 'dbg' });
  });

  it('never throws when the bridge is absent (preload not ready / older shell)', async () => {
    (globalThis as any).window = {}; // no electronAPI
    await load();
    expect(() => console.error('no bridge')).not.toThrow();
  });

  it('never lets an object it cannot serialise break the caller', async () => {
    await load();
    const circular: any = {};
    circular.self = circular; // JSON.stringify throws → renderArg falls back to String()
    expect(() => console.info('cyc', circular)).not.toThrow();
    expect(forward).toHaveBeenCalled();
  });
});

describe('uncaught error + unhandled rejection forwarding', () => {
  // What breaks if these fail: a renderer that dies at module-evaluation time (the
  // "Dynamic require of 'path' is not supported" class of failure) writes NOTHING to
  // app.log -- the log looks like a healthy boot next to a white window, and the only
  // evidence lives in a DevTools console nobody has open.
  let listeners: Record<string, (event: any) => void>;

  beforeEach(() => {
    listeners = {};
    (globalThis as any).window = {
      electronAPI: { log: { forward } },
      addEventListener: (type: string, handler: (event: any) => void) => {
        listeners[type] = handler;
      },
    };
  });

  it('registers both window listeners at import time', async () => {
    await load();
    expect(Object.keys(listeners).sort()).toEqual(['error', 'unhandledrejection']);
  });

  it('forwards an uncaught error with its stack and source location', async () => {
    await load();
    const error = new Error('kaboom');
    listeners.error({ message: 'Uncaught Error: kaboom', filename: 'http://localhost:5173/x.js', lineno: 12, colno: 5, error });

    const { level, text } = forward.mock.calls.at(-1)![0];
    expect(level).toBe('error');
    expect(text).toContain('[uncaught]');
    expect(text).toContain('kaboom');
    expect(text).toContain('http://localhost:5173/x.js:12:5');
  });

  it('falls back to the message when the event carries no Error (cross-origin "Script error.")', async () => {
    await load();
    listeners.error({ message: 'Script error.', filename: '', lineno: 0, colno: 0, error: undefined });
    expect(forward.mock.calls.at(-1)![0].text).toBe('[uncaught] Script error.');
  });

  it('forwards an unhandled rejection at error level', async () => {
    await load();
    listeners.unhandledrejection({ reason: new Error('no network') });

    const { level, text } = forward.mock.calls.at(-1)![0];
    expect(level).toBe('error');
    expect(text).toContain('[unhandled rejection]');
    expect(text).toContain('no network');
  });

  it('renders a non-Error rejection reason (a string or an object) instead of dropping it', async () => {
    await load();
    listeners.unhandledrejection({ reason: 'plain string' });
    expect(forward.mock.calls.at(-1)![0].text).toBe('[unhandled rejection] plain string');

    listeners.unhandledrejection({ reason: { code: 'EAUTH' } });
    expect(forward.mock.calls.at(-1)![0].text).toBe('[unhandled rejection] {"code":"EAUTH"}');
  });

  it('never throws out of the listener when the bridge is missing', async () => {
    (globalThis as any).window = {
      addEventListener: (type: string, handler: (event: any) => void) => {
        listeners[type] = handler;
      },
    };
    await load();
    expect(() => listeners.error({ message: 'boom', filename: '', lineno: 0, colno: 0, error: new Error('boom') })).not.toThrow();
    expect(() => listeners.unhandledrejection({ reason: undefined })).not.toThrow();
  });

  it('is a no-op where window has no addEventListener (node test env / preload-less shell)', async () => {
    (globalThis as any).window = { electronAPI: { log: { forward } } };
    await expect(load()).resolves.toBeUndefined();
    expect(Object.keys(listeners)).toHaveLength(0);
  });
});
