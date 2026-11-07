/**
 * One sandbox per extension, and nothing a sandbox says believed about who said it.
 *
 * The extension shares a thread with the engine on the far side of the channel, so
 * it can post anything on that port. These drive the real bridge and host with a
 * channel a test holds the far end of, posting what hostile code would post.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionContextImpl } from '../../../src/extensions/extension-api';
import type {
  ExtensionNetworkBackend,
  ExtensionSettingsBackend,
  ExtensionStorageBackend,
  ExtensionUIBackend,
} from '../../../src/extensions/extension-api';
import {
  ACTIVATE_ALL_WAIT_MS,
  EXTENSION_FAILED_TO_START,
  EXTENSION_HELD_BACK,
  ExtensionHost,
  MAX_NAME_ON_PROBLEM_CARD,
  SANDBOX_RESTART_DELAYS_MS,
  SANDBOX_RESTART_FORGIVE_MS,
} from '../../../src/extensions/extension-host';
import type { LoadedExtension } from '../../../src/extensions/extension-loader';
import { ExtensionManager } from '../../../src/extensions/extension-manager';
import type { ExtensionRegistry } from '../../../src/extensions/extension-registry';
import {
  DEACTIVATE_TIMEOUT_MS,
  ExtensionBridge,
  HOST_CALL_SLICE_MS,
  MAX_DESCRIPTION_LENGTH,
  MAX_EXPORTS_PER_EXTENSION,
  MAX_IDENTIFIER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LABELS_PER_CHANGE,
  MAX_QUEUED_HOST_CALLS,
  MAX_SUBSCRIPTIONS_PER_EXTENSION,
  MAX_WORKFLOW_REGISTRATIONS,
  MAX_WORKFLOWS_PER_EXTENSION,
} from '../../../src/extensions/runtime/extension-bridge';
import { FLOOD_BASE_MESSAGES, FLOOD_BYTES, MAX_MESSAGE_BYTES } from '../../../src/extensions/runtime/flood-budget';
import { createInProcessChannelPair } from '../../../src/extensions/runtime/in-process-channel';
import { LOG_LINES_PER_WINDOW, MAX_EXTENSION_LOG_LINE } from '../../../src/extensions/runtime/log-budget';
import { createNodeModuleLoader } from '../../../src/extensions/runtime/node-module-loader';
import type { ExtensionChannel, SandboxTarget } from '../../../src/extensions/runtime/protocol';
import { createRemoteExports } from '../../../src/extensions/runtime/remote-proxies';
import { startExtensionSandbox, type SandboxExtensionModule } from '../../../src/extensions/runtime/sandbox';
import { UnsupportedNodeApiError } from '../../../src/extensions/runtime/unsupported-node-api';
import { ExtensionState, type ExtensionContext, type ExtensionInfo, type ExtensionManifest, type ExtensionPermission } from '../../../src/extensions/types';
import { createEventBus } from '../../../src/pipeline/event-bus';
import type { WorkflowContext } from '../../../src/pipeline/types';
import type { EmailRecord } from '../../../src/types/models';
import { setLogSink } from '../../../src/utils/logger';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sarvinbox-boundary-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(workDir, { recursive: true, force: true });
});

function manifestFor(id: string, permissions: ExtensionPermission[] = []): ExtensionManifest {
  return {
    id,
    name: `${id} name`,
    version: '1.0.0',
    description: 'd',
    author: 'a',
    main: 'index.js',
    engines: { sarvinbox: '>=0.1.0' },
    permissions,
  } as ExtensionManifest;
}

function extension(id: string, source = 'exports.activate = () => {};'): LoadedExtension {
  const dir = join(workDir, id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), source);
  return { manifest: manifestFor(id), path: dir, entryPoint: join(dir, 'dist', 'index.js') };
}

function fakeRegistry() {
  const infos = new Map<string, ExtensionInfo>();
  return {
    infos,
    getRuntimeInfo: (id: string) => infos.get(id),
    setRuntimeInfo: (id: string, info: ExtensionInfo) => infos.set(id, info),
    getLoaded: () => undefined,
    get: () => undefined,
    filter: () => [],
  } as unknown as ExtensionRegistry & { infos: Map<string, ExtensionInfo> };
}

function memoryStorage(): ExtensionStorageBackend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(id: string, key: string) {
      return data.get(`${id}::${key}`) as T | undefined;
    },
    async set(id: string, key: string, value: unknown) {
      data.set(`${id}::${key}`, value);
    },
    async delete(id: string, key: string) {
      data.delete(`${id}::${key}`);
    },
    async keys() {
      return [];
    },
    async clear() {},
  };
}

const memorySettings = (): ExtensionSettingsBackend => ({
  get: () => undefined,
  update: async () => undefined,
  has: () => false,
  keys: () => [],
});

/** A sandbox a test can speak for: the bridge end goes to the host, the far end stays here. */
function hostileChannel() {
  const pair = createInProcessChannelPair();
  const received: { type: string; requestId?: string; ok?: boolean; error?: { message: string; stack?: string }; value?: unknown }[] = [];
  pair.sandbox.onMessage((message) => received.push(message as (typeof received)[number]));
  return { channel: pair.host, far: pair.sandbox, received };
}

function bridgeFor(extensionId: string, channel: ExtensionChannel, context: ExtensionContextImpl, hooks = {}) {
  return new ExtensionBridge({
    channel,
    extensionId,
    hooks: {
      getContext: (id) => (id === extensionId ? context : undefined),
      onWorkflowRegistered: vi.fn(),
      onWorkflowUnregistered: vi.fn(),
      onSandboxClosed: vi.fn(),
      ...hooks,
    },
  });
}

function contextFor(id: string, permissions: ExtensionPermission[], extra: Record<string, unknown> = {}) {
  return new ExtensionContextImpl({
    manifest: manifestFor(id, permissions),
    storagePath: join(workDir, id),
    grantedPermissions: permissions,
    eventBus: createEventBus(),
    storageBackend: memoryStorage(),
    settingsBackend: memorySettings(),
    ...extra,
  });
}

const emailFixture = () => ({ id: 'e1', subject: 's', tags: '|INBOX|' }) as unknown as EmailRecord;

async function replyTo(received: { type: string; requestId?: string }[], requestId: string) {
  await vi.waitFor(() =>
    expect(received.some((m) => m.type === 'host-reply' && m.requestId === requestId)).toBe(true)
  );
  return received.find((m) => m.type === 'host-reply' && m.requestId === requestId) as {
    ok: boolean;
    value?: unknown;
    error?: { message: string; stack?: string };
  };
}

describe('a bridge believes nothing about who sent a message', () => {
  // The cross-extension attack: an extension with no storage permission asks for
  // another extension's data in that extension's name. It works if the bridge reads
  // the id from the message, which is exactly what a shared channel would have to do.
  it('refuses a host call in another extension name, and touches nothing', async () => {
    const { channel, far, received } = hostileChannel();
    const storage = memoryStorage();
    await storage.set('victim', 'secret', 'VICTIM');
    const getContext = vi.fn(() => contextFor('victim', ['storage:local'], { storageBackend: storage }));
    const bridge = new ExtensionBridge({
      channel,
      extensionId: 'attacker',
      hooks: { getContext, onWorkflowRegistered: vi.fn(), onWorkflowUnregistered: vi.fn(), onSandboxClosed: vi.fn() },
    });

    far.post({ type: 'host-call', requestId: 'hc', extensionId: 'victim', method: 'storage.get', args: ['secret'] });

    const reply = await replyTo(received, 'hc');
    expect(reply.ok).toBe(false);
    expect(reply.error?.message).toContain('its own extension');
    expect(reply.value).toBeUndefined();
    expect(getContext).not.toHaveBeenCalled();
    await bridge.shutdown();
  });

  // A call made honestly still has to be answered from this extension's own context.
  it('serves a host call in its own name from its own context', async () => {
    const { channel, far, received } = hostileChannel();
    const storage = memoryStorage();
    await storage.set('mine', 'k', 'v');
    const bridge = bridgeFor('mine', channel, contextFor('mine', ['storage:local'], { storageBackend: storage }));

    far.post({ type: 'host-call', requestId: 'hc', extensionId: 'mine', method: 'storage.get', args: ['k'] });

    expect(await replyTo(received, 'hc')).toMatchObject({ ok: true, value: 'v' });
    await bridge.shutdown();
  });

  // A log line in another extension's name would frame it: the log is what answers
  // "which extension did this?".
  it('attributes a log line to the channel, not to the claim', async () => {
    const { channel, far } = hostileChannel();
    const bridge = bridgeFor('attacker', channel, contextFor('attacker', []));
    const lines: string[] = [];
    setLogSink((_level, _name, message) => lines.push(message));

    far.post({ type: 'log', extensionId: 'victim', level: 'info', message: 'FORGED' });
    await vi.waitFor(() => expect(lines.some((line) => line.includes('FORGED'))).toBe(true));
    setLogSink(null);

    expect(lines.find((line) => line.includes('FORGED'))).toBe('[Extension:attacker] FORGED');
    await bridge.shutdown();
  });

  // Adapters are keyed by workflow id and the id names its extension. Taken on trust,
  // one extension could remove another's workflow, so that mail silently stops being
  // processed by it, or install one under its name.
  it.each([
    ['workflow.unregister', ['victim.w']],
    ['workflow.unregister', [42]],
    ['workflow.register', [{ fullId: 'victim.evil', id: 'evil', name: 'evil' }]],
    ['workflow.register', [undefined]],
  ])('refuses %s of a workflow that is not its own', async (method, args) => {
    const { channel, far, received } = hostileChannel();
    const onWorkflowRegistered = vi.fn();
    const onWorkflowUnregistered = vi.fn();
    const bridge = bridgeFor('attacker', channel, contextFor('attacker', ['email:read']), {
      onWorkflowRegistered,
      onWorkflowUnregistered,
    });

    far.post({ type: 'host-call', requestId: 'hc', extensionId: 'attacker', method, args });

    const reply = await replyTo(received, 'hc');
    expect(reply.ok).toBe(false);
    expect(onWorkflowRegistered).not.toHaveBeenCalled();
    expect(onWorkflowUnregistered).not.toHaveBeenCalled();
    await bridge.shutdown();
  });

  // The same id prefix, honestly used, must still work, or a workflow registered
  // after activation never runs.
  it('accepts a workflow id that is its own', async () => {
    const { channel, far, received } = hostileChannel();
    const onWorkflowRegistered = vi.fn();
    const bridge = bridgeFor('mine', channel, contextFor('mine', ['email:read']), { onWorkflowRegistered });

    far.post({
      type: 'host-call',
      requestId: 'hc',
      extensionId: 'mine',
      method: 'workflow.register',
      args: [{ fullId: 'mine.w', id: 'w', name: 'w' }],
    });

    expect(await replyTo(received, 'hc')).toMatchObject({ ok: true });
    expect(onWorkflowRegistered).toHaveBeenCalledWith('mine', expect.objectContaining({ fullId: 'mine.w' }));
    await bridge.shutdown();
  });

  // A stack from main names where the app is installed and, on most machines, the
  // user's home directory. Confined code has no other way to learn either.
  it('sends no stack back into the sandbox', async () => {
    const { channel, far, received } = hostileChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));

    far.post({ type: 'host-call', requestId: 'hc', extensionId: 'mine', method: 'storage.get', args: ['k'] });

    const reply = await replyTo(received, 'hc');
    expect(reply.ok).toBe(false);
    expect(reply.error?.message).toContain('storage:local');
    expect(reply.error?.stack).toBeUndefined();
    await bridge.shutdown();
  });

  // Unknown methods stay a refusal: a lookup that fell through would answer success.
  it('refuses a method it does not know', async () => {
    const { channel, far, received } = hostileChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));

    far.post({ type: 'host-call', requestId: 'hc', extensionId: 'mine', method: 'fs.readFile', args: ['/etc/passwd'] });

    expect((await replyTo(received, 'hc')).error?.message).toContain("Unknown host call 'fs.readFile'");
    await bridge.shutdown();
  });

  // A garbage message on the port must be nothing at all, not an exception in the
  // main process's message handler.
  it('ignores anything that is not a message', async () => {
    const { channel, far } = hostileChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));

    for (const junk of [null, 42, 'x', {}, { type: 'nonsense' }, { type: 'unsupported-api', api: 42 }]) far.post(junk);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(bridge.isClosed()).toBe(false);
    await bridge.shutdown();
  });
});

