/**
 * The out-of-process extension runtime, driven end to end.
 *
 * These exercise the real sandbox engine over an in-memory channel — the same
 * code the desktop app runs across a `utilityProcess` boundary, with only the
 * transport swapped. A mock sandbox would prove nothing: the whole point of the
 * boundary is what happens when a call crosses it.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionContextImpl } from '../../../src/extensions/extension-api';
import type {
  ExtensionAIBackend,
  ExtensionMailBackend,
  ExtensionSettingsBackend,
  ExtensionStorageBackend,
} from '../../../src/extensions/extension-api';
import { ExtensionHost } from '../../../src/extensions/extension-host';
import type { LoadedExtension } from '../../../src/extensions/extension-loader';
import type { ExtensionRegistry } from '../../../src/extensions/extension-registry';
import { ExtensionBridge } from '../../../src/extensions/runtime/extension-bridge';
import { createInProcessChannelPair } from '../../../src/extensions/runtime/in-process-channel';
import type {
  ExtensionChannel,
  SandboxToHostMessage,
} from '../../../src/extensions/runtime/protocol';
import {
  ExtensionState,
  type ExtensionInfo,
  type ExtensionManifest,
  type ExtensionPermission,
} from '../../../src/extensions/types';
import { createEventBus, type EventBus } from '../../../src/pipeline/event-bus';
import type { WorkflowContext } from '../../../src/pipeline/types';
import type { EmailRecord } from '../../../src/types/models';

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

let workDir: string;

function manifestFor(id: string, extra: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'test extension',
    author: 'test',
    main: 'index.js',
    engines: { sarvinbox: '>=0.1.0' },
    permissions: [],
    ...extra,
  } as ExtensionManifest;
}

/** Write a real extension folder — the sandbox loads it with a real require. */
function writeExtension(id: string, source: string, extra?: Partial<ExtensionManifest>): LoadedExtension {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), source, 'utf-8');
  const manifest = manifestFor(id, extra);
  writeFileSync(join(dir, 'sarvinbox-extension.json'), JSON.stringify(manifest), 'utf-8');
  return { manifest, path: dir, entryPoint: join(dir, 'index.js') };
}

function emailFixture(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 'email-1',
    messageId: '<a@example.com>',
    threadId: 'thread-1',
    folderId: 'INBOX',
    uid: 1,
    tags: '|INBOX|',
    subject: 'Your code is 123456',
    fromAddress: 'noreply@example.com',
    fromName: 'Example',
    toAddress: 'me@example.com',
    date: 1_700_000_000,
    cleanBody: 'Your code is 123456',
    rawBody: 'Your code is 123456',
    contentType: 'text',
    contentHash: 'hash',
    ...overrides,
  } as EmailRecord;
}

/** Only the four members the host actually reaches for. */
function fakeRegistry(): ExtensionRegistry & { infos: Map<string, ExtensionInfo> } {
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

function memoryStorageBackend(): ExtensionStorageBackend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const scoped = (extensionId: string, key: string) => `${extensionId}::${key}`;
  return {
    data,
    async get<T>(extensionId: string, key: string) {
      return data.get(scoped(extensionId, key)) as T | undefined;
    },
    async set<T>(extensionId: string, key: string, value: T) {
      data.set(scoped(extensionId, key), value);
    },
    async delete(extensionId: string, key: string) {
      data.delete(scoped(extensionId, key));
    },
    async keys(extensionId: string) {
      return Array.from(data.keys())
        .filter((k) => k.startsWith(`${extensionId}::`))
        .map((k) => k.slice(extensionId.length + 2));
    },
    async clear(extensionId: string) {
      for (const key of Array.from(data.keys())) {
        if (key.startsWith(`${extensionId}::`)) data.delete(key);
      }
    },
  };
}

function memorySettingsBackend(
  initial: Record<string, Record<string, unknown>> = {}
): ExtensionSettingsBackend {
  const values = new Map<string, Record<string, unknown>>(Object.entries(initial));
  return {
    get: <T,>(extensionId: string, key: string) => values.get(extensionId)?.[key] as T | undefined,
    async update(extensionId: string, key: string, value: unknown) {
      const forExtension = values.get(extensionId) ?? {};
      forExtension[key] = value;
      values.set(extensionId, forExtension);
    },
    has: (extensionId: string, key: string) => key in (values.get(extensionId) ?? {}),
    keys: (extensionId: string) => Object.keys(values.get(extensionId) ?? {}),
  };
}

