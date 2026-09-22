/**
 * The sandbox side of the extension boundary.
 *
 * This is the only place extension code is ever executed. It runs in a separate
 * process (one shared by every extension — see `extension-runtime.ts` for why
 * not one each) and reaches the app solely by posting messages back to main.
 *
 * The context handed to `activate()` looks exactly like the in-process one an
 * extension was written against: same methods, same shapes, same
 * synchronous-vs-promise split. Everything that used to be a direct call is now
 * a round trip, except the three members that must answer synchronously —
 * `ai.isAvailable()`, `settings.get()` and `settings.has()` — which read a
 * mirror main pushes down and refreshes on change.
 *
 * Nothing here decides whether a call is allowed. Every host call is re-checked
 * against the real permission-checked context in main; the local checks below
 * exist so a mistake throws where the extension author wrote it, with a stack
 * that points at their code rather than at an IPC frame.
 */

import { createRequire } from 'module';

import type { PipelineEvent, EventHandler, Unsubscribe, WorkflowResult } from '../../pipeline/types';
import type { EmailRecord } from '../../types/models';
import type {
  AICategorizationResult,
  AICompletionOptions,
  ExtensionAI,
  ExtensionContext,
  ExtensionEventBus,
  ExtensionLogger,
  ExtensionMail,
  ExtensionMailFolder,
  ExtensionManifest,
  ExtensionPermission,
  ExtensionSettings,
  ExtensionStorage,
  ExtensionUI,
  ExtensionUIAction,
  ExtensionUIActionHandler,
  ExtensionUINotification,
  ExtensionWorkflow,
  ExtensionWorkflowResult,
  WorkflowExecutionContext,
} from '../types';

import {
  deserializeError,
  serializeError,
  type ExtensionChannel,
  type HostCallMethod,
  type HostToSandboxMessage,
  type SandboxActivationRequest,
  type SandboxSyncState,
  type SandboxToHostMessage,
  type SerializedWorkflowCall,
  type SerializedWorkflowResult,
  type WorkflowDescriptor,
} from './protocol';