describe('the main thread is shared out', () => {
  // Measured in Electron: `storage.set` in a loop froze the main thread for 17 seconds,
  // because each call does its file work synchronously and nothing else got a turn.
  it('gives the event loop a turn while working through a burst of host calls', async () => {
    const { channel, far, received } = hostileChannel();
    let working = 0;
    const slowBackend: ExtensionStorageBackend = {
      ...memoryStorage(),
      async set() {
        const until = Date.now() + HOST_CALL_SLICE_MS;
        while (Date.now() < until) working += 1;
      },
    };
    const bridge = bridgeFor('mine', channel, contextFor('mine', ['storage:local'], { storageBackend: slowBackend }));

    let turns = 0;
    const tick = setInterval(() => (turns += 1), 0);
    for (let i = 0; i < 12; i += 1) {
      far.post({ type: 'host-call', requestId: `hc-${i}`, extensionId: 'mine', method: 'storage.set', args: ['k', i] });
    }
    await replyTo(received, 'hc-11');
    clearInterval(tick);

    expect(working).toBeGreaterThan(0);
    expect(turns).toBeGreaterThan(2);
    await bridge.shutdown();
  });

  // Order is kept: a set followed by a get in the same tick must read what it wrote.
  it('runs host calls in the order they came', async () => {
    const { channel, far, received } = hostileChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', ['storage:local']));

    far.post({ type: 'host-call', requestId: 'a', extensionId: 'mine', method: 'storage.set', args: ['k', 1] });
    far.post({ type: 'host-call', requestId: 'b', extensionId: 'mine', method: 'storage.get', args: ['k'] });

    expect(await replyTo(received, 'b')).toMatchObject({ ok: true, value: 1 });
    await bridge.shutdown();
  });

  // The queue is memory in the main process, and its length is the extension's choice.
  it('refuses calls past the queue limit instead of holding them', async () => {
    const { channel, far, received } = hostileChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));
    const internals = bridge as unknown as { hostCallQueue: unknown[]; drainingHostCalls: boolean };
    internals.drainingHostCalls = true;
    internals.hostCallQueue.length = MAX_QUEUED_HOST_CALLS;

    far.post({ type: 'host-call', requestId: 'over', extensionId: 'mine', method: 'storage.get', args: ['k'] });

    expect((await replyTo(received, 'over')).error?.message).toContain('Too many calls');
    internals.hostCallQueue.length = 0;
    await bridge.shutdown();
  });

  // A flood of log lines is the cheapest way to spend main's time: each is a
  // synchronous write. Past the budget they go nowhere, and each one is capped.
  it('stops writing log lines past the budget, and caps each one', async () => {
    const { channel, far } = hostileChannel();
    const lines: string[] = [];
    setLogSink((_level, _name, message) => lines.push(message));
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));

    for (let i = 0; i < LOG_LINES_PER_WINDOW + 500; i += 1) {
      far.post({ type: 'log', extensionId: 'mine', level: 'error', message: 'x'.repeat(MAX_EXTENSION_LOG_LINE * 2) });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    setLogSink(null);

    expect(lines).toHaveLength(LOG_LINES_PER_WINDOW);
    expect(lines[0].length).toBeLessThan(MAX_EXTENSION_LOG_LINE + 40);
    await bridge.shutdown();
  });
});

describe('deactivation is bounded', () => {
  // Someone is waiting for this: the user's click, or the app trying to quit. A hook
  // that never returns must not hold them for the two minutes a real call may take.
  it('gives up on a deactivate hook that does not return', async () => {
    vi.useFakeTimers();
    const { channel } = hostileChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));

    const outcome = bridge.deactivate('mine').then(
      () => 'returned',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(DEACTIVATE_TIMEOUT_MS + 1);

    expect(await outcome).toContain('did not answer');
    vi.useRealTimers();
    await bridge.shutdown();
  });
});

/** A host whose sandboxes run the real engine, with a module per extension id. */
function hostWith(
  modules: Record<string, SandboxExtensionModule>,
  options: { ui?: ExtensionUIBackend; network?: ExtensionNetworkBackend } = {}
) {
  const registry = fakeRegistry();
  const storage = memoryStorage();
  const farEnds = new Map<string, ExtensionChannel>();
  const createChannel = vi.fn((target: SandboxTarget) => {
    const pair = createInProcessChannelPair();
    farEnds.set(target.extensionId, pair.sandbox);
    startExtensionSandbox(pair.sandbox, () => modules[target.extensionId]);
    return pair.host;
  });
  const host = new ExtensionHost({
    registry,
    eventBus: createEventBus(),
    storageBackend: storage,
    settingsBackend: memorySettings(),
    uiBackend: options.ui,
    networkBackend: options.network,
    extensionStoragePath: join(workDir, 'storage'),
    createChannel,
  });
  return { host, registry, storage, createChannel, farEnds };
}

