import { EventEmitter } from 'events';
import { sep } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Electron transport for the extension sandbox. Pinned behaviour:
 *   - the entry is resolved outside the asar archive, or the fork fails in a
 *     packaged build and extensions never start for any shipped user,
 *   - a child that exits closes the channel, which is how the host learns every
 *     extension has stopped and stands its workflows down,
 *   - a close handler attached after the child already exited still fires,
 *   - closing waits for the sandbox to exit and kills only as a backstop, so a
 *     `deactivate()` that hangs cannot hold up quitting the app,
 *   - nothing is posted to a dead child.
 */

const h = vi.hoisted(() => ({
  children: [] as FakeChild[],
  logs: [] as string[],
}));

class FakeChild extends EventEmitter {
  posted: unknown[] = [];
  killed = 0;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  kill(): void {
    this.killed += 1;
  }

  /** What a real child does when it goes away, for whatever reason. */
  exitWith(code: number): void {
    this.emit('exit', code);
  }
}

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild();
      h.children.push(child);
      return child;
    },
  },
}));

vi.mock('@sarvinbox/core', async (importOriginal) => ({
  // Only the logger is stubbed. `resolveUnpacked` is the real thing — the asar
  // rewrite asserted below is exactly what must not be mocked away.
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: (...args: unknown[]) => h.logs.push(args.join(' ')),
    warn: (...args: unknown[]) => h.logs.push(args.join(' ')),
    error: (...args: unknown[]) => h.logs.push(args.join(' ')),
    debug: () => {},
  }),
}));

async function loadService() {
  vi.resetModules();
  return import('../../../../electron/services/extension-runtime');
}

beforeEach(() => {
  h.children.length = 0;
  h.logs.length = 0;
  vi.useRealTimers();
});

describe('extension sandbox transport', () => {
  // A path inside app.asar cannot be spawned. Getting this wrong breaks
  // extensions only in a packaged build, where nobody is watching a terminal.
  it('resolves the entry outside the asar archive', async () => {
    const { resolveUnpacked } = await import('@sarvinbox/core');
    const { sandboxEntryPath } = await loadService();

    expect(resolveUnpacked(`${sep}Apps${sep}app.asar${sep}dist-electron${sep}x.js`)).toBe(
      `${sep}Apps${sep}app.asar.unpacked${sep}dist-electron${sep}x.js`
    );
    // A directory merely NAMED like the archive must be left alone.
    expect(resolveUnpacked(`${sep}Apps${sep}app.asarbackup${sep}x.js`)).toBe(
      `${sep}Apps${sep}app.asarbackup${sep}x.js`
    );
    expect(sandboxEntryPath()).toContain('extension-sandbox.worker.js');
  });

  // The host reacts to a closed channel by standing every extension down. If a
  // crashed child never reported, the adapters would stay wired to a dead
  // process and fail once per email for the rest of the session.
  it('closes the channel when the child exits', async () => {
    const { createSandboxChannel } = await loadService();
    const channel = createSandboxChannel();

    const closed = vi.fn();
    channel.onClose(closed);
    h.children[0].exitWith(1);

    expect(closed).toHaveBeenCalledTimes(1);
  });

  // A crash during startup can beat the host's own subscription. A handler
  // registered afterwards must still be told, or the host waits forever for a
  // process that is already gone.
  it('tells a late close handler the child has already exited', async () => {
    const { createSandboxChannel } = await loadService();
    const channel = createSandboxChannel();

    h.children[0].exitWith(0);
    const late = vi.fn();
    channel.onClose(late);

    expect(late).toHaveBeenCalledTimes(1);
  });

  // Messages to a dead child would throw out of the bridge's post path, turning
  // one crash into a second failure on a code path that has no way to recover.
  it('drops messages posted after the child exits', async () => {
    const { createSandboxChannel } = await loadService();
    const channel = createSandboxChannel();

    channel.post({ type: 'ready' });
    h.children[0].exitWith(0);
    channel.post({ type: 'shutdown' });

    expect(h.children[0].posted).toEqual([{ type: 'ready' }]);
  });

  // Graceful first: the sandbox exits itself once every deactivate() has run.
  // The kill exists only for a hook that never returns, and must not fire when
  // the child leaves on its own.
  it('waits for a clean exit and never kills the child that leaves on its own', async () => {
    vi.useFakeTimers();
    const { createSandboxChannel, SHUTDOWN_GRACE_MS } = await loadService();
    const channel = createSandboxChannel();

    channel.close();
    h.children[0].exitWith(0);
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS * 2);

    expect(h.children[0].killed).toBe(0);
  });

  // The backstop itself: an extension whose deactivate() hangs would otherwise
  // keep the app from quitting.
  it('kills a sandbox that will not exit within the grace period', async () => {
    vi.useFakeTimers();
    const { createSandboxChannel, SHUTDOWN_GRACE_MS } = await loadService();
    const channel = createSandboxChannel();

    channel.close();
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS + 1);

    expect(h.children[0].killed).toBe(1);
  });
});