/** What an extension module must export. */
export interface SandboxExtensionModule {
  activate(context: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Loads an extension's entry point. Swappable so tests need no files on disk. */
export type SandboxModuleLoader = (entryPoint: string) => SandboxExtensionModule;

/**
 * Load an extension with a `require` rooted at the extension's own entry point.
 *
 * Rooting it there rather than at this file is what lets a no-build extension
 * `require('./helpers')` and get the file next to it. The cache line above it
 * makes a reload actually re-read the source instead of handing back the copy
 * from the last activation.
 */
const defaultModuleLoader: SandboxModuleLoader = (entryPoint) => {
  const requireFromExtension = createRequire(entryPoint);
  delete requireFromExtension.cache[requireFromExtension.resolve(entryPoint)];
  return requireFromExtension(entryPoint) as SandboxExtensionModule;
};

/** Everything the sandbox holds for one activated extension. */
interface SandboxExtension {
  manifest: ExtensionManifest;
  module: SandboxExtensionModule;
  context: ExtensionContext;
  permissions: Set<ExtensionPermission>;
  state: SandboxSyncState;
  workflows: Map<string, ExtensionWorkflow>;
  eventHandlers: Map<string, EventHandler<PipelineEvent>>;
  /** `ui.onAction` subscribers. Main dispatches; these decide if anyone cares. */
  uiActionHandlers: Set<ExtensionUIActionHandler>;
  /**
   * False until `activate()` has returned. Workflows registered during
   * activation travel back in the `activated` message; anything registered
   * afterwards has to announce itself, or main would never build an adapter
   * for it and the workflow would silently never run.
   */
  activated: boolean;
}

export interface ExtensionSandbox {
  /** Tear everything down — used by the shutdown path and by tests. */
  dispose(): Promise<void>;
  /** Ids currently activated here. Exposed for assertions and diagnostics. */
  activeIds(): string[];
}

function permissionDenied(permission: ExtensionPermission, operation: string): Error {
  return new Error(
    `Permission denied: Extension requires '${permission}' permission for operation '${operation}'`
  );
}

/** Restore the `Error` that `WorkflowResult.error` is declared to hold. */
function reviveWorkflowResult(result: SerializedWorkflowResult): WorkflowResult {
  const { error, ...rest } = result;
  return {
    ...(rest as Omit<WorkflowResult, 'error'>),
    ...(error ? { error: deserializeError(error) } : {}),
  } as WorkflowResult;
}

/** Flatten a result so it survives the trip back to main. */
function flattenWorkflowResult(result: ExtensionWorkflowResult): SerializedWorkflowResult {
  const { error, ...rest } = result;
  return { ...rest, ...(error ? { error: serializeError(error) } : {}) };
}

/**
 * Start the sandbox on a channel.
 *
 * The channel is whatever the caller has: a `utilityProcess` message port in
 * the app, an in-memory pair in the tests. The engine is identical either way,
 * which is the point — a test exercises the same code the app runs, not a
 * simplified stand-in.
 */
export function startExtensionSandbox(
  channel: ExtensionChannel,
  loadModule: SandboxModuleLoader = defaultModuleLoader
): ExtensionSandbox {
  const extensions = new Map<string, SandboxExtension>();
  const pendingHostCalls = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /** Abort controllers for invokes main can still cancel. */
  const inFlight = new Map<string, AbortController>();
  let nextId = 0;
  let disposed = false;

  const send = (message: SandboxToHostMessage): void => channel.post(message);

  const newId = (prefix: string): string => `${prefix}-${++nextId}`;

  /** Ask main to do something on the extension's behalf, and await the answer. */
  const hostCall = (
    extensionId: string,
    method: HostCallMethod,
    args: unknown[]
  ): Promise<unknown> => {
    if (disposed) return Promise.reject(new Error('Extension sandbox is shutting down'));
    const requestId = newId('hc');
    return new Promise<unknown>((resolve, reject) => {
      pendingHostCalls.set(requestId, { resolve, reject });
      send({ type: 'host-call', requestId, extensionId, method, args });
    });
  };

  /**
   * Build the context an extension sees.
   *
   * Written as one function rather than a class so every closure captures the
   * extension it belongs to: there is no `this` to be re-bound, and no way for
   * one extension's context to be handed another's id.
   */
  function createSandboxContext(request: SandboxActivationRequest): {
    context: ExtensionContext;
    entry: SandboxExtension;
  } {
    const { extensionId, manifest, storagePath } = request;
    const permissions = new Set(request.grantedPermissions);
    const state: SandboxSyncState = {
      aiAvailable: request.state.aiAvailable,
      settings: { ...request.state.settings },
    };
    const workflows = new Map<string, ExtensionWorkflow>();
    const eventHandlers = new Map<string, EventHandler<PipelineEvent>>();
    const uiActionHandlers = new Set<ExtensionUIActionHandler>();

    const has = (permission: ExtensionPermission): boolean => permissions.has(permission);
    const require_ = (permission: ExtensionPermission, operation: string): void => {
      if (!has(permission)) throw permissionDenied(permission, operation);
    };

    const log: ExtensionLogger = {
      debug: (message, ...args) => sendLog('debug', message, args),
      info: (message, ...args) => sendLog('info', message, args),
      warn: (message, ...args) => sendLog('warn', message, args),
      error: (message, ...args) => sendLog('error', message, args),
    };

    /**
     * Extension logs are flattened to a string here rather than passed through.
     * An extension can log anything — a live socket, a cyclic object, a class
     * instance — and a structured-clone failure on a log line would take down
     * the message channel that the rest of the extension system depends on.
     */
    function sendLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, args: unknown[]): void {
      const rendered = args.length > 0 ? `${message} ${args.map(describe).join(' ')}` : message;
      send({ type: 'log', extensionId, level, message: rendered });
    }

    const storage: ExtensionStorage = {
      get: <T,>(key: string) => {
        require_('storage:local', 'storage.get');
        return hostCall(extensionId, 'storage.get', [key]) as Promise<T | undefined>;
      },
      set: <T,>(key: string, value: T) => {
        require_('storage:local', 'storage.set');
        return hostCall(extensionId, 'storage.set', [key, value]) as Promise<void>;
      },
      delete: (key: string) => {
        require_('storage:local', 'storage.delete');
        return hostCall(extensionId, 'storage.delete', [key]) as Promise<void>;
      },
      keys: () => {
        require_('storage:local', 'storage.keys');
        return hostCall(extensionId, 'storage.keys', []) as Promise<string[]>;
      },
      clear: () => {
        require_('storage:local', 'storage.clear');
        return hostCall(extensionId, 'storage.clear', []) as Promise<void>;
      },
    };

    const ai: ExtensionAI = {
      categorize: (email: EmailRecord) => {
        require_('ai:use', 'ai.categorize');
        require_('email:read', 'ai.categorize');
        return hostCall(extensionId, 'ai.categorize', [email]) as Promise<AICategorizationResult>;
      },
      generateReplySuggestions: (email: EmailRecord) => {
        require_('ai:use', 'ai.generateReplySuggestions');
        require_('email:read', 'ai.generateReplySuggestions');
        return hostCall(extensionId, 'ai.generateReplySuggestions', [email]) as Promise<string[]>;
      },
      summarize: (content: string) => {
        require_('ai:use', 'ai.summarize');
        return hostCall(extensionId, 'ai.summarize', [content]) as Promise<string>;
      },
      extractActionItems: (email: EmailRecord) => {
        require_('ai:use', 'ai.extractActionItems');
        require_('email:read', 'ai.extractActionItems');
        return hostCall(extensionId, 'ai.extractActionItems', [email]) as Promise<string[]>;
      },
      // Synchronous by contract, so it reads the mirror rather than the host.
      isAvailable: () => state.aiAvailable,
      complete: (options: AICompletionOptions) => {
        require_('ai:use', 'ai.complete');
        return hostCall(extensionId, 'ai.complete', [options]) as Promise<string>;
      },
    };

    const settings: ExtensionSettings = {
      get: (<T,>(key: string, defaultValue?: T): T | undefined => {
        require_('settings:read', 'settings.get');
        const value = state.settings[key] as T | undefined;
        return value !== undefined ? value : defaultValue;
      }) as ExtensionSettings['get'],
      update: (key: string, value: unknown) => {
        require_('settings:write', 'settings.update');
        // Mirror the write immediately so a read-after-write in the same tick
        // sees it; main pushes the authoritative value back either way.
        state.settings[key] = value;
        return hostCall(extensionId, 'settings.update', [key, value]) as Promise<void>;
      },
      has: (key: string) => {
        require_('settings:read', 'settings.has');
        return Object.prototype.hasOwnProperty.call(state.settings, key);
      },
    };

    const ui: ExtensionUI = {
      notify: (notification: ExtensionUINotification) => {
        require_('ui:notify', 'ui.notify');
        // Fire-and-forget, exactly as in-process: an extension must never be
        // able to stall the ingest path waiting on the window to answer.
        void hostCall(extensionId, 'ui.notify', [notification]).catch(() => undefined);
      },
      dismiss: (notificationId: string) => {
        require_('ui:notify', 'ui.dismiss');
        void hostCall(extensionId, 'ui.dismiss', [notificationId]).catch(() => undefined);
      },
      onAction: (handler: ExtensionUIActionHandler): Unsubscribe => {
        require_('ui:notify', 'ui.onAction');
        if (typeof handler !== 'function') throw new Error('ui.onAction expects a function');
        // Purely local: main dispatches every card action for this extension
        // and the sandbox decides whether anyone is listening. Registering
        // across the boundary would add a round trip and a second place for
        // the two sides to disagree about who is subscribed.
        uiActionHandlers.add(handler);
        return () => {
          uiActionHandlers.delete(handler);
        };
      },
      openPanel: (panelId: string) => {
        require_('ui:panel', 'ui.openPanel');
        void hostCall(extensionId, 'ui.openPanel', [panelId]).catch((error: Error) =>
          log.error(`Could not open panel ${panelId}: ${error.message}`)
        );
      },
      openMessage: (emailId: string, accountId?: string) => {
        require_('email:read', 'ui.openMessage');
        void hostCall(extensionId, 'ui.openMessage', [emailId, accountId]).catch(() => undefined);
      },
    };

    const mail: ExtensionMail = {
      get: (emailId: string) => {
        require_('email:read', 'mail.get');
        return hostCall(extensionId, 'mail.get', [emailId]) as Promise<EmailRecord | null>;
      },
      folders: (accountId?: string) => {
        require_('email:read', 'mail.folders');
        return hostCall(extensionId, 'mail.folders', [accountId]) as Promise<ExtensionMailFolder[]>;
      },
      markRead: (emailId: string) => applyLabels('markRead', emailId, { add: ['read'] }),
      markUnread: (emailId: string) => applyLabels('markUnread', emailId, { remove: ['read'] }),
      star: (emailId: string) => applyLabels('star', emailId, { add: ['starred'] }),
      unstar: (emailId: string) => applyLabels('unstar', emailId, { remove: ['starred'] }),
      addLabel: (emailId: string, label: string) =>
        applyLabels('addLabel', emailId, { add: [label] }, 'email:label'),
      removeLabel: (emailId: string, label: string) =>
        applyLabels('removeLabel', emailId, { remove: [label] }, 'email:label'),
      move: (emailId: string, folderId: string) => {
        require_('email:move', 'mail.move');
        return hostCall(extensionId, 'mail.move', [emailId, folderId]) as Promise<void>;
      },
      trash: (emailId: string) => {
        require_('email:delete', 'mail.trash');
        return hostCall(extensionId, 'mail.trash', [emailId]) as Promise<void>;
      },
    };

    /** The shared body of every label and flag change. */
    function applyLabels(
      operation: string,
      emailId: string,
      changes: { add?: string[]; remove?: string[] },
      permission: ExtensionPermission = 'email:flag'
    ): Promise<void> {
      require_(permission, `mail.${operation}`);
      return hostCall(extensionId, 'mail.applyLabels', [emailId, changes]) as Promise<void>;
    }

    const events: ExtensionEventBus = {
      on: <T extends PipelineEvent>(eventType: T['type'], handler: EventHandler<T>): Unsubscribe => {
        const subscriptionId = newId('sub');
        eventHandlers.set(subscriptionId, handler as EventHandler<PipelineEvent>);
        void hostCall(extensionId, 'events.subscribe', [eventType, subscriptionId, false]).catch(
          (error: Error) => log.error(`Could not subscribe to ${eventType}: ${error.message}`)
        );
        return () => {
          if (!eventHandlers.delete(subscriptionId)) return;
          void hostCall(extensionId, 'events.unsubscribe', [subscriptionId]).catch(() => undefined);
        };
      },
      once: <T extends PipelineEvent>(eventType: T['type'], handler: EventHandler<T>): void => {
        const subscriptionId = newId('sub');
        eventHandlers.set(subscriptionId, handler as EventHandler<PipelineEvent>);
        void hostCall(extensionId, 'events.subscribe', [eventType, subscriptionId, true]).catch(
          (error: Error) => log.error(`Could not subscribe to ${eventType}: ${error.message}`)
        );
      },
      emit: (event: PipelineEvent): void => {
        void hostCall(extensionId, 'events.emit', [event]).catch(() => undefined);
      },
    };

    const context: ExtensionContext = {
      manifest,
      storagePath,
      events,
      storage,
      // Absent, not throwing, when the permission was refused — an extension
      // tests `if (context.ai)` and must see the same answer it saw in-process.
      ai: has('ai:use') ? ai : undefined,
      settings,
      mail,
      ui,
      log,
      subscriptions: [],
      exports: {},
      registerWorkflow: (workflow: ExtensionWorkflow) => {
        require_('email:read', 'registerWorkflow');
        if (workflow.requiresAI) require_('ai:use', 'registerWorkflow (requiresAI)');
        const fullId = `${extensionId}.${workflow.id}`;
        if (workflows.has(fullId)) throw new Error(`Workflow '${fullId}' is already registered`);
        workflows.set(fullId, workflow);
        if (entry.activated) {
          void hostCall(extensionId, 'workflow.register', [descriptorFor(fullId, workflow)]).catch(
            (error: Error) => log.error(`Could not register workflow ${fullId}: ${error.message}`)
          );
        }
      },
      unregisterWorkflow: (workflowId: string) => {
        const fullId = workflowId.includes('.') ? workflowId : `${extensionId}.${workflowId}`;
        if (!workflows.delete(fullId)) return;
        void hostCall(extensionId, 'workflow.unregister', [fullId]).catch(() => undefined);
      },
    };

    const entry: SandboxExtension = {
      manifest,
      module: undefined as unknown as SandboxExtensionModule,
      context,
      permissions,
      state,
      workflows,
      eventHandlers,
      uiActionHandlers,
      activated: false,
    };

    return { context, entry };
  }

  /** Describe a log argument without risking a clone failure or a huge string. */
  function describe(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      const rendered = JSON.stringify(value);
      return rendered === undefined ? String(value) : rendered.slice(0, 2000);
    } catch {
      return String(value);
    }
  }