describe('one sandbox per extension', () => {
  // The design decision itself. Measured in Electron: a Worker out of memory crashes
  // its whole renderer, and two Workers of one origin read each other's storage.
  it('starts a sandbox for each extension', async () => {
    const { host, createChannel } = hostWith({ a: { activate() {} }, b: { activate() {} } });

    await host.activate(extension('a'), []);
    await host.activate(extension('b'), []);

    expect(createChannel).toHaveBeenCalledTimes(2);
    expect(createChannel.mock.calls.map(([target]) => target.extensionId)).toEqual(['a', 'b']);
    await host.dispose();
  });

  // No window for code that has nothing to run: a panel-only extension costs nothing.
  it('starts none for a panel-only extension', async () => {
    const { host, createChannel } = hostWith({});
    const panelOnly: LoadedExtension = { manifest: manifestFor('panel'), path: join(workDir, 'panel') };

    await host.activate(panelOnly, []);

    expect(createChannel).not.toHaveBeenCalled();
    expect(host.isActive('panel')).toBe(true);
    await host.dispose();
  });

  // Confined code has no other way to learn where the user's home directory is, so
  // no real path may cross: not in the entry point, and not in `storagePath`.
  it('sends no absolute path into the sandbox', async () => {
    let context: ExtensionContext | undefined;
    let loaded = '';
    const registry = fakeRegistry();
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => {
        const pair = createInProcessChannelPair();
        startExtensionSandbox(pair.sandbox, (entry) => {
          loaded = entry;
          return {
            activate(ctx) {
              context = ctx;
            },
          };
        });
        return pair.host;
      },
    });

    await host.activate(extension('a'), []);

    expect(loaded).toBe('dist/index.js');
    expect(context?.storagePath).toBe('/extension-storage/a');
    await host.dispose();
  });

  // The factory is told the real paths: they are what the transport serves from.
  it('tells the channel factory which extension, with its real paths', async () => {
    const { host, createChannel } = hostWith({ a: { activate() {} } });
    const loaded = extension('a');

    await host.activate(loaded, []);

    expect(createChannel).toHaveBeenCalledWith({
      extensionId: 'a',
      rootDir: loaded.path,
      entryPoint: loaded.entryPoint,
    });
    await host.dispose();
  });

  // The promise of the design: a crash takes down one extension. If this fails, every
  // extension stops whenever any one misbehaves.
  it('stands down only the extension whose sandbox died', async () => {
    const worker = {
      id: 'w',
      name: 'w',
      shouldProcess: async () => true,
      process: async () => ({ success: true }),
    };
    const { host, farEnds, registry } = hostWith({
      a: { activate: (ctx) => ctx.registerWorkflow(worker) },
      b: { activate: (ctx) => ctx.registerWorkflow(worker) },
    });
    await host.activate(extension('a'), ['email:read']);
    await host.activate(extension('b'), ['email:read']);

    farEnds.get('a')?.close();

    expect(host.isActive('a')).toBe(false);
    expect(host.isActive('b')).toBe(true);
    expect(host.getAllWorkflowAdapters().map((adapter) => adapter.id)).toEqual(['b.w']);
    expect(registry.infos.get('a')?.state).toBe(ExtensionState.ERROR);
    expect(registry.infos.get('b')?.state).toBe(ExtensionState.ACTIVE);
    await host.dispose();
  });

  // The other extension's mail keeps being processed after the crash.
  it('keeps processing mail through the survivors', async () => {
    const { host, farEnds } = hostWith({
      a: { activate: (ctx) => ctx.registerWorkflow({ id: 'w', name: 'w', shouldProcess: async () => true, process: async () => ({ success: true, labelsToAdd: ['a'] }) }) },
      b: { activate: (ctx) => ctx.registerWorkflow({ id: 'w', name: 'w', shouldProcess: async () => true, process: async () => ({ success: true, labelsToAdd: ['b'] }) }) },
    });
    await host.activate(extension('a'), ['email:read']);
    await host.activate(extension('b'), ['email:read']);

    farEnds.get('a')?.close();
    const results = await host.processEmail(emailFixture(), { previousResults: new Map() } as WorkflowContext);

    expect(Array.from(results.keys())).toEqual(['b.w']);
    await host.dispose();
  });

  // The reason is what the user reads: why it stopped, not just that it did.
  it('records and reports why a sandbox stopped', async () => {
    const reportProblem = vi.fn();
    const pair = createInProcessChannelPair();
    let close: ((reason?: string) => void) | undefined;
    const registry = fakeRegistry();
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      uiBackend: { notify: vi.fn(), dismiss: vi.fn(), reportProblem },
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => {
        startExtensionSandbox(pair.sandbox, () => ({ activate() {} }));
        return {
          ...pair.host,
          post: (message: unknown) => pair.host.post(message),
          onMessage: (handler: (message: unknown) => void) => pair.host.onMessage(handler),
          onClose: (handler: (reason?: string) => void) => {
            close = handler;
          },
          close: () => pair.host.close(),
        };
      },
    });
    await host.activate(extension('a'), []);

    close?.('This extension stopped responding and was stopped.');

    expect(registry.infos.get('a')?.error).toBe('This extension stopped responding and was stopped.');
    expect(registry.infos.get('a')?.state).toBe(ExtensionState.ERROR);
    expect(reportProblem).toHaveBeenCalledWith('a', {
      id: 'extension-problem',
      title: 'a name has a problem',
      body: 'This extension stopped responding and was stopped.',
    });
    await host.dispose();
  });

  // The card is in the app's voice, with no `ui:notify` behind it. If an extension's
  // own error text reached it, failing on purpose would put any sentence on screen:
  // "Your session expired, sign in at evil.example".
  it('keeps text from the extension off the card, and in Settings', async () => {
    const reportProblem = vi.fn();
    const { host, registry } = hostWith(
      {
        a: {
          activate() {
            throw new Error('Your session expired, sign in at evil.example');
          },
        },
      },
      { ui: { notify: vi.fn(), dismiss: vi.fn(), reportProblem } }
    );

    await expect(host.activate(extension('a'), [])).rejects.toThrow('session expired');

    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(reportProblem.mock.calls[0][1].body).toBe(EXTENSION_FAILED_TO_START);
    expect(registry.infos.get('a')?.error).toContain('session expired');
  });

  // The other way to the same card: a name made up to be read as a message.
  it('ignores a reported Node API that is not one', async () => {
    const reportProblem = vi.fn();
    const { host, registry, farEnds } = hostWith(
      { a: { activate() {} } },
      { ui: { notify: vi.fn(), dismiss: vi.fn(), reportProblem } }
    );
    await host.activate(extension('a'), []);
    const far = farEnds.get('a') as ExtensionChannel;

    far.post({ type: 'unsupported-api', extensionId: 'a', api: 'fs", sign in at evil.example "' });
    far.post({ type: 'unsupported-api', extensionId: 'a', api: 42 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(reportProblem).not.toHaveBeenCalled();
    expect(registry.infos.get('a')?.error).toBeUndefined();
    await host.dispose();
  });

  // A workflow failing on every message would otherwise bring back a card the reader
  // dismissed, with every message. Once per problem, until it next starts.
  it('reports the same problem once until the extension starts again', async () => {
    const reportProblem = vi.fn();
    const loaded = extension('a');
    const { host, farEnds } = hostWith(
      { a: { activate() {} } },
      { ui: { notify: vi.fn(), dismiss: vi.fn(), reportProblem } }
    );
    await host.activate(loaded, []);
    const far = farEnds.get('a') as ExtensionChannel;

    far.post({ type: 'unsupported-api', extensionId: 'a', api: 'fs' });
    far.post({ type: 'unsupported-api', extensionId: 'a', api: 'fs' });
    await vi.waitFor(() => expect(reportProblem).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reportProblem).toHaveBeenCalledTimes(1);

    // A different problem is news.
    far.post({ type: 'unsupported-api', extensionId: 'a', api: 'os' });
    await vi.waitFor(() => expect(reportProblem).toHaveBeenCalledTimes(2));

    await host.deactivate('a');
    await host.activate(loaded, []);
    farEnds.get('a')?.post({ type: 'unsupported-api', extensionId: 'a', api: 'fs' });
    await vi.waitFor(() => expect(reportProblem).toHaveBeenCalledTimes(3));
    await host.dispose();
  });

  // Today's restart behaviour, kept: a stopped extension stays down until something
  // asks for it again, and then gets a new sandbox.
  it('starts a new sandbox when a stopped extension is asked for again', async () => {
    const loaded = extension('a');
    const { host, farEnds, createChannel } = hostWith({ a: { activate() {} } });
    await host.activate(loaded, []);

    farEnds.get('a')?.close();
    expect(host.isActive('a')).toBe(false);
    await host.activate(loaded, []);

    expect(host.isActive('a')).toBe(true);
    expect(createChannel).toHaveBeenCalledTimes(2);
    await host.dispose();
  });

  // A sandbox nobody will use again is a renderer process and its memory, so
  // switching an extension off has to free it, and doing so is not a failure.
  it('closes the sandbox on deactivate, without calling it a failure', async () => {
    const reportProblem = vi.fn();
    const { host, farEnds, registry } = hostWith(
      { a: { activate() {} } },
      { ui: { notify: vi.fn(), dismiss: vi.fn(), reportProblem } }
    );
    await host.activate(extension('a'), []);
    const closed = vi.fn();
    farEnds.get('a')?.onClose(closed);

    await host.deactivate('a');

    expect(closed).toHaveBeenCalled();
    expect(registry.infos.get('a')?.state).toBe(ExtensionState.DEACTIVATED);
    expect(reportProblem).not.toHaveBeenCalled();
  });

  // A failed activation leaves a process running nothing, unless it is closed too.
  it('closes the sandbox of an activation that failed', async () => {
    const { host, farEnds } = hostWith({
      a: {
        activate() {
          throw new Error('bad init');
        },
      },
    });
    const pending = host.activate(extension('a'), []);
    await expect(pending).rejects.toThrow('bad init');

    expect(farEnds.get('a')).toBeDefined();
    const closed = vi.fn();
    farEnds.get('a')?.onClose(closed);
    expect(closed).toHaveBeenCalled();
  });

  // How a host refuses to run extension code at all, as on Linux with no OS sandbox.
  // The reason has to reach the user, and nothing may be left half-active.
  it('reports a channel factory that refuses, and leaves nothing active', async () => {
    const reportProblem = vi.fn();
    const registry = fakeRegistry();
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      uiBackend: { notify: vi.fn(), dismiss: vi.fn(), reportProblem },
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => Promise.reject(new Error('Extensions are off on this computer')),
    });

    await expect(host.activate(extension('a'), [])).rejects.toThrow('Extensions are off');

    expect(host.isActive('a')).toBe(false);
    expect(registry.infos.get('a')?.state).toBe(ExtensionState.ERROR);
    expect(registry.infos.get('a')?.error).toBe('Extensions are off on this computer');
    expect(reportProblem).toHaveBeenCalledWith('a', expect.objectContaining({ body: 'Extensions are off on this computer' }));
  });

  // One card that cannot be drawn must not throw out of a crash handler.
  it('survives a UI backend that throws while reporting', async () => {
    const { host, farEnds } = hostWith(
      { a: { activate() {} } },
      {
        ui: {
          notify: vi.fn(),
          dismiss: vi.fn(),
          reportProblem: () => {
            throw new Error('no window');
          },
        },
      }
    );
    await host.activate(extension('a'), []);

    expect(() => farEnds.get('a')?.close()).not.toThrow();
    await host.dispose();
  });

  // Starting the window waits on this, and the window should not wait on a hang.
  it('does not hold up activateAll for an extension that never finishes', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry();
    const hung = extension('hung');
    const quick = extension('quick');
    (registry as unknown as { filter: () => unknown[] }).filter = () => [
      { id: 'hung', grantedPermissions: [] },
      { id: 'quick', grantedPermissions: [] },
    ];
    (registry as unknown as { getLoaded: (id: string) => unknown }).getLoaded = (id) => (id === 'hung' ? hung : quick);
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: (target) => {
        const pair = createInProcessChannelPair();
        startExtensionSandbox(pair.sandbox, () => ({
          activate: () => (target.extensionId === 'hung' ? new Promise<void>(() => undefined) : undefined),
        }));
        return pair.host;
      },
    });

    let finished = false;
    const all = host.activateAll().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(ACTIVATE_ALL_WAIT_MS - 1);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await all;

    expect(finished).toBe(true);
    expect(registry.infos.get('quick')?.state).toBe(ExtensionState.ACTIVE);
    expect(registry.infos.get('hung')?.state).toBe(ExtensionState.ACTIVATING);
    vi.useRealTimers();
  });

  // One that fails must not stop the next one starting.
  it('activates the rest when one fails', async () => {
    const registry = fakeRegistry();
    const bad = extension('bad');
    const good = extension('good');
    (registry as unknown as { filter: () => unknown[] }).filter = () => [
      { id: 'bad', grantedPermissions: [] },
      { id: 'good', grantedPermissions: [] },
      { id: 'gone', grantedPermissions: [] },
    ];
    (registry as unknown as { getLoaded: (id: string) => unknown }).getLoaded = (id) =>
      id === 'bad' ? bad : id === 'good' ? good : undefined;
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: (target) => {
        const pair = createInProcessChannelPair();
        startExtensionSandbox(pair.sandbox, () => ({
          activate() {
            if (target.extensionId === 'bad') throw new Error('nope');
          },
        }));
        return pair.host;
      },
    });

    await host.activateAll();

    expect(host.isActive('good')).toBe(true);
    expect(host.isActive('bad')).toBe(false);
    await host.dispose();
  });
});

