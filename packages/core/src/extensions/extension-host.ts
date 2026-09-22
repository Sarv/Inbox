/**
 * Extension Host
 *
 * Owns extension lifecycle. Extension code itself runs in a separate sandbox
 * process, reached through `ExtensionBridge`; what stays here is everything
 * that decides what an extension is allowed to do.
 *
 * The split matters because the permission-checked `ExtensionContextImpl` is
 * still built here, per extension, from the permissions the user actually
 * granted — the sandbox holds no authority of its own, it asks. So a
 * compromised extension gets a process with no filesystem handle, no database
 * and no network client, and every request it makes is answered by the same
 * checks that guarded the in-process version.
 *
 * Workflows the sandbox reports are registered back through
 * `context.registerWorkflow`, so a workflow that skipped its permission check
 * on the far side is rejected here before it can ever run.
 */

import { EventBus } from '../pipeline/event-bus';
import type { WorkflowResult } from '../pipeline/types';
import { EmailWorkflow, WorkflowContext, WorkflowPriority } from '../pipeline/types';
import type { EmailRecord } from '../types/models';
import { logger } from '../utils/logger';

import {
  createExtensionContext,
  ExtensionContextImpl,
  type ExtensionStorageBackend,
  type ExtensionAIBackend,
  type ExtensionSettingsBackend,
  type ExtensionUIBackend,
  type ExtensionMailBackend,
  toWorkflowResult,
} from './extension-api';
import type { LoadedExtension } from './extension-loader';
import type { ExtensionRegistry } from './extension-registry';
import { panelRequestPermission, type PanelRequest, type PanelResponse } from './panel-bridge';
import { ExtensionBridge } from './runtime/extension-bridge';
import { createInProcessChannelPair } from './runtime/in-process-channel';
import type { ExtensionChannel, SandboxSyncState, WorkflowDescriptor } from './runtime/protocol';
import { createRemoteExports, createRemoteWorkflow } from './runtime/remote-proxies';
import { startExtensionSandbox } from './runtime/sandbox';
import {
  ExtensionState,
  type ExtensionManifest,
  type ExtensionPermission,
  type ExtensionInfo,
  type ExtensionWorkflow,
  type ExtensionUIAction,
  type ExtensionUINotification,
} from './types';

/**
 * Extension module interface (what the extension exports)
 */
export interface ExtensionModule {
  activate(context: ExtensionContextImpl): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * Run the sandbox in this process, on an in-memory channel.
 *
 * The fallback when no channel factory is supplied. It is the same engine the
 * desktop app runs across a process boundary — the only difference is which
 * side of the channel the sandbox sits on — so an extension behaves identically
 * either way and the tests exercise the shipping code.
 */
/** What the app has to supply for the requests the host cannot answer alone. */
export interface PanelRequestDeps {
  /**
   * The message the reader currently has open, in whatever shape the app wants
   * a panel to see. Omitted when nothing is open.
   */
  getCurrentMessage?(): Promise<unknown>;
}

function createInProcessSandboxChannel(): ExtensionChannel {
  const { host, sandbox } = createInProcessChannelPair();
  startExtensionSandbox(sandbox);
  return host;
}

/**
 * Extension host options
 */
export interface ExtensionHostOptions {
  /** Extension registry */
  registry: ExtensionRegistry;

  /** Event bus for pipeline events */
  eventBus: EventBus;

  /** Storage backend for extensions */
  storageBackend: ExtensionStorageBackend;

  /** AI backend for extensions */
  aiBackend?: ExtensionAIBackend;

  /** Settings backend for extensions */
  settingsBackend: ExtensionSettingsBackend;

  /** UI notification backend (omit for a host that renders no UI) */
  uiBackend?: ExtensionUIBackend;

  /** Mail backend (omit for a host with no mailbox to change) */
  mailBackend?: ExtensionMailBackend;

  /** Base path for extension storage */
  extensionStoragePath: string;

