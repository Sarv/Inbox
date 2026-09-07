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