describe('an extension using Node', () => {
  // The upgrade path: a published extension that requires a Node module at load. The
  // user has to be told what is unsupported, in those words, where they will see it.
  it('fails activation with the sentence naming the module, shown to the user', async () => {
    const reportProblem = vi.fn();
    const { host, registry } = hostWith(
      {
        old: {
          activate() {
            throw new UnsupportedNodeApiError('fs');
          },
        },
      },
      { ui: { notify: vi.fn(), dismiss: vi.fn(), reportProblem } }
    );

    await expect(host.activate(extension('old'), [])).rejects.toThrow('"fs"');

    expect(registry.infos.get('old')?.state).toBe(ExtensionState.ERROR);
    expect(registry.infos.get('old')?.error).toContain('"fs"');
    expect(reportProblem).toHaveBeenCalledWith('old', expect.objectContaining({ body: expect.stringContaining('"fs"') }));
  });

  // Reading `process` where there is none throws a ReferenceError, and that alone
  // tells a user nothing.
  it('turns a missing global into the same sentence', async () => {
    const { host, registry } = hostWith({
      old: {
        activate() {
          throw new ReferenceError('process is not defined');
        },
      },
    });

    await expect(host.activate(extension('old'), [])).rejects.toThrow('"process"');
    expect(registry.infos.get('old')?.error).toContain('"process"');
  });

  // Node use that only shows up when a message is processed, after activation went
  // fine. Without this it fails on every message with nothing on screen.
  it('tells the user when a workflow fails for it, and stays active', async () => {
    const reportProblem = vi.fn();
    const { host, registry } = hostWith(
      {
        old: {
          activate: (ctx) =>
            ctx.registerWorkflow({
              id: 'w',
              name: 'w',
              shouldProcess: async () => true,
              process: async () => {
                throw new ReferenceError('Buffer is not defined');
              },
            }),
        },
      },
      { ui: { notify: vi.fn(), dismiss: vi.fn(), reportProblem } }
    );
    await host.activate(extension('old'), ['email:read']);

    const results = await host.processEmail(emailFixture(), { previousResults: new Map() } as WorkflowContext);

    expect(results.get('old.w')?.success).toBe(false);
    expect(results.get('old.w')?.error?.message).toContain('"Buffer"');
    expect(host.isActive('old')).toBe(true);
    expect(registry.infos.get('old')?.error).toContain('"Buffer"');
    expect(reportProblem).toHaveBeenCalled();
    await host.dispose();
  });

  // Plenty of bundled code tries an optional module inside a try/catch. An extension
  // working fine that way must not be reported as broken.
  it('says nothing about Node use the extension handles itself', async () => {
    const reportProblem = vi.fn();
    const { host, registry } = hostWith(
      {
        fine: {
          activate() {
            try {
              throw new UnsupportedNodeApiError('tty');
            } catch {
              // An optional dependency, as a library would do it.
            }
          },
        },
      },
      { ui: { notify: vi.fn(), dismiss: vi.fn(), reportProblem } }
    );

    await host.activate(extension('fine'), []);

    expect(registry.infos.get('fine')?.state).toBe(ExtensionState.ACTIVE);
    expect(registry.infos.get('fine')?.error).toBeUndefined();
    expect(reportProblem).not.toHaveBeenCalled();
    await host.dispose();
  });

  // An error thrown from a timer has no call to fail. The Worker's global error
  // handler is the only thing that sees it.
  it('reports an uncaught error through reportUncaught', async () => {
    const pair = createInProcessChannelPair();
    const received: { type: string; api?: string; level?: string; message?: string }[] = [];
    pair.host.onMessage((message) => received.push(message as (typeof received)[number]));
    const sandbox = startExtensionSandbox(pair.sandbox, () => ({ activate() {} }));

    sandbox.reportUncaught('Uncaught error', new ReferenceError('process is not defined'));
    sandbox.reportUncaught('Unhandled rejection', 'just a string');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(received.find((m) => m.type === 'unsupported-api')?.api).toBe('process');
    expect(received.filter((m) => m.type === 'log').map((m) => m.message)).toEqual([
      expect.stringContaining('Uncaught error'),
      expect.stringContaining('just a string'),
    ]);
  });

  // The promise made to the user: nothing they approved or stored goes away because
  // an extension can no longer run. Survives the next launch, and the fixed version
  // finds its data where it left it.
  it('keeps approvals and stored data through a failed activation and a restart', async () => {
    const base = join(workDir, 'data');
    const source = join(workDir, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'index.js'), `exports.activate = () => {};`);
    writeFileSync(
      join(source, 'sarvinbox-extension.json'),
      JSON.stringify({ ...manifestFor('old', ['storage:local']) })
    );

    const loaderFor = (target: SandboxTarget) => {
      const pair = createInProcessChannelPair();
      startExtensionSandbox(pair.sandbox, () => ({
        activate() {
          throw new UnsupportedNodeApiError('fs');
        },
      }));
      void target;
      return pair.host;
    };
    const first = new ExtensionManager({ extensionsBaseDir: base, createChannel: loaderFor });
    await first.initialize();
    await expect(first.installExtension(source)).rejects.toThrow('"fs"');

    const stateFile = join(base, 'extensions-state.json');
    const storageFile = join(base, 'extension-storage', 'old', 'storage.json');
    mkdirSync(join(base, 'extension-storage', 'old'), { recursive: true });
    writeFileSync(storageFile, JSON.stringify({ kept: 'USER DATA' }));
    const stateBefore = readFileSync(stateFile, 'utf8');
    await first.shutdown();

    const second = new ExtensionManager({ extensionsBaseDir: base, createChannel: loaderFor });
    await second.initialize();

    expect(readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    expect(readFileSync(storageFile, 'utf8')).toBe(JSON.stringify({ kept: 'USER DATA' }));
    expect(second.getRegistry().get('old')).toMatchObject({
      enabled: true,
      grantedPermissions: ['storage:local'],
    });
    expect(second.getExtensionInfo('old')?.error).toContain('"fs"');
    await second.shutdown();
  });
});