  /**
   * Opens the channel to the sandbox process.
   *
   * The desktop app supplies one backed by an Electron `utilityProcess`. Left
   * out, extensions run in an in-process sandbox instead — which is what the
   * CLI and the tests want, and is still the old trust model, not a weaker one.
   */
  createChannel?: () => ExtensionChannel | Promise<ExtensionChannel>;
}

/**
 * Which pass over a message is running.
 *
 * 'arrival' — the message just synced; headers are present, the body may not be.
 * 'body'    — the body finished fetching; only body-reading workflows re-run.
 */
export type WorkflowStage = 'arrival' | 'body';

/**
 * Active extension info
 */
interface ActiveExtension {
  manifest: ExtensionManifest;
  context: ExtensionContextImpl;
  state: ExtensionState;
}

/**
 * Extension Host - manages extension lifecycle and execution
 */
export class ExtensionHost {
  private registry: ExtensionRegistry;
  private eventBus: EventBus;
  private storageBackend: ExtensionStorageBackend;
  private aiBackend?: ExtensionAIBackend;
  private settingsBackend: ExtensionSettingsBackend;
  private uiBackend?: ExtensionUIBackend;
  private mailBackend?: ExtensionMailBackend;
  private extensionStoragePath: string;

  private createChannel: () => ExtensionChannel | Promise<ExtensionChannel>;

  private activeExtensions: Map<string, ActiveExtension> = new Map();
  private workflowAdapters: Map<string, ExtensionWorkflowAdapter> = new Map();

  private bridge: ExtensionBridge | null = null;
  /** In flight while the sandbox starts, so concurrent activations share one. */
  private bridgeStarting: Promise<ExtensionBridge> | null = null;

  constructor(options: ExtensionHostOptions) {
    this.registry = options.registry;
    this.eventBus = options.eventBus;
    this.storageBackend = options.storageBackend;
    this.aiBackend = options.aiBackend;
    this.settingsBackend = options.settingsBackend;
    this.uiBackend = options.uiBackend;
    this.mailBackend = options.mailBackend;
    this.extensionStoragePath = options.extensionStoragePath;
    this.createChannel = options.createChannel ?? createInProcessSandboxChannel;
  }

  /**
   * The bridge to the sandbox, starting it if it is not up.
   *
   * One sandbox is shared by every extension. Per-extension processes would
   * isolate a crash, but at a fixed cost per installed extension — and the
   * boundary that actually matters, between extension code and the app's data,
   * is already drawn by the first one.
   */
  private async ensureBridge(): Promise<ExtensionBridge> {
    if (this.bridge && !this.bridge.isClosed()) return this.bridge;
    if (this.bridgeStarting) return this.bridgeStarting;

    this.bridgeStarting = (async () => {
      const channel = await this.createChannel();
      const bridge = new ExtensionBridge({
        channel,
        hooks: {
          getContext: (extensionId) => this.activeExtensions.get(extensionId)?.context,
          onWorkflowRegistered: (extensionId, descriptor) =>
            this.adoptWorkflow(extensionId, descriptor),
          onWorkflowUnregistered: (extensionId, fullId) =>
            this.dropWorkflow(extensionId, fullId),
          onSandboxClosed: () => this.handleSandboxLoss(),
        },
      });
      await bridge.whenReady();
      this.bridge = bridge;
      return bridge;
    })();

    try {
      return await this.bridgeStarting;
    } finally {
      this.bridgeStarting = null;
    }
  }

  /**
   * The values the sandbox must be able to answer synchronously.
   *
   * `ai.isAvailable()`, `settings.get()` and `settings.has()` return plain
   * values in the authoring API, and a round trip cannot. They read this mirror
   * instead, which is pushed at activation and refreshed whenever the app
   * changes either side of it.
   */
  private syncStateFor(manifest: ExtensionManifest): SandboxSyncState {
    return {
      aiAvailable: this.aiBackend?.isAvailable() ?? false,
      settings: this.readSettings(manifest),
    };
  }

