import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three generic extension channels.
 *
 * What breaks if this file goes red: the app starts naming extensions again.
 * These handlers exist so a surface asks for a JOB ('thread.summarize') or
 * reports a fact ('the reader copied a field'), and the main process decides
 * which installed extension that reaches. Pinned here:
 *   - no extension host, or no provider, is the ORDINARY state and must look
 *     like "nothing served it", never like a failure,
 *   - a provider that exists and throws DOES surface, because that is a bug,
 *   - the renderer never names an extension, on either channel.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  manager: null as any,
  errors: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      h.handlers.set(channel, handler);
    },
  },
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => h.errors.push(args.join(' ')),
    debug: () => {},
  }),
  parsePanelRequest: () => null,
  toPanelMessage: (value: unknown) => value,
}));

vi.mock('../../../../electron/services/extension-marketplace', () => ({
  fetchCatalog: vi.fn(),
  getExtensionsConfig: vi.fn(),
  getRegistryEntry: vi.fn(),
  installFromRegistry: vi.fn(),
}));

vi.mock('../../../../electron/shared', () => ({
  getExtensionManager: () => h.manager,
  getMainWindow: () => null,
  getStorage: () => null,
}));

import { registerExtensionHandlers } from '../../../../electron/ipc/extension-handlers';

/** Invoke a registered handler the way `ipcRenderer.invoke` would. */
function call(channel: string, ...args: unknown[]): Promise<any> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for '${channel}'`);
  return Promise.resolve(handler({}, ...args));
}

beforeEach(() => {
  h.handlers.clear();
  h.manager = null;
  h.errors.length = 0;
  registerExtensionHandlers();
});

describe('extensions:invoke', () => {
  it('passes the args through and returns what the provider served', async () => {
    const invokeCapability = vi.fn(async () => ({
      served: true,
      extensionId: 'summarizer',
      value: { summary: 'two people agreed a date' },
    }));
    h.manager = { invokeCapability };

    const result = await call('extensions:invoke', 'thread.summarize', [{ id: 'e1' }]);

    expect(invokeCapability).toHaveBeenCalledWith('thread.summarize', [{ id: 'e1' }]);
    expect(result).toEqual({
      success: true,
      data: { served: true, extensionId: 'summarizer', value: { summary: 'two people agreed a date' } },
    });
  });

  // Regression: a fresh install has no extensions. Reporting that as an error
  // would put a failure dialog in front of every user who installed none.
  it('reports "nothing served it" when there is no extension host', async () => {
    expect(await call('extensions:invoke', 'thread.summarize', [])).toEqual({
      success: true,
      data: { served: false },
    });
  });

  it('reports "nothing served it" when no extension declares the capability', async () => {
    h.manager = { invokeCapability: async () => ({ served: false }) };

    expect(await call('extensions:invoke', 'thread.summarize', [])).toEqual({
      success: true,
      data: { served: false },
    });
  });

  // Regression: an extension that DOES serve the job and then fails is a bug
  // worth seeing — swallowing it into `served: false` would silently fall back
  // to the built-in path forever and hide a broken extension.
  it('surfaces a provider that throws', async () => {
    h.manager = {
      invokeCapability: async () => {
        throw new Error('model refused the request');
      },
    };

    expect(await call('extensions:invoke', 'thread.summarize', [])).toEqual({
      success: false,
      error: 'model refused the request',
    });
    expect(h.errors.join('\n')).toContain('thread.summarize');
  });

  it('rejects a missing or non-string capability id', async () => {
    h.manager = { invokeCapability: vi.fn() };

    expect(await call('extensions:invoke', '')).toMatchObject({ success: false });
    expect(await call('extensions:invoke', 42 as unknown as string)).toMatchObject({ success: false });
    expect(h.manager.invokeCapability).not.toHaveBeenCalled();
  });

  // Regression: `invokeCapability` spreads the args. A caller that forgets the
  // array (or a preload that sends `undefined` for a no-arg call) must become
  // an empty call, not a spread of undefined.
  it('treats a non-array args value as no arguments', async () => {
    const invokeCapability = vi.fn(async () => ({ served: false }));
    h.manager = { invokeCapability };

    await call('extensions:invoke', 'thread.summarize');
    await call('extensions:invoke', 'thread.summarize', 'not an array');

    expect(invokeCapability).toHaveBeenNthCalledWith(1, 'thread.summarize', []);
    expect(invokeCapability).toHaveBeenNthCalledWith(2, 'thread.summarize', []);
  });
});

describe('extensions:capabilities', () => {
  it('lists what is currently served', async () => {
    h.manager = {
      listCapabilities: () => [{ id: 'thread.summarize', extensionId: 'summarizer', priority: 10 }],
    };

    expect(await call('extensions:capabilities')).toEqual({
      success: true,
      data: [{ id: 'thread.summarize', extensionId: 'summarizer', priority: 10 }],
    });
  });

  it('is an empty list, not an error, with no extension host', async () => {
    expect(await call('extensions:capabilities')).toEqual({ success: true, data: [] });
  });
});

describe('extensions:cardAction', () => {
  // Regression: the renderer reports the namespaced id and WHAT happened; the
  // main process works out whose card it was. If the renderer ever had to name
  // the extension, every card would leak the id namespacing scheme.
  it('hands the namespaced id and the action to the manager', async () => {
    const dispatchNotificationAction = vi.fn(async () => true);
    h.manager = { dispatchNotificationAction };

    const result = await call('extensions:cardAction', 'otp-code:email-1', {
      action: 'copy',
      emailId: 'email-1',
      fieldLabel: 'Code',
    });

    expect(dispatchNotificationAction).toHaveBeenCalledWith('otp-code:email-1', {
      action: 'copy',
      emailId: 'email-1',
      fieldLabel: 'Code',
    });
    expect(result).toEqual({ success: true, data: true });
  });

  // Regression: a card left on screen after its extension was disabled must
  // resolve quietly. An error here becomes a dialog on an ordinary dismiss.
  it('resolves false rather than failing when nothing can take the action', async () => {
    h.manager = { dispatchNotificationAction: async () => false };
    expect(await call('extensions:cardAction', 'gone:c1', { action: 'dismiss' })).toEqual({
      success: true,
      data: false,
    });

    h.manager = null;
    expect(await call('extensions:cardAction', 'gone:c1', { action: 'dismiss' })).toEqual({
      success: true,
      data: false,
    });
  });

  it('rejects a call with no id or no action', async () => {
    h.manager = { dispatchNotificationAction: vi.fn() };

    expect(await call('extensions:cardAction', '', { action: 'copy' })).toMatchObject({ success: false });
    expect(await call('extensions:cardAction', 'otp-code:c1', {})).toMatchObject({ success: false });
    expect(await call('extensions:cardAction', 'otp-code:c1', undefined)).toMatchObject({
      success: false,
    });
    expect(h.manager.dispatchNotificationAction).not.toHaveBeenCalled();
  });

  it('surfaces a handler that throws inside the extension', async () => {
    h.manager = {
      dispatchNotificationAction: async () => {
        throw new Error('sandbox is gone');
      },
    };

    expect(await call('extensions:cardAction', 'otp-code:c1', { action: 'copy' })).toEqual({
      success: false,
      error: 'sandbox is gone',
    });
  });
});