describe('context.network', () => {
  const okResult = { ok: true, status: 200, statusText: 'OK', url: 'https://x.example/', headers: {}, body: new TextEncoder().encode('{"a":1}') };

  // The confinement only means anything if the way out is really gated. Main has to
  // refuse by itself: a sandbox can skip the check on its own side.
  it('refuses in main without network:fetch, whatever the sandbox says', async () => {
    const { channel, far, received } = hostileChannel();
    const fetch = vi.fn(async () => okResult);
    const bridge = bridgeFor('mine', channel, contextFor('mine', [], { networkBackend: { fetch } }));

    far.post({ type: 'host-call', requestId: 'hc', extensionId: 'mine', method: 'network.fetch', args: ['https://x.example/'] });

    expect((await replyTo(received, 'hc')).error?.message).toContain("requires 'network:fetch'");
    expect(fetch).not.toHaveBeenCalled();
    await bridge.shutdown();
  });

  // The local check too: the error should point at the author's own line.
  it('refuses in the sandbox without network:fetch', async () => {
    let context: ExtensionContext | undefined;
    const fetch = vi.fn(async () => okResult);
    const { host } = hostWith(
      {
        a: {
          activate(ctx) {
            context = ctx;
          },
        },
      },
      { network: { fetch } }
    );
    await host.activate(extension('a'), []);

    await expect(context?.network.fetch('https://x.example/')).rejects.toThrow("requires 'network:fetch'");
    expect(fetch).not.toHaveBeenCalled();
    await host.dispose();
  });

  // The permission granted, the request reaches the backend with the extension's id,
  // and the answer reads the way `fetch` reads.
  it('fetches through the backend with the permission, end to end', async () => {
    let context: ExtensionContext | undefined;
    const fetch = vi.fn(async () => okResult);
    const { host } = hostWith(
      {
        a: {
          activate(ctx) {
            context = ctx;
          },
        },
      },
      { network: { fetch } }
    );
    await host.activate(extension('a'), ['network:fetch']);

    const response = await context?.network.fetch('https://x.example/', { method: 'POST', body: 'hi' });

    expect(fetch).toHaveBeenCalledWith('a', 'https://x.example/', { method: 'POST', body: 'hi' });
    expect(response?.status).toBe(200);
    expect(response?.json()).toEqual({ a: 1 });
    expect(response?.text()).toBe('{"a":1}');
    expect(response?.bytes()).toEqual(okResult.body);
    await host.dispose();
  });

  // A host with no network backend (the CLI) must say so, not hang or claim success.
  it('says so when the host has no network', async () => {
    const context = contextFor('mine', ['network:fetch']);
    await expect(context.network.fetch('https://x.example/')).rejects.toThrow('not available');
  });

  // These arrive from extension code unchecked.
  it.each([
    ['', {}, 'a URL is required'],
    [42, {}, 'a URL is required'],
    ['https://x.example/', 'nope', 'options must be an object'],
    ['https://x.example/', { method: 'TRACE' }, 'unsupported method'],
    ['https://x.example/', { headers: ['a'] }, 'headers must be an object'],
    ['https://x.example/', { headers: { a: 1 } }, 'headers must be an object'],
    ['https://x.example/', { body: {} }, 'body must be a string'],
    ['https://x.example/', { timeoutMs: -1 }, 'timeoutMs must be a positive number'],
    ['https://x.example/', { timeoutMs: 'soon' }, 'timeoutMs must be a positive number'],
  ])('refuses a malformed request (%s, %j)', async (url, options, message) => {
    const fetch = vi.fn(async () => okResult);
    const context = contextFor('mine', ['network:fetch'], { networkBackend: { fetch } });

    await expect(context.fetchForExtension(url, options)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  // The optional parts are optional.
  it('passes a well-formed request through untouched', async () => {
    const fetch = vi.fn(async () => okResult);
    const context = contextFor('mine', ['network:fetch'], { networkBackend: { fetch } });
    const body = new Uint8Array([1, 2]);

    await context.network.fetch('https://x.example/', { method: 'PUT', headers: { a: 'b' }, body, timeoutMs: 5 });
    await context.network.fetch('https://x.example/');

    expect(fetch).toHaveBeenNthCalledWith(1, 'mine', 'https://x.example/', { method: 'PUT', headers: { a: 'b' }, body, timeoutMs: 5 });
    expect(fetch).toHaveBeenNthCalledWith(2, 'mine', 'https://x.example/', {});
  });
});

describe('the event bus', () => {
  // `email:synced` carries the whole message. If subscribing needs no permission, an
  // extension granted nothing reads every mail that arrives, and `email:read` means
  // nothing. With `network:fetch` alone it could then send it all away.
  it('refuses a subscription without email:read, in main', async () => {
    const { channel, far, received } = hostileChannel();
    const eventBus = createEventBus();
    const bridge = bridgeFor('mine', channel, contextFor('mine', ['network:fetch'], { eventBus }));

    far.post({ type: 'host-call', requestId: 'on', extensionId: 'mine', method: 'events.subscribe', args: ['email:synced', 's1', false] });
    far.post({ type: 'host-call', requestId: 'once', extensionId: 'mine', method: 'events.subscribe', args: ['email:synced', 's2', true] });

    expect((await replyTo(received, 'on')).error?.message).toContain("requires 'email:read'");
    expect((await replyTo(received, 'once')).error?.message).toContain("requires 'email:read'");
    eventBus.emit({ type: 'email:synced', email: emailFixture(), folder: 'INBOX', isNew: true, timestamp: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(received.some((m) => m.type === 'invoke')).toBe(false);
    await bridge.shutdown();
  });

  // The local check: the mistake fails at the author's own line.
  it('refuses a subscription without email:read, in the sandbox', async () => {
    let context: ExtensionContext | undefined;
    const { host } = hostWith({
      a: {
        activate(ctx) {
          context = ctx;
        },
      },
    });
    await host.activate(extension('a'), []);

    expect(() => context?.events.on('email:synced', () => undefined)).toThrow("requires 'email:read'");
    expect(() => context?.events.once('sync:completed', () => undefined)).toThrow("requires 'email:read'");
    await host.dispose();
  });

  // Nothing published used it, and it cost far more than it was worth: any extension with
  // no permissions could keep 1,000 events of any size in main's history and write them to
  // the event log, and a forged `email:synced` raised OS notifications in its own words.
  it('gives an extension no way to emit, in main or in the sandbox', async () => {
    const { channel, far, received } = hostileChannel();
    const eventBus = createEventBus();
    const heard = vi.fn();
    eventBus.on('email:synced', heard);
    const context = contextFor('mine', ['email:read'], { eventBus });
    const bridge = bridgeFor('mine', channel, context);

    far.post({ type: 'host-call', requestId: 'hc', extensionId: 'mine', method: 'events.emit', args: [{ type: 'email:synced', timestamp: 1 }] });

    expect((await replyTo(received, 'hc')).error?.message).toContain("Unknown host call 'events.emit'");
    expect(heard).not.toHaveBeenCalled();
    expect('emit' in context.events).toBe(false);
    await bridge.shutdown();

    let sandboxContext: ExtensionContext | undefined;
    const { host } = hostWith({
      a: {
        activate(ctx) {
          sandboxContext = ctx;
        },
      },
    });
    await host.activate(extension('a'), []);
    expect('emit' in (sandboxContext as ExtensionContext).events).toBe(false);
    await host.dispose();
  });

  // Re-arming a `once` after each sync is ordinary, and days of it must not add up to
  // the limit on subscriptions, or a healthy extension gets stopped after a long uptime.
  it('forgets a once subscription after it fires, and any after it is ended', () => {
    const eventBus = createEventBus();
    const context = contextFor('mine', ['email:read'], { eventBus });

    context.events.once('sync:completed', () => undefined);
    const off = context.events.on('sync:started', () => undefined);
    expect(context.subscriptions).toHaveLength(2);

    eventBus.emit({ type: 'sync:completed', stats: {}, timestamp: 1 } as never);
    expect(context.subscriptions).toHaveLength(1);
    off();
    expect(context.subscriptions).toHaveLength(0);
  });

  // dispose() still has to detach what is left.
  it('still detaches what is left on dispose', () => {
    const eventBus = createEventBus();
    const heard = vi.fn();
    const context = contextFor('mine', ['email:read'], { eventBus });
    context.events.on('sync:started', heard);
    context.events.once('sync:completed', heard);

    context.dispose();
    eventBus.emit({ type: 'sync:started', folders: [], fullSync: false, timestamp: 1 });
    eventBus.emit({ type: 'sync:completed', stats: {}, timestamp: 1 } as never);

    expect(heard).not.toHaveBeenCalled();
  });
});

/** The far end of a bridge whose channel records being killed. */
function killableChannel() {
  const { channel, far, received } = hostileChannel();
  const killed: string[] = [];
  const closeHandlers: ((reason?: string, details?: { transient: boolean }) => void)[] = [];
  const wrapped: ExtensionChannel = {
    post: (message) => channel.post(message),
    onMessage: (handler) => channel.onMessage(handler),
    onClose: (handler) => {
      closeHandlers.push(handler);
      channel.onClose(handler);
    },
    close: () => channel.close(),
    kill: (reason) => {
      killed.push(reason);
    },
  };
  return { channel: wrapped, far, received, killed };
}

describe('what an extension may leave behind in main', () => {
  const workflow = (id: string, extra: Record<string, unknown> = {}) => ({
    fullId: `mine.${id}`,
    id,
    name: id,
    ...extra,
  });
  const register = (far: ExtensionChannel, descriptor: unknown, requestId = 'hc') =>
    far.post({ type: 'host-call', requestId, extensionId: 'mine', method: 'workflow.register', args: [descriptor] });

  // Measured: registrations carrying 5 MB ids ran main out of memory in 5 seconds, needing
  // only email:read. These are kept for as long as the extension runs, so the size of each
  // is the size of the leak.
  it.each([
    ['a long id', workflow('x'.repeat(MAX_IDENTIFIER_LENGTH + 1))],
    ['a long name', workflow('w', { name: 'n'.repeat(MAX_IDENTIFIER_LENGTH + 1) })],
    ['a long description', workflow('w', { description: 'd'.repeat(MAX_DESCRIPTION_LENGTH + 1) })],
    ['a description that is not text', workflow('w', { description: {} })],
    ['an empty id', workflow('')],
    ['a full id that does not match', { fullId: 'mine.other', id: 'w', name: 'w' }],
  ])('stops an extension registering a workflow with %s', async (_name, descriptor) => {
    const { channel, far, killed } = killableChannel();
    const onWorkflowRegistered = vi.fn();
    const bridge = bridgeFor('mine', channel, contextFor('mine', ['email:read']), { onWorkflowRegistered });

    register(far, descriptor);

    await vi.waitFor(() => expect(killed).toHaveLength(1));
    expect(killed[0]).toContain('far more than extensions may keep');
    expect(onWorkflowRegistered).not.toHaveBeenCalled();
    expect(bridge.isClosed()).toBe(true);
  });

  // The count, for the same reason: many small ones add up as well as one large one.
  it('stops an extension registering too many workflows', async () => {
    const { channel, far, killed } = killableChannel();
    const onWorkflowRegistered = vi.fn();
    bridgeFor('mine', channel, contextFor('mine', ['email:read']), { onWorkflowRegistered });

    for (let i = 0; i <= MAX_WORKFLOWS_PER_EXTENSION; i += 1) register(far, workflow(`w${i}`), `hc${i}`);

    await vi.waitFor(() => expect(killed).toHaveLength(1));
    expect(onWorkflowRegistered).toHaveBeenCalledTimes(MAX_WORKFLOWS_PER_EXTENSION);
  });

  // The limit is on what is held at once: dropping one makes room.
  it('lets an extension replace a workflow it dropped', async () => {
    const { channel, far, received, killed } = killableChannel();
    bridgeFor('mine', channel, contextFor('mine', ['email:read']));

    for (let i = 0; i < MAX_WORKFLOWS_PER_EXTENSION; i += 1) register(far, workflow(`w${i}`), `a${i}`);
    far.post({ type: 'host-call', requestId: 'drop', extensionId: 'mine', method: 'workflow.unregister', args: ['mine.w0'] });
    register(far, workflow('fresh'), 'again');

    expect(await replyTo(received, 'again')).toMatchObject({ ok: true });
    expect(killed).toHaveLength(0);
  });

  // Registering and dropping in a loop holds nothing at once, but each writes a log line.
  it('stops one that registers and drops in a loop', async () => {
    const { channel, far, killed } = killableChannel();
    bridgeFor('mine', channel, contextFor('mine', ['email:read']));

    for (let i = 0; i <= MAX_WORKFLOW_REGISTRATIONS; i += 1) {
      register(far, workflow('w'), `r${i}`);
      far.post({ type: 'host-call', requestId: `d${i}`, extensionId: 'mine', method: 'workflow.unregister', args: ['mine.w'] });
    }

    await vi.waitFor(() => expect(killed).toHaveLength(1));
  });

  // The other way the same strings get in: the first report, at activation.
  it.each([
    ['too many workflows', Array.from({ length: MAX_WORKFLOWS_PER_EXTENSION + 1 }, (_v, i) => workflow(`w${i}`)), []],
    ['a workflow over the limits', [workflow('x'.repeat(MAX_IDENTIFIER_LENGTH + 1))], []],
    ['too many exports', [], Array.from({ length: MAX_EXPORTS_PER_EXTENSION + 1 }, (_v, i) => `e${i}`)],
    ['an export name over the limits', [], ['x'.repeat(MAX_IDENTIFIER_LENGTH + 1)]],
    ['exports that are not a list', [], 5],
    ['workflows that are not a list', 5, []],
  ])('refuses an activation reporting %s', async (_name, workflows, exportNames) => {
    const { channel, far, killed } = killableChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));

    const activation = bridge.activate({
      extensionId: 'mine',
      manifest: manifestFor('mine'),
      entryPoint: 'index.js',
      storagePath: '/x',
      grantedPermissions: [],
      state: { aiAvailable: false, settings: {} },
    });
    far.post({ type: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    far.post({ type: 'activated', requestId: 'act-1', extensionId: 'mine', workflows, exportNames });

    await expect(activation).rejects.toThrow('far more than extensions may keep');
    expect(killed).toHaveLength(1);
  });

  it('accepts an activation within the limits', async () => {
    const { channel, far, killed } = killableChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', ['email:read']));

    const activation = bridge.activate({
      extensionId: 'mine',
      manifest: manifestFor('mine'),
      entryPoint: 'index.js',
      storagePath: '/x',
      grantedPermissions: [],
      state: { aiAvailable: false, settings: {} },
    });
    far.post({ type: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    far.post({ type: 'activated', requestId: 'act-1', extensionId: 'mine', workflows: [workflow('w')], exportNames: ['run'] });

    await expect(activation).resolves.toMatchObject({ exportNames: ['run'] });
    expect(killed).toHaveLength(0);
    await bridge.shutdown();
  });

  // Each subscription is a listener on the shared bus, called for every event.
  it('stops one with too many subscriptions, or a subscription id over the limit', async () => {
    const { channel, far, killed } = killableChannel();
    const eventBus = createEventBus();
    bridgeFor('mine', channel, contextFor('mine', ['email:read'], { eventBus }));

    for (let i = 0; i <= MAX_SUBSCRIPTIONS_PER_EXTENSION; i += 1) {
      far.post({ type: 'host-call', requestId: `s${i}`, extensionId: 'mine', method: 'events.subscribe', args: ['sync:started', `sub${i}`, false] });
    }
    await vi.waitFor(() => expect(killed).toHaveLength(1));

    const long = killableChannel();
    bridgeFor('mine', long.channel, contextFor('mine', ['email:read'], { eventBus: createEventBus() }));
    long.far.post({ type: 'host-call', requestId: 'l', extensionId: 'mine', method: 'events.subscribe', args: ['sync:started', 'x'.repeat(MAX_IDENTIFIER_LENGTH + 1), false] });
    await vi.waitFor(() => expect(long.killed).toHaveLength(1));
  });

  // A label is written into the mail database's tags, for every message it lands on.
  it('refuses a label over the limit, and too many in one change', async () => {
    const { channel, far, received } = hostileChannel();
    const mailBackend = { applyLabels: vi.fn(async () => undefined) };
    bridgeFor('mine', channel, contextFor('mine', ['email:label'], { mailBackend }));

    far.post({ type: 'host-call', requestId: 'long', extensionId: 'mine', method: 'mail.applyLabels', args: ['e', { add: ['x'.repeat(MAX_LABEL_LENGTH + 1)] }] });
    far.post({ type: 'host-call', requestId: 'many', extensionId: 'mine', method: 'mail.applyLabels', args: ['e', { add: Array.from({ length: MAX_LABELS_PER_CHANGE + 1 }, (_v, i) => `l${i}`) }] });

    expect((await replyTo(received, 'long')).error?.message).toContain('at most');
    expect((await replyTo(received, 'many')).error?.message).toContain('too many labels');
    expect(mailBackend.applyLabels).not.toHaveBeenCalled();
  });
});

describe('a flood of messages', () => {
  // A loop posting at full speed spends the time of the process syncing the user's mail.
  it('stops an extension sending too many messages main did not ask for', async () => {
    const { channel, far, killed } = killableChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));

    for (let i = 0; i <= FLOOD_BASE_MESSAGES; i += 1) far.post({ type: 'noise' });

    await vi.waitFor(() => expect(killed).toHaveLength(1));
    expect(killed[0]).toContain('far too many messages');
    expect(bridge.isClosed()).toBe(true);
  });

  // Measured: posting 50 MB strings stopped main's event loop before the message count
  // ever came into it, because deserializing each one is what costs.
  it('stops one sending far too much data, whatever the count', async () => {
    const { channel, far, killed } = killableChannel();
    bridgeFor('mine', channel, contextFor('mine', []));

    const large = 'x'.repeat(MAX_MESSAGE_BYTES - 1000);
    const enough = Math.ceil(FLOOD_BYTES / large.length) + 1;
    for (let i = 0; i < enough; i += 1) far.post({ type: 'log', extensionId: 'mine', level: 'debug', message: large });

    await vi.waitFor(() => expect(killed).toHaveLength(1));
    expect(killed[0]).toContain('far too much data');
  });

  // Measured: one 300 MB string reaching JSON.stringify in main is a fatal V8 error that
  // ends the app, "Zone Allocation failed", and no try/catch sees it. Anything in main can
  // stringify what a host call was given, so it must be stopped before any handler runs,
  // however it is dressed up.
  it.each([
    ['as a host call', (huge: string) => ({ type: 'host-call', requestId: 'r1', method: 'storage.set', args: ['k', huge] })],
    ['hidden deep in a host call', (huge: string) => ({
      type: 'host-call',
      requestId: 'r1',
      method: 'storage.set',
      args: ['k', [...new Array(2000).fill({ a: 1 }), { deep: [huge] }]],
    })],
    ['as a log line', (huge: string) => ({ type: 'log', extensionId: 'mine', level: 'info', message: huge })],
    ['as a reply nobody asked for', (huge: string) => ({ type: 'invoke-reply', requestId: 'inv-1', ok: true, value: huge })],
  ])('stops a single message over the size limit, %s, before anything handles it', async (_name, build) => {
    const { channel, far, killed } = killableChannel();
    const context = contextFor('mine', ['storage:local']);
    const set = vi.spyOn(context.storage, 'set');
    bridgeFor('mine', channel, context);

    far.post(build('x'.repeat(MAX_MESSAGE_BYTES + 1)));

    await vi.waitFor(() => expect(killed).toHaveLength(1));
    expect(killed[0]).toContain('far too much data');
    expect(set).not.toHaveBeenCalled();
  });

  // A reply nobody asked for is not a reply. Counted, or forged ones would be free.
  it('counts a reply to no call as unsolicited', async () => {
    const { channel, far, killed } = killableChannel();
    bridgeFor('mine', channel, contextFor('mine', []));

    for (let i = 0; i <= FLOOD_BASE_MESSAGES; i += 1) {
      far.post({ type: 'invoke-reply', requestId: 'inv-999', ok: true, value: 1 });
    }

    await vi.waitFor(() => expect(killed).toHaveLength(1));
  });

  // Measured in Electron: the real vip-scoring was killed at mail 3,331 because replies to
  // main's own calls counted, and a reader's first sync looked like an attack. With a host
  // call for every message as well, this is the heaviest healthy extension looks like.
  it('leaves a healthy extension alone through a drain of 40,000 messages', async () => {
    const seen: string[] = [];
    let context: ExtensionContext | undefined;
    const { host, registry } = hostWith({
      busy: {
        activate(ctx) {
          context = ctx;
          ctx.registerWorkflow({
            id: 'w',
            name: 'w',
            shouldProcess: async () => true,
            process: async (email) => {
              await ctx.storage.get(email.id);
              seen.push(email.id);
              return { success: true };
            },
          });
        },
      },
    });
    await host.activate(extension('busy'), ['email:read', 'storage:local']);
    expect(context).toBeDefined();

    for (let i = 0; i < 40_000; i += 1) {
      const email = { ...emailFixture(), id: `e${i}` };
      await host.processEmail(email, { previousResults: new Map() } as WorkflowContext);
    }

    expect(seen).toHaveLength(40_000);
    expect(host.isActive('busy')).toBe(true);
    expect(registry.infos.get('busy')?.error).toBeUndefined();
    await host.dispose();
  }, 60_000);
});

describe('what the sandbox reports about itself', () => {
  // Names from the sandbox become property names on an object in main.
  it('does not let an export name swap the object prototype', async () => {
    const { channel } = hostileChannel();
    const bridge = bridgeFor('mine', channel, contextFor('mine', []));
    const exports = createRemoteExports(bridge, 'mine', ['fine', '__proto__', 42 as unknown as string]);

    expect(Object.keys(exports)).toEqual(['fine']);
    expect(Object.getPrototypeOf(exports)).toBe(Object.prototype);
    await bridge.shutdown();
  });

  // A problem an extension had while running is not a problem with it being switched
  // off, and the line in Settings is now shown in any state.
  it('forgets a problem once it is switched off', async () => {
    const { host, registry, farEnds } = hostWith({ a: { activate() {} } });
    await host.activate(extension('a'), []);
    const far = farEnds.get('a') as ExtensionChannel;
    far.post({ type: 'unsupported-api', extensionId: 'a', api: 'fs' });
    await vi.waitFor(() => expect(registry.infos.get('a')?.error).toContain('"fs"'));

    await host.deactivate('a');

    expect(registry.infos.get('a')?.error).toBeUndefined();
  });
});

/** A registry that knows about extensions, for what needs one to start them again. */
function registryWith(entries: Record<string, { loaded: LoadedExtension; enabled?: boolean; permissions?: ExtensionPermission[] }>) {
  const registry = fakeRegistry();
  const installed = (id: string) =>
    entries[id] && {
      id,
      enabled: entries[id].enabled ?? true,
      grantedPermissions: entries[id].permissions ?? [],
    };
  Object.assign(registry, {
    getLoaded: (id: string) => entries[id]?.loaded,
    get: installed,
    filter: () => Object.keys(entries).map(installed).filter((e) => e?.enabled),
  });
  return registry;
}

/** A host whose sandboxes the test can end, as a crash or a deliberate kill would. */
function restartableHost(modules: Record<string, SandboxExtensionModule>, registry: ReturnType<typeof registryWith>, ui?: ExtensionUIBackend) {
  const closes = new Map<string, (reason?: string, details?: { transient: boolean }) => void>();
  const started: string[] = [];
  const host = new ExtensionHost({
    registry,
    eventBus: createEventBus(),
    storageBackend: memoryStorage(),
    settingsBackend: memorySettings(),
    uiBackend: ui,
    extensionStoragePath: join(workDir, 'storage'),
    createChannel: (target) => {
      started.push(target.extensionId);
      const pair = createInProcessChannelPair();
      startExtensionSandbox(pair.sandbox, () => modules[target.extensionId]);
      return {
        post: (message: unknown) => pair.host.post(message),
        onMessage: (handler: (message: unknown) => void) => pair.host.onMessage(handler),
        onClose: (handler: (reason?: string, details?: { transient: boolean }) => void) => {
          closes.set(target.extensionId, handler);
        },
        close: () => pair.host.close(),
      };
    },
  });
  return { host, closes, started };
}

describe('after a sandbox dies', () => {
  const { 0: first, 1: second, 2: third } = SANDBOX_RESTART_DELAYS_MS;
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  // A crash can be anything: the OS reclaiming memory, a renderer bug. Staying off until
  // someone notices is how a reader's verification codes quietly stop appearing.
  it('starts a crashed extension again, after a pause', async () => {
    fake();
    const loaded = extension('a');
    const reportProblem = vi.fn();
    const registry = registryWith({ a: { loaded } });
    const { host, closes, started } = restartableHost({ a: { activate() {} } }, registry, { notify: vi.fn(), dismiss: vi.fn(), reportProblem });
    await host.activate(loaded, []);

    closes.get('a')?.('This extension crashed and was stopped.', { transient: true });
    expect(host.isActive('a')).toBe(false);
    expect(registry.infos.get('a')?.error).toContain('crashed');

    await vi.advanceTimersByTimeAsync(first - 1);
    expect(started).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(2);

    await vi.waitFor(() => expect(host.isActive('a')).toBe(true));
    expect(started).toEqual(['a', 'a']);
    expect(registry.infos.get('a')?.error).toBeUndefined();
    // Quietly fixed is not worth interrupting anyone for.
    expect(reportProblem).not.toHaveBeenCalled();
    vi.useRealTimers();
    await host.dispose();
  });

  // One that crashes on every start must end up visibly off, not cycling for ever.
  it('gives up after a bounded number of attempts, and only then says so', async () => {
    fake();
    const loaded = extension('a');
    const reportProblem = vi.fn();
    const registry = registryWith({ a: { loaded } });
    const { host, closes, started } = restartableHost({ a: { activate() {} } }, registry, { notify: vi.fn(), dismiss: vi.fn(), reportProblem });
    await host.activate(loaded, []);

    for (const delay of [first, second, third]) {
      closes.get('a')?.('This extension crashed and was stopped.', { transient: true });
      expect(reportProblem).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(delay + 1);
      await vi.waitFor(() => expect(host.isActive('a')).toBe(true));
    }
    closes.get('a')?.('This extension crashed and was stopped.', { transient: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(started).toHaveLength(4);
    expect(host.isActive('a')).toBe(false);
    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(reportProblem.mock.calls[0][1].body).toContain('crashed');
    vi.useRealTimers();
  });

  // Running for a long while after a crash is recovering, not looping. Otherwise three
  // crashes over a year of uptime would end the extension for the session.
  it('starts the attempts over once it has run for a long while', async () => {
    fake();
    const loaded = extension('a');
    const registry = registryWith({ a: { loaded } });
    const { host, closes, started } = restartableHost({ a: { activate() {} } }, registry);
    await host.activate(loaded, []);

    for (let i = 0; i < SANDBOX_RESTART_DELAYS_MS.length + 2; i += 1) {
      closes.get('a')?.('crashed', { transient: true });
      await vi.advanceTimersByTimeAsync(first + 1);
      await vi.waitFor(() => expect(host.isActive('a')).toBe(true));
      await vi.advanceTimersByTimeAsync(SANDBOX_RESTART_FORGIVE_MS + 1);
    }

    expect(started).toHaveLength(SANDBOX_RESTART_DELAYS_MS.length + 3);
    vi.useRealTimers();
    await host.dispose();
  });

  // A hang, a flood, a broken limit: it would only do the same again, and each retry costs
  // the reader another thirty seconds of a spinning core.
  it('does not restart something stopped on purpose', async () => {
    fake();
    const loaded = extension('a');
    const reportProblem = vi.fn();
    const registry = registryWith({ a: { loaded } });
    const { host, closes, started } = restartableHost({ a: { activate() {} } }, registry, { notify: vi.fn(), dismiss: vi.fn(), reportProblem });
    await host.activate(loaded, []);

    closes.get('a')?.('This extension stopped responding and was stopped.', { transient: false });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(started).toEqual(['a']);
    expect(reportProblem).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // A refused sandbox is a fact about this computer. It will be refused the same way.
  it('does not retry a sandbox the host refused', async () => {
    fake();
    const loaded = extension('a');
    let attempts = 0;
    const registry = registryWith({ a: { loaded } });
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => {
        attempts += 1;
        return Promise.reject(new Error('Extensions are off'));
      },
    });

    await expect(host.activate(loaded, [])).rejects.toThrow('Extensions are off');
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(attempts).toBe(1);
    vi.useRealTimers();
  });

  // Switched off while a restart was pending: it must stay off.
  it('cancels a pending restart when the extension is turned off', async () => {
    fake();
    const loaded = extension('a');
    const registry = registryWith({ a: { loaded } });
    const { host, closes, started } = restartableHost({ a: { activate() {} } }, registry);
    await host.activate(loaded, []);
    closes.get('a')?.('crashed', { transient: true });

    await host.deactivate('a');
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(started).toEqual(['a']);
    vi.useRealTimers();
  });

  it('does not restart one that was disabled in the meantime', async () => {
    fake();
    const loaded = extension('a');
    const registry = registryWith({ a: { loaded, enabled: false } });
    const { host, closes, started } = restartableHost({ a: { activate() {} } }, registry);
    await host.activate(loaded, []);

    closes.get('a')?.('crashed', { transient: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(started).toEqual(['a']);
    vi.useRealTimers();
  });

  // A restart that fails is logged, not an unhandled rejection in the main process.
  it('survives a restart that fails', async () => {
    fake();
    const loaded = extension('a');
    let fail = false;
    const registry = registryWith({ a: { loaded } });
    const { host, closes } = restartableHost(
      {
        a: {
          activate() {
            if (fail) throw new Error('no good');
          },
        },
      },
      registry
    );
    await host.activate(loaded, []);
    fail = true;

    closes.get('a')?.('crashed', { transient: true });
    await vi.advanceTimersByTimeAsync(first + 1);
    await vi.waitFor(() => expect(registry.infos.get('a')?.state).toBe(ExtensionState.ERROR));

    expect(host.isActive('a')).toBe(false);
    vi.useRealTimers();
  });

  // Took 10 seconds to turn off: 5 waiting for the hook, then 5 more of grace for a sandbox
  // already known not to answer. A reader is watching the switch.
  it('kills at once a sandbox whose deactivate hook did not answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const loaded = extension('a');
    const killed: string[] = [];
    const registry = registryWith({ a: { loaded } });
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => {
        const pair = createInProcessChannelPair();
        startExtensionSandbox(pair.sandbox, () => ({
          activate() {},
          deactivate: () => new Promise<void>(() => undefined),
        }));
        return {
          post: (message: unknown) => pair.host.post(message),
          onMessage: (handler: (message: unknown) => void) => pair.host.onMessage(handler),
          onClose: (handler: () => void) => pair.host.onClose(handler),
          close: () => pair.host.close(),
          kill: (reason: string) => {
            killed.push(reason);
          },
        };
      },
    });
    await host.activate(loaded, []);

    const off = host.deactivate('a');
    await vi.advanceTimersByTimeAsync(DEACTIVATE_TIMEOUT_MS + 1);
    await off;

    expect(killed).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('holding extension code back at launch', () => {
  // The crash-loop backstop. The window opens only after extensions start, so something
  // that takes the app down at that point locks the reader out of their mail for good.
  it('starts no code, but leaves panel-only extensions and every switch as they were', async () => {
    const withCode = extension('code');
    const panelOnly: LoadedExtension = { manifest: manifestFor('panel'), path: join(workDir, 'panel') };
    const registry = registryWith({ code: { loaded: withCode }, panel: { loaded: panelOnly } });
    const { host, started } = restartableHost({ code: { activate() {} } }, registry);

    await host.activateAll({ holdCode: true });

    expect(started).toEqual([]);
    expect(host.isActive('code')).toBe(false);
    expect(host.isActive('panel')).toBe(true);
    expect(host.getHeldBack()).toEqual(['code']);
    expect(registry.infos.get('code')).toMatchObject({
      state: ExtensionState.ERROR,
      heldBack: true,
      enabled: true,
      error: EXTENSION_HELD_BACK,
    });
    await host.dispose();
  });

  // Holding nothing back is the normal launch.
  it('starts everything when not holding', async () => {
    const withCode = extension('code');
    const registry = registryWith({ code: { loaded: withCode } });
    const { host, started } = restartableHost({ code: { activate() {} } }, registry);

    await host.activateAll();

    expect(started).toEqual(['code']);
    expect(host.getHeldBack()).toEqual([]);
    await host.dispose();
  });

  // The way back.
  it('starts what was held when the reader asks, and forgets the hold', async () => {
    const withCode = extension('code');
    const registry = registryWith({ code: { loaded: withCode } });
    const { host, started } = restartableHost({ code: { activate() {} } }, registry);
    await host.activateAll({ holdCode: true });

    await host.startHeldBack();

    expect(started).toEqual(['code']);
    expect(host.isActive('code')).toBe(true);
    expect(host.getHeldBack()).toEqual([]);
    expect(registry.infos.get('code')?.heldBack).toBeUndefined();
    await host.dispose();
  });

  // Turned off while held: "start them" must not switch it back on.
  it('does not start one that was turned off in the meantime', async () => {
    const withCode = extension('code');
    const entries = { code: { loaded: withCode, enabled: true } };
    const registry = registryWith(entries);
    const { host, started } = restartableHost({ code: { activate() {} } }, registry);
    await host.activateAll({ holdCode: true });
    entries.code.enabled = false;

    await host.startHeldBack();

    expect(started).toEqual([]);
  });

  // A failing one must not stop the rest, or the button seem to do nothing.
  it('keeps going past one that fails to start', async () => {
    const bad = extension('bad');
    const good = extension('good');
    const registry = registryWith({ bad: { loaded: bad }, good: { loaded: good } });
    const { host } = restartableHost(
      {
        bad: {
          activate() {
            throw new Error('no good');
          },
        },
        good: { activate() {} },
      },
      registry
    );
    await host.activateAll({ holdCode: true });

    await host.startHeldBack();

    expect(host.isActive('good')).toBe(true);
    await host.dispose();
  });

  // Through the manager, with real files: this is the seam main.ts uses.
  it('asks the caller, with the ids that have code, just before anything runs', async () => {
    const base = join(workDir, 'data');
    const dir = join(base, 'extensions', 'code');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'exports.activate = () => {};');
    writeFileSync(join(dir, 'sarvinbox-extension.json'), JSON.stringify(manifestFor('code')));
    const panelDir = join(base, 'extensions', 'panel');
    mkdirSync(panelDir, { recursive: true });
    writeFileSync(
      join(panelDir, 'sarvinbox-extension.json'),
      JSON.stringify({ ...manifestFor('panel'), main: undefined, permissions: ['ui:panel'], contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.html', surface: 'sidebar' }] } })
    );
    writeFileSync(join(panelDir, 'p.html'), '<p>x</p>');

    const started: string[] = [];
    const manager = new ExtensionManager({
      extensionsBaseDir: base,
      createChannel: (target) => {
        started.push(target.extensionId);
        const pair = createInProcessChannelPair();
        startExtensionSandbox(pair.sandbox, createNodeModuleLoader(target.rootDir));
        return pair.host;
      },
    });
    const decideHold = vi.fn(() => true);

    await manager.initialize({ decideHold });

    expect(decideHold).toHaveBeenCalledWith(['code']);
    expect(started).toEqual([]);
    expect(manager.getHeldBack()).toEqual(['code']);
    expect(manager.getRegistry().get('code')?.enabled).toBe(true);

    await manager.startHeldBack();
    expect(started).toEqual(['code']);
    await manager.shutdown();
  });
});

describe('a panel whose extension code is not running', () => {
  const request = (method: string, params: Record<string, unknown> = {}) => ({ requestId: 'r', method, params }) as never;

  // For the antivirus extension this panel is where setup is reached. Refusing it because
  // a crash took the code away, or Linux has no OS sandbox, leaves a dead end exactly when
  // someone is trying to fix something.
  it('is still served, under the permissions that were granted', async () => {
    const loaded = extension('a');
    const security = { getSetup: vi.fn(async () => ({ configured: true })) };
    const registry = registryWith({ a: { loaded, permissions: ['ui:panel', 'security:scan-attachments'] } });
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      securityBackend: security as never,
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => Promise.reject(new Error('Extensions are off')),
    });
    await expect(host.activate(loaded, ['ui:panel', 'security:scan-attachments'])).rejects.toThrow();

    const allowed = await host.servePanelRequest('a', request('security.getSetup'));

    expect(allowed).toMatchObject({ ok: true, value: { configured: true } });
    // Still only what was granted: this is no way around a permission.
    const refused = await host.servePanelRequest('a', request('storage.get', { key: 'k' }));
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toContain('storage:local');
  });

  // A panel has its own way into main, with no bridge in front of it, and any case in that
  // switch may stringify what it is given: a 300 MB string there ends the app. Refused for
  // every method, and still there for the next request, since nothing here is broken.
  it('has an oversized request refused, however it is dressed up', async () => {
    const loaded = extension('a');
    const storage = memoryStorage();
    const set = vi.spyOn(storage, 'set');
    const registry = registryWith({ a: { loaded, permissions: ['ui:panel', 'storage:local'] } });
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: storage,
      settingsBackend: memorySettings(),
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => Promise.reject(new Error('Extensions are off')),
    });
    await expect(host.activate(loaded, ['ui:panel', 'storage:local'])).rejects.toThrow();
    const huge = 'x'.repeat(MAX_MESSAGE_BYTES + 1);

    for (const params of [{ key: 'k', value: huge }, { key: 'k', value: [{ deep: [huge] }] }, { [huge]: 1 }]) {
      const refused = await host.servePanelRequest('a', request('storage.set', params));
      expect(refused).toMatchObject({ ok: false, error: 'This request is too large' });
    }
    const hugeId = await host.servePanelRequest('a', { requestId: huge, method: 'storage.set', params: { key: 'k', value: 1 } } as never);
    expect(hugeId).toMatchObject({ ok: false, error: 'This request is too large' });
    expect(set).not.toHaveBeenCalled();
    await expect(host.servePanelRequest('a', request('storage.set', { key: 'k', value: 1 }))).resolves.toMatchObject({ ok: true });
  });

  // The one request that really needs the code says so, with the reason.
  it('is told plainly that a call into its code cannot be served', async () => {
    const loaded = extension('a');
    const registry = registryWith({ a: { loaded, permissions: ['ui:panel'] } });
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorage(),
      settingsBackend: memorySettings(),
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => Promise.reject(new Error('Extensions are off')),
    });
    await expect(host.activate(loaded, ['ui:panel'])).rejects.toThrow();

    const answer = await host.servePanelRequest('a', request('exports.call', { name: 'run' }));

    expect(answer).toMatchObject({ ok: false });
    expect((answer as { error: string }).error).toContain('background code is not running: Extensions are off');
  });

  // Turned off means off: a panel of a disabled extension gets nothing.
  it('gets nothing once the extension is disabled', async () => {
    const loaded = extension('a');
    const registry = registryWith({ a: { loaded, enabled: false, permissions: ['ui:panel'] } });
    const { host } = restartableHost({}, registry);

    expect(await host.servePanelRequest('a', request('settings.all'))).toMatchObject({ ok: false });
  });
});

describe('the card about a problem', () => {
  // Shown with no `ui:notify` behind it, in the app's voice. A 120-character name is a
  // sentence of the extension's own on screen: "Your session expired, sign in at …".
  it('keeps only a short piece of the name', async () => {
    const reportProblem = vi.fn();
    const long = 'Your session expired, please sign in again at evil.example right now';
    const loaded = { ...extension('a'), manifest: { ...manifestFor('a'), name: long } };
    const { host, farEnds } = hostWith(
      { a: { activate() {} } },
      { ui: { notify: vi.fn(), dismiss: vi.fn(), reportProblem } }
    );
    await host.activate(loaded, []);

    farEnds.get('a')?.close();

    const { title } = reportProblem.mock.calls[0][1];
    expect(title.length).toBeLessThanOrEqual(MAX_NAME_ON_PROBLEM_CARD + ' has a problem'.length + 1);
    expect(title).not.toContain('evil.example');
    await host.dispose();
  });
});

describe('pong', () => {
  // The supervisor's only way to tell a hang from idleness. If the engine stops
  // answering, every healthy extension is killed after thirty seconds.
  it('answers a ping with its nonce', async () => {
    const pair = createInProcessChannelPair();
    const received: { type: string; nonce?: number }[] = [];
    pair.host.onMessage((message) => received.push(message as (typeof received)[number]));
    startExtensionSandbox(pair.sandbox, () => ({ activate() {} }));

    pair.host.post({ type: 'ping', nonce: 7 });

    await vi.waitFor(() => expect(received).toContainEqual({ type: 'pong', nonce: 7 }));
  });
});

describe('the Node loader', () => {
  // The in-process host: a file next to the entry must still be reachable.
  it('loads relative to the extension folder, and re-reads on reload', () => {
    const dir = join(workDir, 'n');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.js'), `exports.value = 1;`);
    const load = createNodeModuleLoader(dir);

    expect((load('index.js') as unknown as { value: number }).value).toBe(1);
    writeFileSync(join(dir, 'index.js'), `exports.value = 2;`);
    expect((load('index.js') as unknown as { value: number }).value).toBe(2);
  });
});

describe('installing a folder', () => {
  function folder(): string {
    const source = join(workDir, 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'index.js'), 'exports.activate = () => {};');
    writeFileSync(join(source, 'sarvinbox-extension.json'), JSON.stringify(manifestFor('linky')));
    return source;
  }

  // A symbolic link copied by following it pulls the target into the extension's own
  // folder: `notes.js -> ~/.aws/credentials` and the sandbox will serve it.
  it('does not follow a link into the installed copy', async () => {
    const outside = join(workDir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.js'), 'SECRET');
    const source = folder();
    symlinkSync(join(outside, 'secret.js'), join(source, 'notes.js'));
    symlinkSync(outside, join(source, 'linked-dir'));
    const manager = new ExtensionManager({
      extensionsBaseDir: join(workDir, 'data'),
      createChannel: (target) => {
        const pair = createInProcessChannelPair();
        startExtensionSandbox(pair.sandbox, createNodeModuleLoader(target.rootDir));
        return pair.host;
      },
    });
    await manager.initialize();

    await manager.installExtension(source);

    const installed = manager.getRegistry().get('linky')?.path as string;
    expect(() => readFileSync(join(installed, 'notes.js'))).toThrow();
    expect(() => readFileSync(join(installed, 'linked-dir', 'secret.js'))).toThrow();
    expect(readFileSync(join(installed, 'index.js'), 'utf8')).toContain('activate');
    await manager.shutdown();
  });

  // The entry point used to stay on the source folder after the copy, so what ran was
  // not what was installed, and the sandbox serves only the installed copy.
  it('runs the installed copy, not the folder it came from', async () => {
    const source = folder();
    const targets: SandboxTarget[] = [];
    const manager = new ExtensionManager({
      extensionsBaseDir: join(workDir, 'data'),
      createChannel: (target) => {
        targets.push(target);
        const pair = createInProcessChannelPair();
        startExtensionSandbox(pair.sandbox, createNodeModuleLoader(target.rootDir));
        return pair.host;
      },
    });
    await manager.initialize();

    await manager.installExtension(source);

    const installed = manager.getRegistry().get('linky')?.path as string;
    expect(targets[0].rootDir).toBe(installed);
    expect(targets[0].entryPoint).toBe(join(installed, 'index.js'));
    await manager.shutdown();
  });
});