  function descriptorFor(fullId: string, workflow: ExtensionWorkflow): WorkflowDescriptor {
    return {
      fullId,
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      priority: workflow.priority,
      requiresAI: workflow.requiresAI,
      requiresBody: workflow.requiresBody,
      runInBackground: workflow.runInBackground,
      enabled: workflow.enabled,
    };
  }

  async function activate(requestId: string, request: SandboxActivationRequest): Promise<void> {
    const { extensionId, entryPoint } = request;
    if (extensions.has(extensionId)) {
      send({
        type: 'failed',
        requestId,
        error: serializeError(new Error(`Extension ${extensionId} is already active`)),
      });
      return;
    }

    try {
      const { context, entry } = createSandboxContext(request);
      const module = loadModule(entryPoint);
      if (typeof module.activate !== 'function') {
        throw new Error('Extension must export an activate function');
      }
      entry.module = module;
      // Registered BEFORE activate() so an extension that subscribes to events
      // or registers a workflow during activation has somewhere to put it.
      extensions.set(extensionId, entry);

      await module.activate(context);

      const workflows = Array.from(entry.workflows.entries()).map(([fullId, workflow]) =>
        descriptorFor(fullId, workflow)
      );
      entry.activated = true;
      send({
        type: 'activated',
        requestId,
        extensionId,
        workflows,
        exportNames: Object.keys(context.exports).filter(
          (name) => typeof context.exports[name] === 'function'
        ),
      });
    } catch (error) {
      // A half-activated extension must not be left behind: the host will mark
      // it errored, and a retry has to start from nothing.
      extensions.delete(extensionId);
      send({ type: 'failed', requestId, error: serializeError(error) });
    }
  }

