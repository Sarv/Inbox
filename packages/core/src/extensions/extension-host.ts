/**
 * Extension Host
 *
 * Owns extension lifecycle. Each extension's code runs in a sandbox of its own,
 * reached through its own `ExtensionBridge`; what stays here is everything that
 * decides what an extension is allowed to do.
 *
 * The split matters because the permission-checked `ExtensionContextImpl` is
 * still built here, per extension, from the permissions the user actually
 * granted — the sandbox holds no authority of its own, it asks. So a
 * compromised extension gets a sandbox with no filesystem, no database and no
 * network, and every request it makes is answered by the same checks that
 * guarded the in-process version.
 *
 * Workflows the sandbox reports are registered back through
 * `context.registerWorkflow`, so a workflow that skipped its permission check
 * on the far side is rejected here before it can ever run.
 */

import { join, relative, sep } from 'path';

import { EventBus } from '../pipeline/event-bus';
import type { WorkflowResult } from '../pipeline/types';
import { EmailWorkflow, WorkflowContext, WorkflowPriority } from '../pipeline/types';
import type { EmailRecord } from '../types/models';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/timeout';

import {
  createExtensionContext,
  ExtensionContextImpl,
  type ExtensionStorageBackend,
  type ExtensionAIBackend,
  type ExtensionSettingsBackend,
  type ExtensionUIBackend,
  type ExtensionMailBackend,
  type ExtensionNetworkBackend,
  type ExtensionSecurityBackend,
  toWorkflowResult,
} from './extension-api';
import type { LoadedExtension } from './extension-loader';
import type { ExtensionRegistry } from './extension-registry';
import { panelRequestPermission, type PanelRequest, type PanelResponse } from './panel-bridge';
import { ExtensionBridge } from './runtime/extension-bridge';
import { MAX_MESSAGE_BYTES, messageBytes } from './runtime/flood-budget';
import { createInProcessChannelPair } from './runtime/in-process-channel';
import { createNodeModuleLoader } from './runtime/node-module-loader';
import type {
  ExtensionChannel,
  SandboxCloseDetails,
  SandboxSyncState,
  SandboxTarget,
  WorkflowDescriptor,
} from './runtime/protocol';
import { createRemoteExports, createRemoteWorkflow } from './runtime/remote-proxies';
import { startExtensionSandbox } from './runtime/sandbox';
import { unsupportedNodeApiMessage } from './runtime/unsupported-node-api';
import {
  ExtensionState,
  type ExtensionManifest,
  type ExtensionPermission,
  type ExtensionInfo,
  type ExtensionWorkflow,
  type ExtensionUIAction,
  type ExtensionUINotification,
  type AntivirusScanSubmitOptions,
} from './types';

/**
 * Extension module interface (what the extension exports)
 */