  private readSettings(manifest: ExtensionManifest): Record<string, unknown> {
    // Declared keys first, so an extension reading a setting it declared but
    // never wrote still sees nothing rather than a stale value, and the mirror
    // is complete even against a backend that cannot enumerate.
    const declared = (manifest.contributes?.settings ?? []).map((setting) => setting.key);
    const stored = this.settingsBackend.keys?.(manifest.id) ?? [];
    const settings: Record<string, unknown> = {};
    for (const key of new Set([...declared, ...stored])) {
      if (this.settingsBackend.has(manifest.id, key)) {
        settings[key] = this.settingsBackend.get(manifest.id, key);
      }
    }
    return settings;
  }

  /**
   * Re-push the synchronous mirror for one extension, or all of them.
   *
   * Call after the app changes an extension's settings or the AI backend's
   * availability flips — otherwise `settings.get()` inside the sandbox keeps
   * answering with the value from activation time.
   */
  refreshSyncState(extensionId?: string): void {
    const bridge = this.bridge;
    if (!bridge || bridge.isClosed()) return;
    const targets = extensionId
      ? [this.activeExtensions.get(extensionId)].filter(
          (active): active is ActiveExtension => active !== undefined
        )
      : Array.from(this.activeExtensions.values());
    for (const active of targets) {
      bridge.pushSyncState(active.manifest.id, this.syncStateFor(active.manifest));
    }
  }

  /**
   * Take on a workflow the sandbox registered after activation returned.
   *
   * It goes through `context.registerWorkflow` like any other, so a workflow
   * that waits until later to appear gets exactly the same permission check as
   * one registered during `activate()`.
   */
  private adoptWorkflow(extensionId: string, descriptor: WorkflowDescriptor): void {
    const active = this.activeExtensions.get(extensionId);
    const bridge = this.bridge;
    if (!active || !bridge) return;
    if (this.workflowAdapters.has(descriptor.fullId)) return;

    try {
      const workflow = createRemoteWorkflow(bridge, extensionId, descriptor);
      active.context.registerWorkflow(workflow);
      this.workflowAdapters.set(
        descriptor.fullId,
        new ExtensionWorkflowAdapter(descriptor.fullId, workflow, active.context, active.manifest)
      );
      const info = this.registry.getRuntimeInfo(extensionId);
      if (info && !info.workflowIds.includes(descriptor.fullId)) {
        info.workflowIds.push(descriptor.fullId);
        this.registry.setRuntimeInfo(extensionId, info);
      }
    } catch (error) {
      logger.warn(
        `Extension ${extensionId} could not register workflow ${descriptor.fullId}:`,
        error
      );
    }
  }

  private dropWorkflow(extensionId: string, fullId: string): void {
    const active = this.activeExtensions.get(extensionId);
    if (!active) return;
    active.context.unregisterWorkflow(fullId);
    this.workflowAdapters.delete(fullId);
    const info = this.registry.getRuntimeInfo(extensionId);
    if (info) {
      info.workflowIds = info.workflowIds.filter((id) => id !== fullId);
      this.registry.setRuntimeInfo(extensionId, info);
    }
  }

  /**
   * The sandbox died.
   *
   * Nothing it was running is running any more, so the adapters have to go now:
   * left in place they would keep being handed every incoming message, each one
   * failing against a dead channel and turning one crash into a per-email
   * error for the rest of the session. Extensions are marked errored and stay
   * down until something asks for them again — `reload` re-forks the sandbox.
   */
  private handleSandboxLoss(): void {
    if (this.activeExtensions.size === 0) {
      this.bridge = null;
      return;
    }
    logger.error(`Extension sandbox stopped with ${this.activeExtensions.size} extensions active`);
    for (const [extensionId, active] of this.activeExtensions) {
      try {
        active.context.dispose();
      } catch {
        // Cleanup is best-effort; one bad disposer must not strand the rest.
      }
      const info = this.registry.getRuntimeInfo(extensionId);
      if (info) {
        info.state = ExtensionState.ERROR;
        info.error = 'Extension sandbox stopped';
        info.workflowIds = [];
        this.registry.setRuntimeInfo(extensionId, info);
      }
    }
    this.activeExtensions.clear();
    this.workflowAdapters.clear();
    this.bridge = null;
  }