  async function deactivate(requestId: string, extensionId: string): Promise<void> {
    const entry = extensions.get(extensionId);
    if (!entry) {
      send({ type: 'deactivated', requestId, extensionId });
      return;
    }
    extensions.delete(extensionId);
    try {
      if (entry.module?.deactivate) await entry.module.deactivate();
      for (const unsubscribe of entry.context.subscriptions) {
        try {
          unsubscribe();
        } catch {
          // Cleanup is best-effort: one bad disposer must not strand the rest.
        }
      }
      entry.workflows.clear();
      entry.eventHandlers.clear();
      send({ type: 'deactivated', requestId, extensionId });
    } catch (error) {
      send({ type: 'failed', requestId, error: serializeError(error) });
    }
  }

  async function invoke(
    requestId: string,
    extensionId: string,
    target: string,
    args: unknown[]
  ): Promise<void> {
    const entry = extensions.get(extensionId);
    if (!entry) {
      send({
        type: 'invoke-reply',
        requestId,
        ok: false,
        error: serializeError(new Error(`Extension ${extensionId} is not active`)),
      });
      return;
    }

    const controller = new AbortController();
    inFlight.set(requestId, controller);
    try {
      const value = await runTarget(entry, target, args, controller.signal);
      send({ type: 'invoke-reply', requestId, ok: true, value });
    } catch (error) {
      send({ type: 'invoke-reply', requestId, ok: false, error: serializeError(error) });
    } finally {
      inFlight.delete(requestId);
    }
  }