export interface ExtensionModule {
  activate(context: ExtensionContextImpl): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * How long a sandbox gets to start and say it is ready.
 *
 * A sandbox that never does must surface as one failed activation, not as an
 * install that hangs with no error anywhere.
 */
export const SANDBOX_START_TIMEOUT_MS = 30_000;

/**
 * How long `activateAll` holds up the caller.
 *
 * The app waits for this before it opens its window. An extension that takes
 * longer, or hangs at load until its transport kills it, keeps activating in the
 * background: it should not be able to keep the mail from appearing.
 */
export const ACTIVATE_ALL_WAIT_MS = 3_000;

/**
 * How long to wait before starting a crashed extension again, one entry per attempt.
 * A crash can be anything: the OS reclaiming memory, a transient bug in the renderer. A
 * hang or a flood is the extension's own doing and gets no second try. Three, because an
 * extension that crashes on every start must end up visibly off, not cycling for ever.
 */
export const SANDBOX_RESTART_DELAYS_MS = [2_000, 15_000, 60_000] as const;

/** Running this long after a crash counts as having recovered: the attempts start over. */
export const SANDBOX_RESTART_FORGIVE_MS = 10 * 60 * 1000;

/** The longest piece of an extension's own name shown in the app's voice. */
export const MAX_NAME_ON_PROBLEM_CARD = 32;

/** The line in Settings for an extension whose code was held back at launch. */
export const EXTENSION_HELD_BACK =
  'Not started: Sarv Inbox closed unexpectedly while starting extensions. Turn extensions back on above when you are ready.';

/** What is left of an extension's name on a card shown without `ui:notify`. */
function nameOnCard(name: string): string {
  return name.length > MAX_NAME_ON_PROBLEM_CARD ? `${name.slice(0, MAX_NAME_ON_PROBLEM_CARD)}…` : name;
}

/** The card for an extension whose own code failed while starting. */
export const EXTENSION_FAILED_TO_START =
  'This extension could not start. Settings, Extensions has the details.';

/** What the app has to supply for the requests the host cannot answer alone. */
export interface PanelRequestDeps {
  /**
   * The message the reader currently has open, in whatever shape the app wants
   * a panel to see. Omitted when nothing is open.
   */
  getCurrentMessage?(): Promise<unknown>;
}

/**
 * Run the sandbox in this process, on an in-memory channel.
 *
 * The fallback when no channel factory is supplied: the CLI and the tests. It is
 * the same engine the desktop app runs inside a confined Worker, with Node's own
 * `require` to load with, so the tests exercise the shipping code. It confines
 * nothing: the desktop app always supplies a factory.
 */
function createInProcessSandboxChannel(target: SandboxTarget): ExtensionChannel {
  const { host, sandbox } = createInProcessChannelPair();
  startExtensionSandbox(sandbox, createNodeModuleLoader(target.rootDir));
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
  securityBackend?: ExtensionSecurityBackend;

  /** Network backend (omit for a host that gives extensions no network) */
  networkBackend?: ExtensionNetworkBackend;

  /** Base path for extension storage */
  extensionStoragePath: string;

  /**
   * Opens the channel to one extension's sandbox.
   *
   * The desktop app supplies one backed by a confined Electron renderer. Left
   * out, extensions run in an in-process sandbox instead — which is what the CLI
   * and the tests want, and confines nothing. Rejecting is how a host refuses to
   * run extension code at all: the reason reaches the user.
   */
  createChannel?: (target: SandboxTarget) => ExtensionChannel | Promise<ExtensionChannel>;
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
  private securityBackend?: ExtensionSecurityBackend;
  private networkBackend?: ExtensionNetworkBackend;
  private extensionStoragePath: string;

  private createChannel: (target: SandboxTarget) => ExtensionChannel | Promise<ExtensionChannel>;

  private activeExtensions: Map<string, ActiveExtension> = new Map();
  private workflowAdapters: Map<string, ExtensionWorkflowAdapter> = new Map();

  /** One sandbox per extension, and only for those with code to run. */
  private bridges: Map<string, ExtensionBridge> = new Map();

  /** What the user has been told about each extension since it last started. */
  private problemsShown: Map<string, string> = new Map();

  /** Crashed extensions being given another go. See `planRestart`. */
  private restarts: Map<
    string,
    { attempts: number; timer: ReturnType<typeof setTimeout> | null; startedAt: number }
  > = new Map();

  /** Enabled extensions whose code was not started at launch. See `activateAll`. */
  private heldBack: Set<string> = new Set();

  /** Contexts for panels of extensions whose code is not running. See `contextForPanel`. */
  private panelContexts: Map<string, ExtensionContextImpl> = new Map();

  constructor(options: ExtensionHostOptions) {
    this.registry = options.registry;
    this.eventBus = options.eventBus;
    this.storageBackend = options.storageBackend;
    this.aiBackend = options.aiBackend;
    this.settingsBackend = options.settingsBackend;
    this.uiBackend = options.uiBackend;
    this.mailBackend = options.mailBackend;
    this.securityBackend = options.securityBackend;
    this.networkBackend = options.networkBackend;
    this.extensionStoragePath = options.extensionStoragePath;
    this.createChannel = options.createChannel ?? createInProcessSandboxChannel;
  }

  /**
   * Start one extension's sandbox and the bridge to it.
   *
   * One each rather than one shared, for two things measured in the real runtime:
   * a Worker that runs its renderer out of memory crashes that whole renderer,
   * and two Workers of one origin read each other's IndexedDB and BroadcastChannel.
   * A shared sandbox also could not tell its extensions apart, because each would
   * be able to post on the channel in another's name.
   */
  private async startBridge(target: SandboxTarget): Promise<ExtensionBridge> {
    const { extensionId } = target;
    const channel = await this.createChannel(target);
    const bridge: ExtensionBridge = new ExtensionBridge({
      channel,
      extensionId,
      hooks: {
        getContext: (id) => this.activeExtensions.get(id)?.context,
        onWorkflowRegistered: (id, descriptor) => this.adoptWorkflow(id, descriptor),
        onWorkflowUnregistered: (id, fullId) => this.dropWorkflow(id, fullId),
        onSandboxClosed: (reason, details) =>
          this.handleSandboxLoss(extensionId, bridge, reason, details),
        onUnsupportedApi: (id, api) => this.reportProblem(id, unsupportedNodeApiMessage(api)),
      },
    });
    this.bridges.set(extensionId, bridge);
    await withTimeout(bridge.whenReady(), SANDBOX_START_TIMEOUT_MS, 'Extension sandbox did not start');
    return bridge;
  }

  /**
   * Close an extension's sandbox on purpose. Its closing is not a failure.
   *
   * @param hung it has already failed to answer: no time is spent asking it to wind down
   */
  private async retireBridge(extensionId: string, hung = false): Promise<void> {
    const bridge = this.bridges.get(extensionId);
    if (!bridge) return;
    // Forgotten first: that is what tells `handleSandboxLoss` this one was asked for.
    this.bridges.delete(extensionId);
    if (hung) await bridge.terminate('This extension was stopped.');
    else await bridge.shutdown();
  }

  /**
   * Say that an extension is not doing its job, where the user will see it.
   *
   * An extension that stops working at startup, before any window exists, would
   * otherwise be noticed days later as something that quietly no longer happens.
   * The line in Settings stays; the card is what makes anyone look. Once per problem
   * until it next starts: a workflow failing on every message would otherwise bring a
   * dismissed card back with each one.
   *
   * `message` must be the host's own words, never text from the extension: this card
   * is shown without `ui:notify`, in the app's voice.
   */
  private reportProblem(extensionId: string, message: string): void {
    const info = this.registry.getRuntimeInfo(extensionId);
    if (info) {
      info.error = message;
      this.registry.setRuntimeInfo(extensionId, info);
    }
    // Another attempt is on its way, so this may yet come to nothing. Settings has it.
    if (this.restarts.get(extensionId)?.timer) return;
    if (this.problemsShown.get(extensionId) === message) return;
    this.problemsShown.set(extensionId, message);
    const name = nameOnCard(info?.manifest.name ?? extensionId);
    try {
      this.uiBackend?.reportProblem?.(extensionId, {
        id: 'extension-problem',
        title: `${name} has a problem`,
        body: message,
      });
    } catch (error) {
      logger.warn(`Could not show a problem with ${extensionId}:`, error);
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
    const targets = extensionId
      ? [this.activeExtensions.get(extensionId)].filter(
          (active): active is ActiveExtension => active !== undefined
        )
      : Array.from(this.activeExtensions.values());
    for (const active of targets) {
      const bridge = this.bridges.get(active.manifest.id);
      if (!bridge || bridge.isClosed()) continue;
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
    const bridge = this.bridges.get(extensionId);
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
   * An extension's sandbox died.
   *
   * Nothing it was running is running any more, so its adapters have to go now:
   * left in place they would keep being handed every incoming message, each one
   * failing against a dead channel and turning one crash into a per-email error
   * for the rest of the session. A crash gets a few more tries (`planRestart`); anything
   * else stays down until something asks for it again — `reload` starts a new sandbox.
   * Every other extension is in a sandbox of its own and carries on.
   */
  private handleSandboxLoss(
    extensionId: string,
    bridge: ExtensionBridge,
    reason?: string,
    details?: SandboxCloseDetails
  ): void {
    // Closed on purpose, or an older sandbox of something since started again.
    if (this.bridges.get(extensionId) !== bridge) return;
    this.bridges.delete(extensionId);

    const active = this.activeExtensions.get(extensionId);
    if (!active) return;

    logger.error(`Extension sandbox stopped for ${extensionId}${reason ? `: ${reason}` : ''}`);
    active.context.revokeSecurityAccess();
    void this.revokeSecurity(extensionId);
    try {
      active.context.dispose();
    } catch {
      // Cleanup is best-effort; one bad disposer must not strand the rest.
    }
    this.activeExtensions.delete(extensionId);
    for (const adapter of this.getExtensionWorkflows(extensionId)) {
      this.workflowAdapters.delete(adapter.id);
    }
    const info = this.registry.getRuntimeInfo(extensionId);
    if (info) {
      info.state = ExtensionState.ERROR;
      info.workflowIds = [];
      this.registry.setRuntimeInfo(extensionId, info);
    }
    if (details?.transient) this.planRestart(extensionId);
    this.reportProblem(extensionId, reason ?? 'Extension sandbox stopped');
  }

  /**
   * Give a crashed extension another go, a bounded number of times.
   *
   * An extension that runs for a while after each start is recovering, not looping, so
   * its attempts start over. One that keeps crashing runs out, and only then does anyone
   * get a card: a crash that a restart quietly fixes is not worth interrupting a reader.
   */
  private planRestart(extensionId: string): void {
    const previous = this.restarts.get(extensionId);
    const recovered = previous && Date.now() - previous.startedAt > SANDBOX_RESTART_FORGIVE_MS;
    const attempts = previous && !recovered ? previous.attempts : 0;
    if (previous?.timer) clearTimeout(previous.timer);

    const delay = SANDBOX_RESTART_DELAYS_MS[attempts];
    const loaded = this.registry.getLoaded(extensionId);
    const installed = this.registry.get(extensionId);
    if (delay === undefined || !loaded || !installed?.enabled) {
      this.restarts.delete(extensionId);
      return;
    }

    const timer = setTimeout(() => {
      const state = this.restarts.get(extensionId);
      if (state) state.timer = null;
      void this.activate(loaded, installed.grantedPermissions).catch((error) => {
        logger.warn(`Restarting ${extensionId} failed:`, error);
      });
    }, delay);
    timer.unref?.();
    this.restarts.set(extensionId, { attempts: attempts + 1, timer, startedAt: Date.now() });
    logger.warn(`Restarting ${extensionId} in ${delay} ms, attempt ${attempts + 1}`);
  }

  private cancelRestart(extensionId: string): void {
    const state = this.restarts.get(extensionId);
    if (state?.timer) clearTimeout(state.timer);
    this.restarts.delete(extensionId);
  }

  /**
   * Activate all enabled extensions
   */
  async activateAll(options: { holdCode?: boolean } = {}): Promise<void> {
    const enabled = this.registry.filter({ enabled: true });

    // Together, so one that hangs at load holds up nobody but itself. A failure
    // here has already been recorded on the extension and reported to the user.
    const activations = enabled.map(async (ext) => {
      const loaded = this.registry.getLoaded(ext.id);
      if (!loaded) {
        logger.warn(`Extension ${ext.id} is enabled but not loaded`);
        return;
      }

      // A panel-only extension has no code, so nothing about it can be what is
      // bringing the app down. Everything about the rest stays as the user left it.
      if (options.holdCode && loaded.entryPoint) {
        this.holdBack(loaded);
        return;
      }

      try {
        await this.activate(loaded, ext.grantedPermissions);
      } catch (error) {
        logger.error(`Failed to activate extension ${ext.id}:`, error);
      }
    });

    try {
      await withTimeout(
        Promise.all(activations),
        ACTIVATE_ALL_WAIT_MS,
        'still starting; carrying on without waiting'
      );
    } catch (error) {
      logger.warn(`Extensions: ${(error as Error).message}`);
    }

    logger.info(`Activated ${this.activeExtensions.size} extensions`);
  }

  private holdBack(loaded: LoadedExtension): void {
    this.heldBack.add(loaded.manifest.id);
    this.registry.setRuntimeInfo(loaded.manifest.id, {
      manifest: loaded.manifest,
      state: ExtensionState.ERROR,
      enabled: true,
      path: loaded.path,
      error: EXTENSION_HELD_BACK,
      heldBack: true,
      workflowIds: [],
      subscriptions: [],
    });
  }

  /** The extensions whose code was held back at launch and has not been started since. */
  getHeldBack(): string[] {
    return Array.from(this.heldBack);
  }

  /**
   * Start what was held back at launch. The user asked for this, so failures are theirs
   * to see on each extension, as with any activation.
   */
  async startHeldBack(): Promise<void> {
    const ids = this.getHeldBack();
    await Promise.all(
      ids.map(async (id) => {
        const loaded = this.registry.getLoaded(id);
        const installed = this.registry.get(id);
        this.heldBack.delete(id);
        if (!loaded || !installed?.enabled) return;
        await this.activate(loaded, installed.grantedPermissions).catch((error) => {
          logger.error(`Failed to activate extension ${id}:`, error);
        });
      })
    );
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

    this.problemsShown.delete(manifest.id);
    this.heldBack.delete(manifest.id);
    this.panelContexts.delete(manifest.id);
    const restart = this.restarts.get(manifest.id);
    if (restart?.timer) {
      clearTimeout(restart.timer);
      restart.timer = null;
    }
    /** Past this point a failure's text comes from the extension's own code. */
    let sandboxStarted = false;

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
      const context = createExtensionContext({
        manifest,
        storagePath: join(this.extensionStoragePath, manifest.id),
        grantedPermissions,
        eventBus: this.eventBus,
        storageBackend: this.storageBackend,
        aiBackend: this.aiBackend,
        settingsBackend: this.settingsBackend,
        uiBackend: this.uiBackend,
        mailBackend: this.mailBackend,
        securityBackend: this.securityBackend,
        networkBackend: this.networkBackend,
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
      // sandbox is started for it. Its panels are served straight from
      // its folder and it is active the moment its context exists.
      if (entryPoint) {
        const bridge = await this.startBridge({
          extensionId: manifest.id,
          rootDir: loaded.path,
          entryPoint,
        });
        sandboxStarted = true;
        const outcome = await bridge.activate({
          extensionId: manifest.id,
          manifest,
          // Nothing absolute crosses: a real path would name the user's home
          // directory to code with no other way to learn it.
          entryPoint: relative(loaded.path, entryPoint).split(sep).join('/'),
          storagePath: `/extension-storage/${manifest.id}`,
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
      // A failed activation must leave nothing behind: an entry kept here would
      // make the next attempt report the extension as already active, and its
      // sandbox has nothing left to run.
      this.activeExtensions.get(manifest.id)?.context.revokeSecurityAccess();
      await this.revokeSecurity(manifest.id);
      this.activeExtensions.delete(manifest.id);
      await this.retireBridge(manifest.id);
      const message = error instanceof Error ? error.message : String(error);
      info.state = ExtensionState.ERROR;
      this.registry.setRuntimeInfo(manifest.id, info);
      if (!sandboxStarted) {
        // The host refused or could not start it, and says why.
        this.reportProblem(manifest.id, message);
      } else if (!this.problemsShown.has(manifest.id)) {
        // Its own code threw, so the card keeps to the app's words: an extension must
        // not be able to put a sentence of its choosing on screen just by failing.
        this.reportProblem(manifest.id, EXTENSION_FAILED_TO_START);
      }
      // Settings says what the error really was, as it always has.
      info.error = message;
      this.registry.setRuntimeInfo(manifest.id, info);

      throw error;
    }
  }

  /**
   * Deactivate an extension
   */
  async deactivate(extensionId: string): Promise<void> {
    this.cancelRestart(extensionId);
    this.heldBack.delete(extensionId);
    this.panelContexts.delete(extensionId);
    const active = this.activeExtensions.get(extensionId);
    active?.context.revokeSecurityAccess();
    await this.revokeSecurity(extensionId);
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
      const bridge = this.bridges.get(extensionId);
      if (bridge && !bridge.isClosed()) {
        await bridge.deactivate(extensionId);
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

      // Nothing else runs in that sandbox, so it goes with the extension.
      await this.retireBridge(extensionId);
      this.problemsShown.delete(extensionId);

      // Update runtime info
      if (info) {
        info.state = ExtensionState.DEACTIVATED;
        // A problem it had while running is not a problem with something switched off.
        info.error = undefined;
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
      // Its hook hung or threw: asking it again would only make the reader wait again.
      await this.retireBridge(extensionId, true);
      if (info) {
        info.state = ExtensionState.ERROR;
        info.error = error instanceof Error ? error.message : String(error);
        info.workflowIds = [];
        this.registry.setRuntimeInfo(extensionId, info);
      }

      logger.error(`Error deactivating extension ${extensionId}:`, error);
    }
  }

  private async revokeSecurity(extensionId: string): Promise<void> {
    try {
      await this.securityBackend?.onExtensionDeactivated?.(extensionId);
    } catch (error) {
      logger.error(`Error revoking scanner access for ${extensionId}:`, error);
    }
  }

  /**
   * Deactivate all extensions
   */
  async deactivateAll(): Promise<void> {
    // Together, because the app is usually quitting: a `deactivate()` that hangs
    // costs one grace period, not one each.
    const extensionIds = Array.from(this.activeExtensions.keys());
    await Promise.all(extensionIds.map((id) => this.deactivate(id)));
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
      await this.bridges.get(extensionId)?.invoke(extensionId, 'ui.action', [action]);
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
   * The context a panel's requests are served through.
   *
   * A panel page runs in the window, and nothing about it needs the extension's code to
   * be running. An extension whose sandbox crashed, was refused or was held back must not
   * lose its panel with it: for the antivirus extension that panel is where setup is
   * reached, and a dead end there leaves the user unable to fix anything. So the panel
   * gets a context of its own, built from what is installed and granted, exactly as an
   * activation would build it. Only `exports.call` needs the code, and says so.
   */
  private contextForPanel(extensionId: string): ExtensionContextImpl | undefined {
    const active = this.activeExtensions.get(extensionId);
    if (active?.state === ExtensionState.ACTIVE) return active.context;

    const installed = this.registry.get(extensionId);
    const loaded = this.registry.getLoaded(extensionId);
    if (!installed?.enabled || !loaded) return undefined;

    let context = this.panelContexts.get(extensionId);
    if (!context) {
      context = createExtensionContext({
        manifest: loaded.manifest,
        storagePath: join(this.extensionStoragePath, extensionId),
        grantedPermissions: installed.grantedPermissions,
        eventBus: this.eventBus,
        storageBackend: this.storageBackend,
        aiBackend: this.aiBackend,
        settingsBackend: this.settingsBackend,
        uiBackend: this.uiBackend,
        mailBackend: this.mailBackend,
        securityBackend: this.securityBackend,
        networkBackend: this.networkBackend,
      });
      this.panelContexts.set(extensionId, context);
    }
    return context;
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

    const context = this.contextForPanel(extensionId);
    if (!context) {
      return refuse(`Extension ${extensionId} is not running`);
    }

    // A panel exists only because `ui:panel` was granted; losing that grant has
    // to stop the panel talking, not just stop it being shown next time.
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

    // A panel is a stranger's code as well, with no sandbox to stop, so this one is refused.
    // It stops here, and not in each case below, because any of them may stringify what it
    // is given, and that takes the whole app down: see MAX_MESSAGE_BYTES.
    if (messageBytes(request) > MAX_MESSAGE_BYTES) {
      return refuse('This request is too large');
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
          return reply(this.readSettings(context.manifest));

        case 'exports.call': {
          const name = String(params.name);
          const callable = context.exports[name];
          if (!this.activeExtensions.has(extensionId)) {
            const why = this.registry.getRuntimeInfo(extensionId)?.error;
            return refuse(`${extensionId}'s background code is not running${why ? `: ${why}` : ''}`);
          }
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
        case 'security.getTargets':
          return reply(await context.security.getTargets());
        case 'security.getSetup':
          return reply(await context.security.getSetup());
        case 'security.openSetup':
          await context.security.openSetup();
          return reply(undefined);
        case 'security.submit':
          return reply(await context.security.submit(
            params.targetIds as string[], params.options as AntivirusScanSubmitOptions | undefined
          ));
        case 'security.get':
          return reply(await context.security.get(params.jobId as string));
        case 'security.cancel':
          return reply(await context.security.cancel(params.jobId as string));
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
    for (const id of Array.from(this.restarts.keys())) this.cancelRestart(id);
    await this.deactivateAll();
    this.workflowAdapters.clear();
    await Promise.all(Array.from(this.bridges.keys()).map((id) => this.retireBridge(id)));
    await this.securityBackend?.dispose?.();
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