  /**
   * Activate all enabled extensions
   */
  async activateAll(): Promise<void> {
    const enabled = this.registry.filter({ enabled: true });

    for (const ext of enabled) {
      const loaded = this.registry.getLoaded(ext.id);
      if (!loaded) {
        logger.warn(`Extension ${ext.id} is enabled but not loaded`);
        continue;
      }

      try {
        await this.activate(loaded, ext.grantedPermissions);
      } catch (error) {
        logger.error(`Failed to activate extension ${ext.id}:`, error);
      }
    }

    logger.info(`Activated ${this.activeExtensions.size} extensions`);
  }

  /**
   * Activate a single extension
   */
  async activate(
    loaded: LoadedExtension,
    grantedPermissions: ExtensionPermission[]
  ): Promise<void> {
    const { manifest, entryPoint } = loaded;

    if (this.activeExtensions.has(manifest.id)) {
      logger.warn(`Extension ${manifest.id} is already active`);
      return;
    }

    logger.info(`Activating extension: ${manifest.id}`);

    // Update runtime info
    const info: ExtensionInfo = {
      manifest,
      state: ExtensionState.ACTIVATING,
      enabled: true,
      path: loaded.path,
      workflowIds: [],
      subscriptions: [],
    };
    this.registry.setRuntimeInfo(manifest.id, info);

    try {
      // Create extension context
      const storagePath = `${this.extensionStoragePath}/${manifest.id}`;
      const context = createExtensionContext({
        manifest,
        storagePath,
        grantedPermissions,
        eventBus: this.eventBus,
        storageBackend: this.storageBackend,
        aiBackend: this.aiBackend,
        settingsBackend: this.settingsBackend,
        uiBackend: this.uiBackend,
        mailBackend: this.mailBackend,
      });

      // Registered BEFORE activate() returns, because the extension makes host
      // calls from inside activate() and the bridge resolves those against
      // this map.
      this.activeExtensions.set(manifest.id, {
        manifest,
        context,
        state: ExtensionState.ACTIVATING,
      });

      // A panel-only extension has no module: there is nothing to run, so no
      // sandbox process is started for it. Its panels are served straight from
      // its folder and it is active the moment its context exists.
      if (entryPoint) {
        const bridge = await this.ensureBridge();
        const outcome = await bridge.activate({
          extensionId: manifest.id,
          manifest,
          entryPoint,
          storagePath,
          grantedPermissions,
          state: this.syncStateFor(manifest),
        });

        // The workflows the sandbox reported, re-registered here so each one
        // passes the real permission check before it can be scheduled. A
        // workflow main refuses is simply never adapted, and never runs.
        for (const descriptor of outcome.workflows) {
          const workflow = createRemoteWorkflow(bridge, manifest.id, descriptor);
          context.registerWorkflow(workflow);
        }

        // Functions the extension exposed to the app, as local callables.
        context.exports = createRemoteExports(bridge, manifest.id, outcome.exportNames);
      }

      const active = this.activeExtensions.get(manifest.id);
      if (active) active.state = ExtensionState.ACTIVE;

      // Create workflow adapters for registered workflows
      const workflows = context.getRegisteredWorkflows();
      for (const registered of workflows) {
        const adapter = new ExtensionWorkflowAdapter(
          registered.fullId,
          registered.workflow,
          context,
          manifest
        );
        this.workflowAdapters.set(registered.fullId, adapter);
        info.workflowIds.push(registered.fullId);
      }

      // Update runtime info
      info.state = ExtensionState.ACTIVE;
      info.activatedAt = Date.now();
      this.registry.setRuntimeInfo(manifest.id, info);

      logger.info(
        `Extension ${manifest.id} activated with ${workflows.length} workflows`
      );
    } catch (error) {
      // A failed activation must leave nothing behind: the sandbox already
      // dropped its half, and an entry kept here would make the next attempt
      // report the extension as already active.
      this.activeExtensions.delete(manifest.id);
      info.state = ExtensionState.ERROR;
      info.error = error instanceof Error ? error.message : String(error);
      this.registry.setRuntimeInfo(manifest.id, info);

      throw error;
    }
  }