  async function runTarget(
    entry: SandboxExtension,
    target: string,
    args: unknown[],
    abortSignal: AbortSignal
  ): Promise<unknown> {
    switch (target) {
      case 'workflow.shouldProcess': {
        const [fullId, email] = args as [string, EmailRecord];
        const workflow = entry.workflows.get(fullId);
        if (!workflow) throw new Error(`Workflow '${fullId}' is not registered`);
        return await workflow.shouldProcess(email);
      }
      case 'workflow.process': {
        const [call] = args as [SerializedWorkflowCall];
        const workflow = entry.workflows.get(call.fullId);
        if (!workflow) throw new Error(`Workflow '${call.fullId}' is not registered`);
        const execContext: WorkflowExecutionContext = {
          ai: entry.context.ai,
          previousResults: new Map(
            call.previousResults.map(([id, result]) => [id, reviveWorkflowResult(result)])
          ),
          abortSignal,
          log: entry.context.log,
        };
        const result = await workflow.process(call.email, execContext);
        return flattenWorkflowResult(result);
      }
      case 'export.call': {
        const [name, callArgs] = args as [string, unknown[]];
        const fn = entry.context.exports[name];
        if (typeof fn !== 'function') {
          throw new Error(`Extension ${entry.manifest.id} exports no function '${name}'`);
        }
        return await (fn as (...rest: unknown[]) => unknown)(...callArgs);
      }
      case 'event.dispatch': {
        const [subscriptionId, event, once] = args as [string, PipelineEvent, boolean];
        const handler = entry.eventHandlers.get(subscriptionId);
        // Not an error: main may have already dispatched when the extension
        // unsubscribed, and a `once` handler is gone after the first delivery.
        if (!handler) return undefined;
        if (once) entry.eventHandlers.delete(subscriptionId);
        await handler(event);
        return undefined;
      }
      case 'ui.action': {
        const [action] = args as [ExtensionUIAction];
        // Every handler runs even when an earlier one throws: one extension
        // registering two handlers must not have the first silence the second.
        for (const handler of entry.uiActionHandlers) {
          try {
            await handler(action);
          } catch (error) {
            entry.context.log.error(
              `ui.onAction handler failed for '${action.action}': ${(error as Error).message}`
            );
          }
        }
        return undefined;
      }
      default:
        throw new Error(`Unknown sandbox target '${target}'`);
    }
  }

