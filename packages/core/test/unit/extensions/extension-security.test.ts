import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExtensionContextImpl,
  type ExtensionSecurityBackend,
} from '../../../src/extensions/extension-api';
import { ExtensionHost } from '../../../src/extensions/extension-host';
import { validateManifest } from '../../../src/extensions/extension-loader';
import { ExtensionManager } from '../../../src/extensions/extension-manager';
import type { ExtensionRegistry } from '../../../src/extensions/extension-registry';
import { panelRequestPermission, parsePanelRequest } from '../../../src/extensions/panel-bridge';
import { ExtensionBridge } from '../../../src/extensions/runtime/extension-bridge';
import { createInProcessChannelPair } from '../../../src/extensions/runtime/in-process-channel';
import type { HostCallMethod } from '../../../src/extensions/runtime/protocol';
import { startExtensionSandbox } from '../../../src/extensions/runtime/sandbox';
import type {
  AntivirusScanJob,
  AntivirusScanTarget,
  AntivirusSetupStatus,
  ExtensionContext,
  ExtensionManifest,
  ExtensionPermission,
  ExtensionSecurity,
} from '../../../src/extensions/types';
import { createEventBus } from '../../../src/pipeline/event-bus';

const manifest: ExtensionManifest = {
  id: 'scanner', name: 'Scanner', version: '1.0.0', author: 'test',
  description: 'Scan selected targets', engines: { sarvinbox: '>=0.1.0' },
  contributes: { panels: [{ id: 'scan', title: 'Scan', entry: 'scan.html', surface: 'sidebar' }] },
  permissions: ['ui:panel', 'security:scan-attachments', 'security:scan-body'],
};

const targets: AntivirusScanTarget[] = [
  { targetId: 'opaque-attachment', kind: 'attachment', displayName: 'invoice.pdf', byteLength: 25 },
  { targetId: 'opaque-body', kind: 'email-body', displayName: 'Email body', byteLength: null },
];
const setup: AntivirusSetupStatus = {
  endpoint: 'https://scanner.example', configured: true, enabled: true,
  allowedAccountIds: ['account-1'], allowBody: true,
};
const job: AntivirusScanJob = {
  id: 'job-1', state: 'queued', items: [],
  createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
};

function scannerBackend() {
  return {
    getTargets: vi.fn(async () => targets), getSetup: vi.fn(async () => setup),
    openSetup: vi.fn(async () => undefined), submit: vi.fn(async () => job),
    get: vi.fn(async () => job), cancel: vi.fn(async () => ({ ...job, state: 'cancelled' as const })),
    onExtensionDisabled: vi.fn(async () => undefined), onExtensionDeactivated: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  } satisfies ExtensionSecurityBackend;
}

function contextOptions(permissions: ExtensionPermission[], backend?: ExtensionSecurityBackend) {
  return {
    manifest, storagePath: '/tmp/scan-extension', grantedPermissions: permissions,
    eventBus: createEventBus(), securityBackend: backend,
    storageBackend: {
      get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn(), clear: vi.fn(),
    },
    settingsBackend: { get: vi.fn(), update: vi.fn(), has: vi.fn() },
  };
}

const hosts: ExtensionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

function createHost(backend: ExtensionSecurityBackend, worker = false) {
  const options = contextOptions([], backend);
  const infos = new Map();
  let workerContext: ExtensionContext | undefined;
  const host = new ExtensionHost({
    ...options,
    registry: {
      getRuntimeInfo: (id: string) => infos.get(id),
      setRuntimeInfo: (id: string, info: unknown) => infos.set(id, info),
    } as unknown as ExtensionRegistry,
    extensionStoragePath: '/tmp/scan-extension',
    createChannel: worker ? () => {
      const pair = createInProcessChannelPair();
      startExtensionSandbox(pair.sandbox, () => ({ activate(context) {
        workerContext = context;
        context.exports = Object.fromEntries(
          Object.entries(context.security).map(([name, fn]) => [name, (...args: unknown[]) =>
            (fn as (...args: unknown[]) => unknown)(...args)])
        );
      } }));
      return pair.host;
    } : undefined,
  });
  hosts.push(host);
  return { host, getWorkerContext: () => workerContext };
}