  /**
   * Deactivate an extension
   */
  async deactivate(extensionId: string): Promise<void> {
    const active = this.activeExtensions.get(extensionId);
    if (!active) {
      return;
    }

    logger.info(`Deactivating extension: ${extensionId}`);

    // Update state
    const info = this.registry.getRuntimeInfo(extensionId);
    if (info) {
      info.state = ExtensionState.DEACTIVATING;
      this.registry.setRuntimeInfo(extensionId, info);
    }

    try {
      // The sandbox runs the extension's own deactivate(); it still needs its
      // context to answer host calls from inside that hook, so the entry here
      // is only removed once it has returned.
      if (this.bridge && !this.bridge.isClosed()) {
        await this.bridge.deactivate(extensionId);
      }

      // Read the workflow ids BEFORE disposing: `dispose()` clears the
      // context's registry, so reading after it finds nothing and every adapter
      // survives — a switched-off extension that keeps processing mail.
      const retiredWorkflowIds = active.context
        .getRegisteredWorkflows()
        .map((registered) => registered.fullId);

      // Cleanup context
      active.context.dispose();

      // Remove workflow adapters
      for (const fullId of retiredWorkflowIds) {
        this.workflowAdapters.delete(fullId);
      }

      // Remove from active
      this.activeExtensions.delete(extensionId);

      // Update runtime info
      if (info) {
        info.state = ExtensionState.DEACTIVATED;
        info.workflowIds = [];
        this.registry.setRuntimeInfo(extensionId, info);
      }

      logger.info(`Extension ${extensionId} deactivated`);
    } catch (error) {
      // Still torn down here whatever the extension's own hook did: a
      // deactivate() that throws must not leave a workflow wired to an
      // extension the user just switched off.
      this.activeExtensions.delete(extensionId);
      for (const adapter of this.getExtensionWorkflows(extensionId)) {
        this.workflowAdapters.delete(adapter.id);
      }
      if (info) {
        info.state = ExtensionState.ERROR;
        info.error = error instanceof Error ? error.message : String(error);
        info.workflowIds = [];
        this.registry.setRuntimeInfo(extensionId, info);
      }

      logger.error(`Error deactivating extension ${extensionId}:`, error);
    }
  }

  /**
   * Deactivate all extensions
   */
  async deactivateAll(): Promise<void> {
    const extensionIds = Array.from(this.activeExtensions.keys());

    for (const id of extensionIds) {
      await this.deactivate(id);
    }
  }

  /**
   * Reload an extension
   */
  async reload(extensionId: string): Promise<void> {
    await this.deactivate(extensionId);

    const loaded = this.registry.getLoaded(extensionId);
    const installed = this.registry.get(extensionId);

    if (loaded && installed && installed.enabled) {
      await this.activate(loaded, installed.grantedPermissions);
    }
  }

  /**
   * Get all active extension IDs
   */
  getActiveExtensionIds(): string[] {
    return Array.from(this.activeExtensions.keys());
  }

  /**
   * Check if an extension is active
   */
  isActive(extensionId: string): boolean {
    return this.activeExtensions.has(extensionId);
  }

  /**
   * Tell an extension what the reader did to one of its notification cards.
   *
   * Cards are the one surface an extension can raise without the reader asking
   * for it, and until this existed they were write-only — an extension could
   * put a verification code on screen but never learn it had been used. The
   * dispatch is deliberately unconditional: main does not track who subscribed,
   * the extension's own side drops the action when nobody is listening, so
   * there is no second copy of the subscription list to fall out of step.
   *
   * Errors are swallowed. This is called from a reader's click, and an
   * extension that has just been disabled — or whose handler throws — must not
   * turn a copy button into a visible failure.
   */
  async dispatchNotificationAction(extensionId: string, action: ExtensionUIAction): Promise<void> {
    const active = this.activeExtensions.get(extensionId);
    if (!active) return;

    try {
      // The in-process context holds the handlers when extensions run here;
      // the sandbox holds them when they run out of process. Both are asked,
      // and whichever has no subscribers does nothing.
      active.context.dispatchUIAction(action);
      if (this.bridge) {
        await this.bridge.invoke(extensionId, 'ui.action', [action]);
      }
    } catch (error) {
      logger.warn(
        `[ExtensionHost] ${extensionId} failed to handle card action '${action.action}':`,
        error
      );
    }
  }