  function applySyncState(extensionId: string, patch: Partial<SandboxSyncState>): void {
    const entry = extensions.get(extensionId);
    if (!entry) return;
    if (patch.aiAvailable !== undefined) entry.state.aiAvailable = patch.aiAvailable;
    // Replaced wholesale, not merged: a key removed in main has to disappear
    // here too, or `settings.has()` keeps answering true for a deleted value.
    if (patch.settings !== undefined) entry.state.settings = { ...patch.settings };
  }

  channel.onMessage((raw) => {
    const message = raw as HostToSandboxMessage;
    switch (message?.type) {
      case 'activate':
        void activate(message.requestId, message.request);
        break;
      case 'deactivate':
        void deactivate(message.requestId, message.extensionId);
        break;
      case 'invoke':
        void invoke(message.requestId, message.extensionId, message.target, message.args);
        break;
      case 'abort':
        inFlight.get(message.requestId)?.abort();
        break;
      case 'host-reply': {
        const pending = pendingHostCalls.get(message.requestId);
        if (!pending) return;
        pendingHostCalls.delete(message.requestId);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(deserializeError(message.error ?? { name: 'Error', message: 'Host call failed' }));
        break;
      }
      case 'sync-state':
        applySyncState(message.extensionId, message.state);
        break;
      case 'shutdown':
        void dispose();
        break;
      default:
        break;
    }
  });

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const extensionId of Array.from(extensions.keys())) {
      await deactivate(newId('shutdown'), extensionId);
    }
    // Anything still waiting on main would hang forever once the channel is
    // gone; fail it loudly instead so the extension's catch block runs.
    for (const [requestId, pending] of pendingHostCalls) {
      pending.reject(new Error('Extension sandbox is shutting down'));
      pendingHostCalls.delete(requestId);
    }
    channel.close();
  }

  channel.onClose(() => {
    void dispose();
  });

  send({ type: 'ready' });

  return {
    dispose,
    activeIds: () => Array.from(extensions.keys()),
  };
}