/** A mail backend that records what it was asked to do and nothing else. */
function recordingMailBackend(): ExtensionMailBackend & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    async get(...args) {
      calls.push({ method: 'get', args });
      return null;
    },
    async folders(...args) {
      calls.push({ method: 'folders', args });
      return [];
    },
    async applyLabels(...args) {
      calls.push({ method: 'applyLabels', args });
    },
    async move(...args) {
      calls.push({ method: 'move', args });
    },
    async trash(...args) {
      calls.push({ method: 'trash', args });
    },
  };
}

interface Harness {
  host: ExtensionHost;
  registry: ReturnType<typeof fakeRegistry>;
  storage: ReturnType<typeof memoryStorageBackend>;
  settings: ExtensionSettingsBackend;
  eventBus: EventBus;
  aiBackend: ExtensionAIBackend;
  mailBackend: ReturnType<typeof recordingMailBackend>;
}

function createHost(options: Partial<{ settings: ExtensionSettingsBackend; aiAvailable: boolean }> = {}): Harness {
  const registry = fakeRegistry();
  const storage = memoryStorageBackend();
  const settings = options.settings ?? memorySettingsBackend();
  const eventBus = createEventBus();
  const aiBackend: ExtensionAIBackend = {
    categorize: vi.fn(),
    generateReplySuggestions: vi.fn(),
    summarize: vi.fn(async (content: string) => `summary:${content}`),
    extractActionItems: vi.fn(),
    isAvailable: () => options.aiAvailable ?? true,
    complete: vi.fn(),
  } as unknown as ExtensionAIBackend;

  const mailBackend = recordingMailBackend();

  const host = new ExtensionHost({
    registry,
    eventBus,
    storageBackend: storage,
    aiBackend,
    settingsBackend: settings,
    mailBackend,
    extensionStoragePath: join(workDir, 'storage'),
  });

  return { host, registry, storage, settings, eventBus, aiBackend, mailBackend };
}

const WORKFLOW_PERMISSIONS: ExtensionPermission[] = ['email:read'];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sarvinbox-runtime-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------