  /**
   * Which active extension serves a capability, if any.
   *
   * The app asks for a FEATURE and gets whoever provides it. Ties are broken by
   * the declared priority and then by id, so the answer is stable across runs
   * rather than depending on activation order — an app feature that silently
   * changed hands between launches would be impossible to support.
   */
  findCapabilityProvider(capability: string): { extensionId: string; exportName: string } | null {
    const candidates: { extensionId: string; exportName: string; priority: number }[] = [];

    for (const [extensionId, active] of this.activeExtensions) {
      for (const contribution of active.manifest.contributes?.capabilities ?? []) {
        if (contribution?.id !== capability) continue;
        const exports = active.context.exports;
        // Declared but not actually exported: the manifest promised something
        // the code does not do. Skipping it lets a lower-priority extension
        // that DOES implement the capability still serve the app.
        if (typeof exports[contribution.export] !== 'function') continue;
        candidates.push({
          extensionId,
          exportName: contribution.export,
          priority: contribution.priority ?? 0,
        });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.priority - a.priority || a.extensionId.localeCompare(b.extensionId));
    const [best] = candidates;
    return { extensionId: best.extensionId, exportName: best.exportName };
  }

  /**
   * Get an extension's exported API
   * Returns the exports object set by the extension during activation
   */
  getExtensionExports<T = Record<string, unknown>>(extensionId: string): T | undefined {
    const active = this.activeExtensions.get(extensionId);
    if (!active) {
      return undefined;
    }
    // Local callables that forward into the sandbox; see `createRemoteExports`.
    return active.context.exports as T;
  }

  /**
   * Answer one request from an extension's panel.
   *
   * The renderer relays panel traffic but decides nothing: it holds the open
   * message and the panel's own frame, so a panel that could talk it into an
   * answer would have walked straight past the permission model. Every request
   * lands here, is checked against what the user actually granted, and is then
   * served through the extension's own context — the same object the sandbox's
   * host calls go through.
   *
   * Never throws. A refusal is a value the panel can render, and an error that
   * escaped here would be an unhandled rejection in an IPC handler.
   */
  async servePanelRequest(
    extensionId: string,
    request: PanelRequest,
    deps: PanelRequestDeps = {}
  ): Promise<PanelResponse> {
    const reply = (value: unknown): PanelResponse => ({
      requestId: request.requestId,
      ok: true,
      value,
    });
    const refuse = (error: string): PanelResponse => ({
      requestId: request.requestId,
      ok: false,
      error,
    });

    const active = this.activeExtensions.get(extensionId);
    if (!active || active.state !== ExtensionState.ACTIVE) {
      return refuse(`Extension ${extensionId} is not running`);
    }

    // A panel exists only because `ui:panel` was granted; losing that grant has
    // to stop the panel talking, not just stop it being shown next time.
    const context = active.context;
    if (!context.hasPermission('ui:panel')) {
      return refuse("Permission denied: Extension requires 'ui:panel' permission");
    }

    // Default deny: `panelRequestPermission` answers undefined for a method it
    // does not know, which is not the same as "needs no permission".
    const required = panelRequestPermission(request.method);
    if (required === undefined) {
      return refuse(`Unknown panel request: ${request.method}`);
    }
    if (required !== null && !context.hasPermission(required)) {
      return refuse(`Permission denied: Extension requires '${required}' permission`);
    }

    const params = (request.params ?? {}) as Record<string, unknown>;

    try {
      switch (request.method) {
        case 'message.current':
          // The app supplies this: the host has no idea what the reader is
          // looking at, and a panel must never be the one to say.
          return reply((await deps.getCurrentMessage?.()) ?? null);

        case 'storage.get':
          return reply(await context.storage.get(String(params.key)));
        case 'storage.set':
          await context.storage.set(String(params.key), params.value);
          return reply(undefined);
        case 'storage.delete':
          await context.storage.delete(String(params.key));
          return reply(undefined);
        case 'storage.keys':
          return reply(await context.storage.keys());

        case 'settings.get':
          return reply(context.settings.get(String(params.key)));
        case 'settings.all':
          return reply(this.readSettings(active.manifest));

        case 'exports.call': {
          const name = String(params.name);
          const callable = context.exports[name];
          if (typeof callable !== 'function') {
            return refuse(`${extensionId} exports no function named '${name}'`);
          }
          const args = Array.isArray(params.args) ? params.args : [];
          return reply(await (callable as (...a: unknown[]) => unknown)(...args));
        }

        case 'ui.notify':
          context.ui.notify(params as unknown as ExtensionUINotification);
          return reply(undefined);

        // The mail API, reached through the very same permission-checked
        // wrappers the extension's own code uses. The table in `panel-bridge`
        // has already refused anything the extension was not granted; these
        // call through, so there is no second implementation of what each
        // method means and no way for the two to drift apart.
        case 'mail.get':
          return reply(await context.mail.get(String(params.emailId)));
        case 'mail.folders':
          return reply(
            await context.mail.folders(
              params.accountId === undefined ? undefined : String(params.accountId)
            )
          );
        case 'mail.markRead':
          await context.mail.markRead(String(params.emailId));
          return reply(undefined);
        case 'mail.markUnread':
          await context.mail.markUnread(String(params.emailId));
          return reply(undefined);
        case 'mail.star':
          await context.mail.star(String(params.emailId));
          return reply(undefined);
        case 'mail.unstar':
          await context.mail.unstar(String(params.emailId));
          return reply(undefined);
        case 'mail.addLabel':
          await context.mail.addLabel(String(params.emailId), String(params.label));
          return reply(undefined);
        case 'mail.removeLabel':
          await context.mail.removeLabel(String(params.emailId), String(params.label));
          return reply(undefined);
        case 'mail.move':
          await context.mail.move(String(params.emailId), String(params.folderId));
          return reply(undefined);
        case 'mail.trash':
          await context.mail.trash(String(params.emailId));
          return reply(undefined);

        case 'panel.close':
        case 'panel.resize':
          // Handled entirely in the renderer — the app owns the frame. Answered
          // here only so a panel that forwards them anyway is not left hanging.
          return reply(undefined);
      }
    } catch (error) {
      logger.warn(`Panel request ${request.method} from ${extensionId} failed:`, error);
      return refuse(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Get workflow adapter by ID
   */
  getWorkflowAdapter(workflowId: string): ExtensionWorkflowAdapter | undefined {
    return this.workflowAdapters.get(workflowId);
  }

  /**
   * Get all workflow adapters
   */
  getAllWorkflowAdapters(): ExtensionWorkflowAdapter[] {
    return Array.from(this.workflowAdapters.values());
  }

  /**
   * Get workflow adapters for an extension
   */
  getExtensionWorkflows(extensionId: string): ExtensionWorkflowAdapter[] {
    return this.getAllWorkflowAdapters().filter(
      (adapter) => adapter.extensionId === extensionId
    );
  }

  /**
   * Process an email through all extension workflows.
   *
   * `stage` selects which workflows run. Bodies are fetched lazily after
   * `email:synced`, so the host makes two passes over a message: 'arrival' runs
   * every enabled workflow (a body-reading one still gets its shot at the
   * subject), and 'body' re-runs only those that asked for the body. Without
   * the split, the second pass would re-run header-only workflows for no
   * reason — doubling the per-message cost on every sync.
   */
  async processEmail(
    email: EmailRecord,
    context: WorkflowContext,
    stage: WorkflowStage = 'arrival'
  ): Promise<Map<string, WorkflowResult>> {
    const results = new Map<string, WorkflowResult>();

    // Get workflows sorted by priority
    const adapters = this.getAllWorkflowAdapters()
      .filter((a) => a.enabled)
      .filter((a) => (stage === 'body' ? a.requiresBody : true))
      .sort((a, b) => a.priority - b.priority);

    for (const adapter of adapters) {
      // Check abort signal
      if (context.abortSignal?.aborted) {
        break;
      }

      try {
        // Check if workflow should process
        const shouldProcess = await adapter.shouldProcess(email, context);
        if (!shouldProcess) {
          continue;
        }

        // Process
        const result = await adapter.process(email, context);
        results.set(adapter.id, result);

        // Apply modifications
        if (result.success && result.modifications) {
          Object.assign(email, result.modifications);
        }

        // Check skip remaining
        if (result.skipRemaining) {
          break;
        }
      } catch (error) {
        logger.error(`Workflow ${adapter.id} error:`, error);
        results.set(adapter.id, {
          success: false,
          error: error as Error,
        });
      }
    }

    return results;
  }

  /**
   * Cleanup and dispose
   */
  async dispose(): Promise<void> {
    await this.deactivateAll();
    this.workflowAdapters.clear();
    await this.bridge?.shutdown();
    this.bridge = null;
  }
}

/**
 * Adapter to convert extension workflows to standard EmailWorkflow interface
 */
export class ExtensionWorkflowAdapter implements EmailWorkflow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly requiresAI: boolean;
  readonly requiresBody: boolean;
  readonly runInBackground: boolean;
  enabled: boolean;

  readonly extensionId: string;

  private workflow: ExtensionWorkflow;
  private context: ExtensionContextImpl;

  constructor(
    fullId: string,
    workflow: ExtensionWorkflow,
    context: ExtensionContextImpl,
    manifest: ExtensionManifest
  ) {
    this.id = fullId;
    this.name = workflow.name;
    this.description = workflow.description || '';
    this.priority = workflow.priority ?? WorkflowPriority.NORMAL;
    this.requiresAI = workflow.requiresAI ?? false;
    this.requiresBody = workflow.requiresBody ?? false;
    this.runInBackground = workflow.runInBackground ?? false;
    this.enabled = workflow.enabled ?? true;

    this.extensionId = manifest.id;
    this.workflow = workflow;
    this.context = context;
  }

  /**
   * Check if workflow should process the email
   */
  async shouldProcess(email: EmailRecord, _context: WorkflowContext): Promise<boolean> {
    try {
      return await this.workflow.shouldProcess(email);
    } catch (error) {
      logger.error(`Error in shouldProcess for ${this.id}:`, error);
      return false;
    }
  }

  /**
   * Process the email
   */
  async process(email: EmailRecord, context: WorkflowContext): Promise<WorkflowResult> {
    const startTime = Date.now();

    try {
      // Create workflow execution context
      const execContext = this.context.createWorkflowContext(
        context.previousResults,
        context.abortSignal
      );

      // Call the extension workflow
      const result = await this.workflow.process(email, execContext);

      // Convert to standard result
      const standardResult = toWorkflowResult(result);
      standardResult.processingTime = Date.now() - startTime;

      return standardResult;
    } catch (error) {
      return {
        success: false,
        error: error as Error,
        processingTime: Date.now() - startTime,
      };
    }
  }
}

// Singleton instance
let globalHost: ExtensionHost | null = null;

/**
 * Initialize the global extension host
 */
export function initializeExtensionHost(options: ExtensionHostOptions): ExtensionHost {
  if (globalHost) {
    logger.warn('Extension host already initialized');
    return globalHost;
  }
  globalHost = new ExtensionHost(options);
  return globalHost;
}

/**
 * Get the global extension host
 */
export function getExtensionHost(): ExtensionHost | null {
  return globalHost;
}

/**
 * Create a new extension host (for testing or isolation)
 */
export function createExtensionHost(options: ExtensionHostOptions): ExtensionHost {
  return new ExtensionHost(options);
}