describe('extension antivirus permissions', () => {
  it('accepts both scanner permissions in a manifest', () => {
    expect(validateManifest(manifest).errors).toEqual([]);
  });

  const operations: Array<[string, (security: ExtensionSecurity) => unknown]> = [
    ['getTargets', (security) => security.getTargets()],
    ['getSetup', (security) => security.getSetup()],
    ['openSetup', (security) => security.openSetup()],
    ['submit', (security) => security.submit(['opaque-attachment'])],
    ['get', (security) => security.get('job-1')],
    ['cancel', (security) => security.cancel('job-1')],
  ];
  it.each(operations)('refuses %s without the attachment grant', async (_name, run) => {
    const backend = scannerBackend();
    const context = new ExtensionContextImpl(contextOptions(['security:scan-body'], backend));
    await expect(Promise.resolve().then(() => run(context.security))).rejects.toThrow('security:scan-attachments');
    for (const mock of Object.values(backend)) expect(mock).not.toHaveBeenCalled();
  });

  it('checks the authoritative body target kind even when consent is omitted', async () => {
    const backend = scannerBackend();
    const context = new ExtensionContextImpl(contextOptions(['security:scan-attachments'], backend));
    await expect(context.security.submit(['opaque-body'])).rejects.toThrow('security:scan-body');
    expect(backend.submit).not.toHaveBeenCalled();
  });

  it('requires separate consent for each body submission', async () => {
    const backend = scannerBackend();
    const context = new ExtensionContextImpl(contextOptions(manifest.permissions, backend));
    await expect(context.security.submit(['opaque-body'])).rejects.toThrow('explicit consent');
    await expect(context.security.submit(['opaque-body'], { includeBodyConsent: false })).rejects.toThrow('explicit consent');
    expect(backend.submit).not.toHaveBeenCalled();
    expect(await context.security.submit(['opaque-body'], { includeBodyConsent: true })).toEqual(job);
    expect(backend.submit).toHaveBeenCalledWith('scanner', ['opaque-body'], { includeBodyConsent: true });
  });

  it('refuses stale ids and malformed input before an upload begins', async () => {
    const backend = scannerBackend();
    const context = new ExtensionContextImpl(contextOptions(manifest.permissions, backend));
    for (const ids of [[], ['forged'], ['opaque-attachment', 'opaque-attachment'], [5]]) {
      await expect(context.security.submit(ids as string[])).rejects.toThrow();
    }
    await expect(context.security.submit(['opaque-body'], { includeBodyConsent: 'yes' } as never)).rejects.toThrow('Invalid');
    expect(backend.submit).not.toHaveBeenCalled();
  });

  it('stops an in-flight preflight after access is revoked', async () => {
    const backend = scannerBackend();
    let release!: (value: AntivirusScanTarget[]) => void;
    backend.getTargets.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const context = new ExtensionContextImpl(contextOptions(manifest.permissions, backend));
    const submitting = context.security.submit(['opaque-attachment']);
    context.revokeSecurityAccess();
    release(targets);
    await expect(submitting).rejects.toThrow('revoked');
    expect(backend.submit).not.toHaveBeenCalled();
  });
});

describe('antivirus panel bridge', () => {
  it.each(['getTargets', 'getSetup', 'openSetup', 'submit', 'get', 'cancel'])('gates security.%s in the bridge protocol', (name) => {
    const method = `security.${name}`;
    expect(panelRequestPermission(method)).toBe('security:scan-attachments');
    expect(parsePanelRequest({ channel: 'sarv-panel-bridge', requestId: 'r', method })?.method).toBe(method);
  });

  it('requires ui:panel even when scanner permissions were granted', async () => {
    const backend = scannerBackend();
    const { host } = createHost(backend);
    await host.activate({ manifest, path: '/tmp/scanner', entryPoint: undefined }, ['security:scan-attachments']);
    expect(await host.servePanelRequest('scanner', { requestId: 'r', method: 'security.getTargets' })).toMatchObject({ ok: false, error: expect.stringContaining('ui:panel') });
    expect(backend.getTargets).not.toHaveBeenCalled();
  });

  it('forwards only opaque selected ids and consent through the permission checked API', async () => {
    const backend = scannerBackend();
    const { host } = createHost(backend);
    await host.activate({ manifest, path: '/tmp/scanner', entryPoint: undefined }, manifest.permissions);
    const reply = await host.servePanelRequest('scanner', { requestId: 'r', method: 'security.submit', params: {
      targetIds: ['opaque-attachment'], messageId: 'attacker-message', accountId: 'attacker-account',
      options: { includeBodyConsent: false, endpoint: 'https://attacker.example', apiKey: 'forged' },
    } });
    expect(reply).toMatchObject({ ok: true, value: job });
    expect(backend.submit).toHaveBeenCalledWith('scanner', ['opaque-attachment'], { includeBodyConsent: false });
  });

  it('refuses body submissions from a panel that lacks the body grant', async () => {
    const backend = scannerBackend();
    const { host } = createHost(backend);
    await host.activate({ manifest, path: '/tmp/scanner', entryPoint: undefined }, ['ui:panel', 'security:scan-attachments']);
    expect(await host.servePanelRequest('scanner', { requestId: 'r', method: 'security.submit', params: {
      targetIds: ['opaque-body'], options: { includeBodyConsent: true },
    } })).toMatchObject({ ok: false, error: expect.stringContaining('security:scan-body') });
    expect(backend.submit).not.toHaveBeenCalled();
  });
});