describe('extension runtime', () => {
  // The whole feature in one line: an extension's code runs in the sandbox,
  // its workflow is scheduled by the host, and its result comes back with the
  // modifications applied. If this fails nothing about extensions works.
  it('runs a sandboxed workflow and applies its result', async () => {
    const loaded = writeExtension(
      'tagger',
      `exports.activate = (ctx) => {
         ctx.registerWorkflow({
           id: 'tag',
           name: 'Tag',
           priority: 10,
           shouldProcess: async (email) => email.subject.includes('code'),
           process: async (email) => ({
             success: true,
             modifications: { labels: ['verification'], subject: email.subject.toUpperCase() },
             labelsToAdd: ['otp'],
           }),
         });
       };`
    );
    const { host } = createHost();

    await host.activate(loaded, WORKFLOW_PERMISSIONS);

    expect(host.isActive('tagger')).toBe(true);
    expect(host.getAllWorkflowAdapters().map((a) => a.id)).toEqual(['tagger.tag']);

    const email = emailFixture();
    const results = await host.processEmail(email, { previousResults: new Map() } as WorkflowContext);

    expect(results.get('tagger.tag')).toMatchObject({ success: true, labelsToAdd: ['otp'] });
    expect(email.labels).toEqual(['verification']);
    // Deliberate, not a gap: `toWorkflowResult` keeps only the fields an
    // extension is allowed to change. A workflow cannot rewrite a message's
    // headers, so the subject it tried to overwrite is untouched.
    expect(email.subject).toBe('Your code is 123456');

    await host.dispose();
  });

  // shouldProcess is the cheap filter that runs on every message; if a false
  // answer did not cross back intact, every extension would process everything.
  it('skips a workflow whose shouldProcess says no', async () => {
    const loaded = writeExtension(
      'picky',
      `exports.activate = (ctx) => {
         ctx.registerWorkflow({
           id: 'never',
           name: 'Never',
           priority: 10,
           shouldProcess: async () => false,
           process: async () => ({ success: true }),
         });
       };`
    );
    const { host } = createHost();
    await host.activate(loaded, WORKFLOW_PERMISSIONS);

    const results = await host.processEmail(emailFixture(), {
      previousResults: new Map(),
    } as WorkflowContext);

    expect(results.size).toBe(0);
    await host.dispose();
  });

  // An error thrown inside extension code has to arrive in main as an Error,
  // not as a plain object: the pipeline records `result.error` and the settings
  // UI shows its message, and `undefined.message` there loses the diagnosis.
  it('carries an extension error back across the boundary', async () => {
    const loaded = writeExtension(
      'thrower',
      `exports.activate = (ctx) => {
         ctx.registerWorkflow({
           id: 'boom',
           name: 'Boom',
           priority: 10,
           shouldProcess: async () => true,
           process: async () => { throw new Error('exploded inside the extension'); },
         });
       };`
    );
    const { host } = createHost();
    await host.activate(loaded, WORKFLOW_PERMISSIONS);

    const results = await host.processEmail(emailFixture(), {
      previousResults: new Map(),
    } as WorkflowContext);

    const result = results.get('thrower.boom');
    expect(result?.success).toBe(false);
    expect(result?.error).toBeInstanceOf(Error);
    expect(result?.error?.message).toBe('exploded inside the extension');

    await host.dispose();
  });

  // Storage is the extension's only durable state and it lives in main now.
  // A write that never lands means an extension that forgets everything the
  // moment the sandbox restarts, with no error to say so.
  it('round-trips storage through the host backend', async () => {
    const loaded = writeExtension(
      'saver',
      `exports.activate = async (ctx) => {
         await ctx.storage.set('seen', ['a', 'b']);
         ctx.exports.readBack = async () => ctx.storage.get('seen');
       };`
    );
    const { host, storage } = createHost();

    await host.activate(loaded, ['storage:local']);

    expect(storage.data.get('saver::seen')).toEqual(['a', 'b']);
    const exports = host.getExtensionExports<{ readBack: () => Promise<string[]> }>('saver');
    await expect(exports?.readBack()).resolves.toEqual(['a', 'b']);

    await host.dispose();
  });

  // The permission check has to survive the move out of process. The sandbox
  // checks first for a good stack trace, but main is the authority — see the
  // bridge test below for the case where the sandbox does not check at all.
  it('denies a host call the extension has no permission for', async () => {
    const loaded = writeExtension(
      'greedy',
      `exports.activate = (ctx) => {
         ctx.exports.tryWrite = async () => {
           try { await ctx.storage.set('k', 1); return 'allowed'; }
           catch (error) { return error.message; }
         };
       };`
    );
    const { host, storage } = createHost();

    await host.activate(loaded, []);

    const exports = host.getExtensionExports<{ tryWrite: () => Promise<string> }>('greedy');
    await expect(exports?.tryWrite()).resolves.toContain("requires 'storage:local'");
    expect(storage.data.size).toBe(0);

    await host.dispose();
  });

  // `settings.get()` and `ai.isAvailable()` return plain values in the
  // authoring API, so they read a mirror rather than round-tripping. A mirror
  // that is not refreshed is worse than no mirror: it answers confidently with
  // a value the user changed minutes ago.
  it('answers settings synchronously and refreshes the mirror on demand', async () => {
    const loaded = writeExtension(
      'reader',
      `exports.activate = (ctx) => {
         ctx.exports.read = async () => ({
           value: ctx.settings.get('threshold'),
           fallback: ctx.settings.get('missing', 'default'),
           has: ctx.settings.has('threshold'),
           ai: ctx.ai ? ctx.ai.isAvailable() : null,
         });
       };`
    );
    const settings = memorySettingsBackend({ reader: { threshold: 5 } });
    const { host } = createHost({ settings });

    await host.activate(loaded, ['settings:read', 'ai:use']);
    const exports = host.getExtensionExports<{ read: () => Promise<Record<string, unknown>> }>('reader');

    await expect(exports?.read()).resolves.toEqual({
      value: 5,
      fallback: 'default',
      has: true,
      ai: true,
    });

    await settings.update('reader', 'threshold', 9);
    host.refreshSyncState('reader');

    await expect(exports?.read()).resolves.toMatchObject({ value: 9 });

    await host.dispose();
  });

  // A setting an extension declared but nobody ever wrote must read as absent.
  // Mirroring declared keys with a fabricated value would make `has()` lie.
  it('mirrors only settings that actually have a value', async () => {
    const loaded = writeExtension(
      'declarer',
      `exports.activate = (ctx) => {
         ctx.exports.read = async () => ctx.settings.has('never-set');
       };`,
      {
        contributes: {
          settings: [
            { key: 'never-set', type: 'string', default: 'x', description: 'unset on purpose' },
          ],
        },
      }
    );
    const { host } = createHost();

    await host.activate(loaded, ['settings:read']);
    const exports = host.getExtensionExports<{ read: () => Promise<boolean> }>('declarer');
    await expect(exports?.read()).resolves.toBe(false);

    await host.dispose();
  });

  // Events are how extensions react to mail arriving. The bus lives in main and
  // the handler lives in the sandbox, so a broken hop here looks exactly like
  // an extension that silently does nothing.
  it('delivers a bus event to a handler inside the sandbox', async () => {
    const loaded = writeExtension(
      'listener',
      `exports.activate = (ctx) => {
         const seen = [];
         ctx.events.on('email:synced', (event) => { seen.push(event.type); });
         ctx.exports.seen = async () => seen;
       };`
    );
    const { host, eventBus } = createHost();
    await host.activate(loaded, ['email:read']);

    eventBus.emit({ type: 'email:synced', timestamp: Date.now(), data: {} } as never);
    // The hop is main -> channel -> sandbox, so the handler runs a turn later.
    await vi.waitFor(async () => {
      const exports = host.getExtensionExports<{ seen: () => Promise<string[]> }>('listener');
      expect(await exports?.seen()).toEqual(['email:synced']);
    });

    await host.dispose();
  });

  // An extension can register a workflow long after activate() returns — on a
  // timer, or once a setting is filled in. Without the late-registration
  // message main never builds an adapter and the workflow never runs.
  it('adopts a workflow registered after activation', async () => {
    const loaded = writeExtension(
      'later',
      `exports.activate = (ctx) => {
         ctx.exports.addWorkflow = async () => {
           ctx.registerWorkflow({
             id: 'late',
             name: 'Late',
             priority: 10,
             shouldProcess: async () => true,
             process: async () => ({ success: true, labelsToAdd: ['late'] }),
           });
         };
       };`
    );
    const { host } = createHost();
    await host.activate(loaded, WORKFLOW_PERMISSIONS);
    expect(host.getAllWorkflowAdapters()).toHaveLength(0);

    const exports = host.getExtensionExports<{ addWorkflow: () => Promise<void> }>('later');
    await exports?.addWorkflow();

    await vi.waitFor(() => expect(host.getAllWorkflowAdapters().map((a) => a.id)).toEqual(['later.late']));

    const results = await host.processEmail(emailFixture(), {
      previousResults: new Map(),
    } as WorkflowContext);
    expect(results.get('later.late')).toMatchObject({ labelsToAdd: ['late'] });

    await host.dispose();
  });

  // Deactivation has to reach the extension's own hook — that is where an
  // extension closes what it opened — and must retire the workflow, or a
  // disabled extension keeps processing mail.
  it('runs the extension deactivate hook and retires its workflows', async () => {
    const loaded = writeExtension(
      'cleanup',
      `let closed = false;
       exports.activate = (ctx) => {
         ctx.registerWorkflow({
           id: 'w', name: 'W', priority: 10,
           shouldProcess: async () => true,
           process: async () => ({ success: true }),
         });
         ctx.exports.closed = async () => closed;
       };
       exports.deactivate = () => { closed = true; };`
    );
    const { host, storage } = createHost();
    await host.activate(loaded, WORKFLOW_PERMISSIONS);
    expect(host.getAllWorkflowAdapters()).toHaveLength(1);

    await host.deactivate('cleanup');

    expect(host.isActive('cleanup')).toBe(false);
    expect(host.getAllWorkflowAdapters()).toHaveLength(0);
    expect(storage.data.size).toBe(0);

    await host.dispose();
  });

  // An extension whose activate() throws must leave nothing behind, or the
  // retry after the user fixes it reports "already active" and never runs.
  it('leaves nothing active when activation fails', async () => {
    const loaded = writeExtension('broken', `exports.activate = () => { throw new Error('bad init'); };`);
    const { host, registry } = createHost();

    await expect(host.activate(loaded, [])).rejects.toThrow('bad init');
    expect(host.isActive('broken')).toBe(false);
    expect(registry.infos.get('broken')?.state).toBe(ExtensionState.ERROR);

    // The retry path: a fixed extension activates cleanly afterwards.
    const fixed = writeExtension('broken', `exports.activate = () => {};`);
    await expect(host.activate(fixed, [])).resolves.toBeUndefined();
    expect(host.isActive('broken')).toBe(true);

    await host.dispose();
  });

  // The failure this boundary exists for. When the sandbox dies, in-flight work
  // must reject rather than hang the ingest pipeline forever, and the adapters
  // must go — left in place they would fail once per email for the rest of the
  // session.
  it('fails in-flight work and stands the extension down when the sandbox dies', async () => {
    const loaded = writeExtension(
      'hanger',
      `exports.activate = (ctx) => {
         ctx.registerWorkflow({
           id: 'slow', name: 'Slow', priority: 10,
           shouldProcess: async () => true,
           process: () => new Promise(() => {}),
         });
       };`
    );
    let sandboxSide: ExtensionChannel | undefined;
    const registry = fakeRegistry();
    const host = new ExtensionHost({
      registry,
      eventBus: createEventBus(),
      storageBackend: memoryStorageBackend(),
      settingsBackend: memorySettingsBackend(),
      extensionStoragePath: join(workDir, 'storage'),
      createChannel: () => {
        const pair = createInProcessChannelPair();
        sandboxSide = pair.sandbox;
        // The real sandbox, started the way the default factory starts it.
        void import('../../../src/extensions/runtime/sandbox').then(({ startExtensionSandbox }) =>
          startExtensionSandbox(pair.sandbox)
        );
        return pair.host;
      },
    });

    await host.activate(loaded, WORKFLOW_PERMISSIONS);
    const adapter = host.getWorkflowAdapter('hanger.slow');
    const inFlight = adapter!.process(emailFixture(), { previousResults: new Map() } as WorkflowContext);

    sandboxSide!.close();

    await expect(inFlight).resolves.toMatchObject({ success: false });
    expect(host.getAllWorkflowAdapters()).toHaveLength(0);
    expect(host.isActive('hanger')).toBe(false);
    expect(registry.infos.get('hanger')?.state).toBe(ExtensionState.ERROR);
  });
});

// ------------------------------------------------------------------

describe('ExtensionBridge permission boundary', () => {
  // The sandbox checks permissions locally only so errors point at the
  // extension author's line. The check that actually protects the user is this
  // one: a host call arriving with no local check in front of it is still
  // refused, which is what a compromised sandbox would send.
  it('refuses a host call the granted permissions do not cover', async () => {
    const pair = createInProcessChannelPair();
    const replies: SandboxToHostMessage[] = [];
    const storageBackend = memoryStorageBackend();

    const context = new ExtensionContextImpl({
      manifest: manifestFor('sneaky'),
      storagePath: join(workDir, 'sneaky'),
      grantedPermissions: ['email:read'],
      eventBus: createEventBus(),
      storageBackend,
      settingsBackend: memorySettingsBackend(),
    });

    const bridge = new ExtensionBridge({
      channel: pair.host,
      hooks: {
        getContext: () => context,
        onWorkflowRegistered: () => undefined,
        onWorkflowUnregistered: () => undefined,
        onSandboxClosed: () => undefined,
      },
    });

    const received: unknown[] = [];
    pair.sandbox.onMessage((message) => received.push(message));
    pair.sandbox.post({
      type: 'host-call',
      requestId: 'hc-1',
      extensionId: 'sneaky',
      method: 'storage.set',
      args: ['stolen', 'value'],
    });

    await vi.waitFor(() => {
      replies.push(...(received as SandboxToHostMessage[]));
      expect(received.some((m) => (m as { type: string }).type === 'host-reply')).toBe(true);
    });

    const reply = received.find((m) => (m as { type: string }).type === 'host-reply') as {
      ok: boolean;
      error?: { message: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.error?.message).toContain("requires 'storage:local'");
    expect(storageBackend.data.size).toBe(0);

    await bridge.shutdown();
  });
});

// ------------------------------------------------------------------

describe('card actions reaching a sandboxed extension', () => {
  // The acceptance case, end to end across the sandbox boundary: a reader
  // copies the code off an extension's card and the EXTENSION — not the app —
  // marks that mail read. If this breaks, every card in the app becomes a
  // one-way display again and no extension can react to being used.
  it('runs the extension ui.onAction handler and applies the mail change it asks for', async () => {
    const loaded = writeExtension(
      'otp',
      `exports.activate = (ctx) => {
         ctx.ui.onAction(async (action) => {
           if (action.action !== 'copy') return;
           await ctx.mail.markRead(action.emailId);
         });
       };`
    );
    const { host, mailBackend } = createHost();
    await host.activate(loaded, ['ui:notify', 'email:flag']);

    await host.dispatchNotificationAction('otp', {
      notificationId: 'code:email-1',
      action: 'copy',
      emailId: 'email-1',
    });

    await vi.waitFor(() => expect(mailBackend.calls).toHaveLength(1));
    expect(mailBackend.calls[0]).toEqual({
      method: 'applyLabels',
      args: ['otp', 'email-1', { add: ['read'] }],
    });

    await host.dispose();
  });

  // Regression: the same handler must NOT act on a dismissal or an expiry.
  // Marking read on those would hide a code the reader never took.
  it('delivers the action verbatim so the extension can ignore the ones it does not want', async () => {
    const loaded = writeExtension(
      'otp',
      `exports.activate = (ctx) => {
         ctx.ui.onAction(async (action) => {
           if (action.action !== 'copy') return;
           await ctx.mail.markRead(action.emailId);
         });
       };`
    );
    const { host, mailBackend } = createHost();
    await host.activate(loaded, ['ui:notify', 'email:flag']);

    await host.dispatchNotificationAction('otp', {
      notificationId: 'code:email-1',
      action: 'dismiss',
      emailId: 'email-1',
    });
    await host.dispatchNotificationAction('otp', {
      notificationId: 'code:email-1',
      action: 'expire',
      emailId: 'email-1',
    });

    expect(mailBackend.calls).toHaveLength(0);
    await host.dispose();
  });

  // Regression: a permission the user did not grant must still be refused when
  // the call originates from a reader's click rather than a workflow. The
  // click is not consent to anything the install prompt did not list.
  it('refuses a mail change the extension was not granted, without failing the click', async () => {
    const loaded = writeExtension(
      'greedy',
      `exports.activate = (ctx) => {
         ctx.ui.onAction(async () => {
           await ctx.mail.trash('email-1');
         });
       };`
    );
    const { host, mailBackend } = createHost();
    await host.activate(loaded, ['ui:notify']);

    // Never rejects: a reader's copy button must not surface an extension's
    // permission error as a failed click.
    await expect(
      host.dispatchNotificationAction('greedy', { notificationId: 'c', action: 'copy' })
    ).resolves.toBeUndefined();
    expect(mailBackend.calls).toHaveLength(0);

    await host.dispose();
  });
});

// ------------------------------------------------------------------

describe('capability resolution', () => {
  const CAPABILITY = 'thread.summarize';

  function summarizer(id: string, priority: number, exportIt = true): LoadedExtension {
    return writeExtension(
      id,
      exportIt
        ? `exports.activate = (ctx) => { ctx.exports = { run: async () => '${id}' }; };`
        : `exports.activate = () => undefined;`,
      {
        contributes: { capabilities: [{ id: CAPABILITY, export: 'run', priority }] },
      } as Partial<ExtensionManifest>
    );
  }

  // Regression: the app names a JOB, not an extension. If resolution stops
  // working the app silently falls back to its own implementation forever and
  // an installed extension does nothing, with no error anywhere.
  it('picks the highest-priority extension that declares the capability', async () => {
    const { host } = createHost();
    await host.activate(summarizer('low', 1), []);
    await host.activate(summarizer('high', 10), []);

    expect(host.findCapabilityProvider(CAPABILITY)).toEqual({
      extensionId: 'high',
      exportName: 'run',
    });

    await host.dispose();
  });

  // Regression: a manifest can promise an export the code never sets. Serving
  // that one anyway would fail on the reader's click while a working
  // lower-priority provider sat unused.
  it('skips a provider that declares the capability but does not export it', async () => {
    const { host } = createHost();
    await host.activate(summarizer('broken', 100, false), []);
    await host.activate(summarizer('working', 1), []);

    expect(host.findCapabilityProvider(CAPABILITY)).toEqual({
      extensionId: 'working',
      exportName: 'run',
    });

    await host.dispose();
  });

  // Regression: nothing installed is the ordinary state of a fresh app, not an
  // error — the caller has to be able to tell "no provider" from "it failed".
  it('returns null when nothing serves the capability', async () => {
    const { host } = createHost();
    expect(host.findCapabilityProvider(CAPABILITY)).toBeNull();
    await host.dispose();
  });

  // Regression: equal priorities must resolve the same way on every run, or
  // which extension answers changes between launches for no visible reason.
  it('breaks a priority tie by extension id, stably', async () => {
    const { host } = createHost();
    await host.activate(summarizer('zebra', 5), []);
    await host.activate(summarizer('alpha', 5), []);

    expect(host.findCapabilityProvider(CAPABILITY)?.extensionId).toBe('alpha');
    await host.dispose();
  });
});