describe('antivirus worker bridge', () => {
  it('supports the SDK calls across the sandbox transport', async () => {
    const backend = scannerBackend();
    const { host } = createHost(backend, true);
    await host.activate({ manifest, path: '/tmp/scanner', entryPoint: '/tmp/scanner/index.js' }, manifest.permissions);
    const exports = host.getExtensionExports<ExtensionSecurity>('scanner')!;
    expect(await exports.getTargets()).toEqual(targets);
    expect(await exports.getSetup()).toEqual(setup);
    await exports.openSetup();
    expect(await exports.submit(['opaque-body'], { includeBodyConsent: true })).toEqual(job);
    expect(await exports.get('job-1')).toEqual(job);
    expect((await exports.cancel('job-1')).state).toBe('cancelled');
    expect(backend.get).toHaveBeenCalledWith('scanner', 'job-1');
    expect(backend.cancel).toHaveBeenCalledWith('scanner', 'job-1');
    await host.deactivate('scanner');
    expect(backend.onExtensionDeactivated).toHaveBeenCalledWith('scanner');
    expect(backend.onExtensionDisabled).not.toHaveBeenCalled();
  });

  it.each(['getTargets', 'getSetup', 'openSetup', 'submit', 'get', 'cancel'])('rejects an injected security.%s host call without permission', async (name) => {
    const backend = scannerBackend();
    const context = new ExtensionContextImpl(contextOptions([], backend));
    const pair = createInProcessChannelPair();
    const received: Array<{ type: string; ok?: boolean; error?: { message: string } }> = [];
    pair.sandbox.onMessage((message) => received.push(message as typeof received[number]));
    const bridge = new ExtensionBridge({ channel: pair.host, hooks: {
      getContext: () => context, onWorkflowRegistered: vi.fn(),
      onWorkflowUnregistered: vi.fn(), onSandboxClosed: vi.fn(),
    } });
    pair.sandbox.post({ type: 'host-call', extensionId: 'scanner', requestId: 'injected',
      method: `security.${name}` as HostCallMethod, args: [['opaque-body'], { includeBodyConsent: true }],
    });
    await vi.waitFor(() => expect(received.some((reply) => reply.type === 'host-reply')).toBe(true));
    expect(received.find((reply) => reply.type === 'host-reply')).toMatchObject({
      ok: false, error: { message: expect.stringContaining('security:scan-attachments') },
    });
    for (const mock of Object.values(backend)) expect(mock).not.toHaveBeenCalled();
    await bridge.shutdown();
  });
});

describe('scanner consent lifecycle', () => {
  it.each(['disableExtension', 'uninstallExtension'] as const)('revokes durable consent for an explicit %s', async (operation) => {
    const backend = scannerBackend();
    const options = contextOptions([], backend);
    const manager = new ExtensionManager({
      extensionsBaseDir: '/tmp/scanner-manager-test', storageBackend: options.storageBackend,
      settingsBackend: options.settingsBackend, securityBackend: backend,
    });
    hosts.push(manager.getHost());
    const registry = manager.getRegistry();
    const effect = operation === 'disableExtension' ? 'disable' : 'uninstall';
    vi.spyOn(registry, effect).mockImplementation(async () => {
      expect(backend.onExtensionDisabled).toHaveBeenCalledWith('scanner');
    });
    await manager[operation]('scanner');
    expect(backend.onExtensionDisabled).toHaveBeenCalledOnce();
  });

  it('cancels transient work on shutdown and preserves durable consent', async () => {
    const backend = scannerBackend();
    const { host } = createHost(backend);
    await host.activate({ manifest, path: '/tmp/scanner', entryPoint: undefined }, manifest.permissions);
    await host.dispose();
    expect(backend.onExtensionDeactivated).toHaveBeenCalledWith('scanner');
    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(backend.onExtensionDisabled).not.toHaveBeenCalled();
    hosts.splice(hosts.indexOf(host), 1);
  });
});
