/**
 * Extension API
 *
 * Provides the sandboxed API surface exposed to extensions.
 * All operations are permission-checked before execution.
 */

/* eslint-disable @typescript-eslint/no-this-alias --
 * The API/event-bus objects returned below use method shorthand (not arrow
 * functions), so `this` inside them refers to the returned object, not this
 * class. Aliasing the instance (`const context = this`) is the intended way for
 * those methods to reach the class — so the alias is deliberate here. */

import { EventBus } from '../pipeline/event-bus';
import type { PipelineEvent, EventHandler, Unsubscribe, WorkflowResult } from '../pipeline/types';
import type { EmailRecord } from '../types/models';
import { logger } from '../utils/logger';

import type {
  ExtensionContext,
  ExtensionManifest,
  ExtensionPermission,
  ExtensionWorkflow,
  ExtensionEventBus,
  ExtensionStorage,
  ExtensionAI,
  ExtensionSettings,
  ExtensionMail,
  ExtensionMailFolder,
  ExtensionUI,
  ExtensionUIAction,
  ExtensionUIActionHandler,
  ExtensionUINotification,
  ExtensionLogger,
  WorkflowExecutionContext,
  ExtensionWorkflowResult,
  AICategorizationResult,
} from './types';


/**
 * Creates a permission error
 */
function permissionError(permission: ExtensionPermission, operation: string): Error {
  return new Error(
    `Permission denied: Extension requires '${permission}' permission for operation '${operation}'`
  );
}

/**
 * Options for creating an extension context
 */
export interface ExtensionContextOptions {
  manifest: ExtensionManifest;
  storagePath: string;
  grantedPermissions: ExtensionPermission[];
  eventBus: EventBus;
  storageBackend: ExtensionStorageBackend;
  aiBackend?: ExtensionAIBackend;
  settingsBackend: ExtensionSettingsBackend;
  uiBackend?: ExtensionUIBackend;
  mailBackend?: ExtensionMailBackend;
}

/**
 * Storage backend interface (implemented by host)
 */
export interface ExtensionStorageBackend {
  get<T>(extensionId: string, key: string): Promise<T | undefined>;
  set<T>(extensionId: string, key: string, value: T): Promise<void>;
  delete(extensionId: string, key: string): Promise<void>;
  keys(extensionId: string): Promise<string[]>;
  clear(extensionId: string): Promise<void>;
}

/**
 * AI backend interface (implemented by host)
 */
export interface ExtensionAIBackend {
  categorize(email: EmailRecord): Promise<AICategorizationResult>;
  generateReplySuggestions(email: EmailRecord): Promise<string[]>;
  summarize(content: string): Promise<string>;
  extractActionItems(email: EmailRecord): Promise<string[]>;
  isAvailable(): boolean;
  complete(options: { systemPrompt: string; userPrompt: string; maxTokens?: number }): Promise<string>;
}

/**
 * UI notification backend interface (implemented by host)
 */
export interface ExtensionUIBackend {
  notify(extensionId: string, notification: ExtensionUINotification): void;
  dismiss(extensionId: string, notificationId: string): void;

  /** Open one of this extension's declared panels. */
  openPanel?(extensionId: string, panelId: string): void;

  /** Bring a message on screen in the reader's window. */
  openMessage?(extensionId: string, emailId: string, accountId?: string): void;
}

/**
 * Mail backend interface (implemented by host)
 *
 * The host implements the effects; the permission rules stay here, so an
 * embedder cannot accidentally ship a backend that skips them. Each method is
 * reached only through the matching `context.mail` wrapper, which has already
 * checked the permission against what the user granted.
 */
export interface ExtensionMailBackend {
  get(extensionId: string, emailId: string): Promise<EmailRecord | null>;
  folders(extensionId: string, accountId?: string): Promise<ExtensionMailFolder[]>;

  /**
   * Apply label and flag changes to one message.
   *
   * One method rather than six because the host applies them through the same
   * planner a workflow result goes through — the tag rules, the read/starred
   * server push and the refusal of unsyncable flags are written once and
   * cannot drift between the two paths.
   */
  applyLabels(
    extensionId: string,
    emailId: string,
    changes: { add?: string[]; remove?: string[] }
  ): Promise<void>;

  move(extensionId: string, emailId: string, folderId: string): Promise<void>;
  trash(extensionId: string, emailId: string): Promise<void>;
}

/**
 * Settings backend interface (implemented by host)
 */
export interface ExtensionSettingsBackend {
  get<T>(extensionId: string, key: string): T | undefined;
  update(extensionId: string, key: string, value: unknown): Promise<void>;
  has(extensionId: string, key: string): boolean;

  /**
   * Every key this extension currently has a value for.
   *
   * Optional so an embedder with a fixed settings schema need not implement it.
   * The out-of-process runtime uses it to mirror settings into the sandbox
   * exactly: `settings.get()` and `settings.has()` answer synchronously there,
   * off that mirror, and without this the mirror can only carry the keys the
   * manifest declared — so a value written under an undeclared key would read
   * back as missing.
   */
  keys?(extensionId: string): string[];
}

/**
 * Registered workflow with full metadata
 */
export interface RegisteredWorkflow {
  extensionId: string;
  workflow: ExtensionWorkflow;
  fullId: string;
}

/**
 * Creates a sandboxed extension context
 */
export function createExtensionContext(options: ExtensionContextOptions): ExtensionContextImpl {
  return new ExtensionContextImpl(options);
}

/**
 * Implementation of ExtensionContext with permission checking
 */
export class ExtensionContextImpl implements ExtensionContext {
  readonly manifest: ExtensionManifest;
  readonly storagePath: string;
  readonly events: ExtensionEventBus;
  readonly storage: ExtensionStorage;
  readonly ai?: ExtensionAI;
  readonly settings: ExtensionSettings;
  readonly mail: ExtensionMail;
  readonly ui: ExtensionUI;
  readonly log: ExtensionLogger;
  subscriptions: Unsubscribe[] = [];

  /** Extension exports - API exposed to the host application */
  exports: Record<string, unknown> = {};

  private grantedPermissions: Set<ExtensionPermission>;
  private registeredWorkflows: Map<string, RegisteredWorkflow> = new Map();
  /** `ui.onAction` subscribers, in registration order. */
  private uiActionHandlers: Set<ExtensionUIActionHandler> = new Set();

  constructor(private options: ExtensionContextOptions) {
    this.manifest = options.manifest;
    this.storagePath = options.storagePath;
    this.grantedPermissions = new Set(options.grantedPermissions);

    // Create permission-checked event bus
    this.events = this.createEventBus();

    // Create permission-checked storage
    this.storage = this.createStorage();

    // Create permission-checked AI (if permission granted and backend available)
    if (this.hasPermission('ai:use') && options.aiBackend) {
      this.ai = this.createAI();
    }

    // Create permission-checked settings
    this.settings = this.createSettings();

    // Create permission-checked mail access
    this.mail = this.createMail();

    // Create permission-checked UI notifications
    this.ui = this.createUI();

    // Create logger
    this.log = this.createLogger();
  }

  /**
   * Check if a permission is granted
   */
  hasPermission(permission: ExtensionPermission): boolean {
    return this.grantedPermissions.has(permission);
  }

  /**
   * Require a permission, throwing if not granted
   */
  requirePermission(permission: ExtensionPermission, operation: string): void {
    if (!this.hasPermission(permission)) {
      throw permissionError(permission, operation);
    }
  }

  /**
   * Register a workflow
   */
  registerWorkflow(workflow: ExtensionWorkflow): void {
    // Require email:read for any workflow
    this.requirePermission('email:read', 'registerWorkflow');

    // If workflow uses AI, require ai:use permission
    if (workflow.requiresAI) {
      this.requirePermission('ai:use', 'registerWorkflow (requiresAI)');
    }

    // Create full ID with extension prefix
    const fullId = `${this.manifest.id}.${workflow.id}`;

    if (this.registeredWorkflows.has(fullId)) {
      throw new Error(`Workflow '${fullId}' is already registered`);
    }

    const registered: RegisteredWorkflow = {
      extensionId: this.manifest.id,
      workflow,
      fullId,
    };

    this.registeredWorkflows.set(fullId, registered);
    this.log.info(`Registered workflow: ${fullId}`);
  }

  /**
   * Unregister a workflow
   */
  unregisterWorkflow(workflowId: string): void {
    const fullId = workflowId.includes('.') ? workflowId : `${this.manifest.id}.${workflowId}`;

    if (this.registeredWorkflows.has(fullId)) {
      this.registeredWorkflows.delete(fullId);
      this.log.info(`Unregistered workflow: ${fullId}`);
    }
  }

  /**
   * Get all registered workflows
   */
  getRegisteredWorkflows(): RegisteredWorkflow[] {
    return Array.from(this.registeredWorkflows.values());
  }

  /**
   * Get a registered workflow by ID
   */
  getWorkflow(workflowId: string): RegisteredWorkflow | undefined {
    const fullId = workflowId.includes('.') ? workflowId : `${this.manifest.id}.${workflowId}`;
    return this.registeredWorkflows.get(fullId);
  }

  /**
   * Create workflow execution context
   */
  createWorkflowContext(
    previousResults: Map<string, WorkflowResult>,
    abortSignal?: AbortSignal
  ): WorkflowExecutionContext {
    return {
      ai: this.ai,
      previousResults,
      abortSignal,
      log: this.log,
    };
  }

  /**
   * Cleanup all resources
   */
  dispose(): void {
    // Unsubscribe from all events
    for (const unsubscribe of this.subscriptions) {
      try {
        unsubscribe();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.subscriptions = [];

    // Clear workflows
    this.registeredWorkflows.clear();

    // Drop card-action subscribers, so a card still on screen when an
    // extension is disabled cannot call back into code that has gone away.
    this.uiActionHandlers.clear();
  }

  /**
   * Create permission-checked event bus wrapper
   */
  private createEventBus(): ExtensionEventBus {
    const eventBus = this.options.eventBus;
    const context = this;

    return {
      on<T extends PipelineEvent>(eventType: T['type'], handler: EventHandler<T>): Unsubscribe {
        const unsubscribe = eventBus.on(eventType, handler);
        context.subscriptions.push(unsubscribe);
        return unsubscribe;
      },

      once<T extends PipelineEvent>(eventType: T['type'], handler: EventHandler<T>): void {
        // Track the unsubscribe so dispose() detaches a `once` handler that
        // never fired — otherwise it lingers on the shared bus past the
        // extension's lifetime (mirrors on() above).
        const unsubscribe = eventBus.once(eventType, handler);
        context.subscriptions.push(unsubscribe);
      },

      emit(event: PipelineEvent): void {
        // Extensions can emit workflow events
        eventBus.emit(event);
      },
    };
  }

  /**
   * Create permission-checked storage wrapper
   */
  private createStorage(): ExtensionStorage {
    const backend = this.options.storageBackend;
    const extensionId = this.manifest.id;
    const context = this;

    return {
      async get<T>(key: string): Promise<T | undefined> {
        context.requirePermission('storage:local', 'storage.get');
        return backend.get<T>(extensionId, key);
      },

      async set<T>(key: string, value: T): Promise<void> {
        context.requirePermission('storage:local', 'storage.set');
        return backend.set(extensionId, key, value);
      },

      async delete(key: string): Promise<void> {
        context.requirePermission('storage:local', 'storage.delete');
        return backend.delete(extensionId, key);
      },

      async keys(): Promise<string[]> {
        context.requirePermission('storage:local', 'storage.keys');
        return backend.keys(extensionId);
      },

      async clear(): Promise<void> {
        context.requirePermission('storage:local', 'storage.clear');
        return backend.clear(extensionId);
      },
    };
  }

  /**
   * Create permission-checked AI wrapper
   */
  private createAI(): ExtensionAI {
    const backend = this.options.aiBackend!;
    const context = this;

    return {
      async categorize(email: EmailRecord): Promise<AICategorizationResult> {
        context.requirePermission('ai:use', 'ai.categorize');
        context.requirePermission('email:read', 'ai.categorize');
        return backend.categorize(email);
      },

      async generateReplySuggestions(email: EmailRecord): Promise<string[]> {
        context.requirePermission('ai:use', 'ai.generateReplySuggestions');
        context.requirePermission('email:read', 'ai.generateReplySuggestions');
        return backend.generateReplySuggestions(email);
      },

      async summarize(content: string): Promise<string> {
        context.requirePermission('ai:use', 'ai.summarize');
        return backend.summarize(content);
      },

      async extractActionItems(email: EmailRecord): Promise<string[]> {
        context.requirePermission('ai:use', 'ai.extractActionItems');
        context.requirePermission('email:read', 'ai.extractActionItems');
        return backend.extractActionItems(email);
      },

      isAvailable(): boolean {
        return backend.isAvailable();
      },

      async complete(options: { systemPrompt: string; userPrompt: string; maxTokens?: number }): Promise<string> {
        context.requirePermission('ai:use', 'ai.complete');
        return backend.complete(options);
      },
    };
  }

  /**
   * Create permission-checked settings wrapper
   */
  private createSettings(): ExtensionSettings {
    const backend = this.options.settingsBackend;
    const extensionId = this.manifest.id;
    const context = this;

    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        context.requirePermission('settings:read', 'settings.get');
        const value = backend.get<T>(extensionId, key);
        return value !== undefined ? value : defaultValue;
      },

      async update(key: string, value: unknown): Promise<void> {
        context.requirePermission('settings:write', 'settings.update');
        return backend.update(extensionId, key, value);
      },

      has(key: string): boolean {
        context.requirePermission('settings:read', 'settings.has');
        return backend.has(extensionId, key);
      },
    };
  }

  /**
   * Create permission-checked UI notification wrapper.
   *
   * Notifications are fire-and-forget by design: an extension must not be able
   * to block the ingest path waiting on the renderer, and a window that is
   * closed or still booting is a normal state, not an error. When no backend is
   * wired (headless tests, a host that renders no UI) the calls are no-ops.
   */
  private createUI(): ExtensionUI {
    const backend = this.options.uiBackend;
    const extensionId = this.manifest.id;
    const context = this;

    return {
      notify(notification: ExtensionUINotification): void {
        context.requirePermission('ui:notify', 'ui.notify');
        if (!backend) return;
        backend.notify(extensionId, notification);
      },

      dismiss(notificationId: string): void {
        context.requirePermission('ui:notify', 'ui.dismiss');
        if (!backend) return;
        backend.dismiss(extensionId, notificationId);
      },

      onAction(handler: ExtensionUIActionHandler): Unsubscribe {
        context.requirePermission('ui:notify', 'ui.onAction');
        if (typeof handler !== 'function') {
          throw new Error('ui.onAction expects a function');
        }
        context.uiActionHandlers.add(handler);
        return () => {
          context.uiActionHandlers.delete(handler);
        };
      },

      openPanel(panelId: string): void {
        context.requirePermission('ui:panel', 'ui.openPanel');
        // An extension may only open a panel it declared. Without this an
        // extension with `ui:panel` could open ANOTHER extension's panel and
        // put a surface the reader trusts on screen at a moment of its own
        // choosing.
        const declared = context.manifest.contributes?.panels ?? [];
        if (!declared.some((panel) => panel.id === panelId)) {
          throw new Error(`Extension ${extensionId} declares no panel '${panelId}'`);
        }
        backend?.openPanel?.(extensionId, panelId);
      },

      openMessage(emailId: string, accountId?: string): void {
        context.requirePermission('email:read', 'ui.openMessage');
        backend?.openMessage?.(extensionId, emailId, accountId);
      },
    };
  }

  /**
   * Deliver a card action to this extension's `ui.onAction` subscribers.
   *
   * Called by the host when the reader copies, dismisses or opens one of this
   * extension's cards. Handlers are run for their effects and their results
   * discarded: a handler that throws or rejects is logged and the rest still
   * run, because one extension's bad handler must not swallow the notification
   * for its own siblings.
   */
  dispatchUIAction(action: ExtensionUIAction): void {
    for (const handler of this.uiActionHandlers) {
      try {
        const result = handler(action);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch((error: unknown) => {
            logger.warn(
              `[Extension:${this.manifest.id}] ui.onAction handler rejected:`,
              error
            );
          });
        }
      } catch (error) {
        logger.warn(`[Extension:${this.manifest.id}] ui.onAction handler threw:`, error);
      }
    }
  }

  /**
   * Create the permission-checked mail API.
   *
   * Each wrapper checks ONE permission and then hands off. The read/starred
   * flags go through `applyLabels` rather than a method of their own because
   * the host already has a planner that knows a flag tag from a label, knows
   * which flags can reach the server, and refuses the ones that cannot — that
   * logic is worth exactly one implementation.
   */
  private createMail(): ExtensionMail {
    const backend = this.options.mailBackend;
    const extensionId = this.manifest.id;
    const context = this;

    /** Fail loudly rather than silently doing nothing when nothing is wired. */
    const require_ = (operation: string): ExtensionMailBackend => {
      if (!backend) throw new Error(`mail.${operation} is not available in this host`);
      return backend;
    };

    // Every wrapper is `async`, so a refused permission and a missing backend
    // come back as a REJECTION and not a synchronous throw. The signatures all
    // promise a promise; an extension writing `mail.markRead(id).catch(...)`
    // would otherwise take an uncaught exception on exactly the paths it wrote
    // that `catch` for.
    const setFlag = async (
      operation: string,
      emailId: string,
      flag: 'read' | 'starred',
      value: boolean
    ): Promise<void> => {
      context.requirePermission('email:flag', `mail.${operation}`);
      return require_(operation).applyLabels(extensionId, emailId, {
        ...(value ? { add: [flag] } : { remove: [flag] }),
      });
    };

    return {
      async get(emailId: string): Promise<EmailRecord | null> {
        context.requirePermission('email:read', 'mail.get');
        return require_('get').get(extensionId, emailId);
      },

      async folders(accountId?: string): Promise<ExtensionMailFolder[]> {
        context.requirePermission('email:read', 'mail.folders');
        return require_('folders').folders(extensionId, accountId);
      },

      markRead: (emailId: string) => setFlag('markRead', emailId, 'read', true),
      markUnread: (emailId: string) => setFlag('markUnread', emailId, 'read', false),
      star: (emailId: string) => setFlag('star', emailId, 'starred', true),
      unstar: (emailId: string) => setFlag('unstar', emailId, 'starred', false),

      async addLabel(emailId: string, label: string): Promise<void> {
        context.requirePermission('email:label', 'mail.addLabel');
        return require_('addLabel').applyLabels(extensionId, emailId, { add: [label] });
      },

      async removeLabel(emailId: string, label: string): Promise<void> {
        context.requirePermission('email:label', 'mail.removeLabel');
        return require_('removeLabel').applyLabels(extensionId, emailId, { remove: [label] });
      },

      async move(emailId: string, folderId: string): Promise<void> {
        context.requirePermission('email:move', 'mail.move');
        return require_('move').move(extensionId, emailId, folderId);
      },

      async trash(emailId: string): Promise<void> {
        context.requirePermission('email:delete', 'mail.trash');
        return require_('trash').trash(extensionId, emailId);
      },
    };
  }

  /**
   * Create extension logger
   */
  private createLogger(): ExtensionLogger {
    const prefix = `[Extension:${this.manifest.id}]`;

    return {
      debug(message: string, ...args: unknown[]): void {
        logger.debug(`${prefix} ${message}`, ...args);
      },

      info(message: string, ...args: unknown[]): void {
        logger.info(`${prefix} ${message}`, ...args);
      },

      warn(message: string, ...args: unknown[]): void {
        logger.warn(`${prefix} ${message}`, ...args);
      },

      error(message: string, ...args: unknown[]): void {
        logger.error(`${prefix} ${message}`, ...args);
      },
    };
  }
}

/**
 * Convert an extension workflow result to a standard workflow result
 */
export function toWorkflowResult(result: ExtensionWorkflowResult): WorkflowResult {
  // Build metadata including AI-specific modifications
  const metadata: Record<string, any> = {
    ...(result.metadata || {}),
  };

  // AI modifications go in metadata since EmailRecord doesn't have these fields
  if (result.modifications) {
    if (result.modifications.aiCategory) metadata.aiCategory = result.modifications.aiCategory;
    if (result.modifications.aiCategories) metadata.aiCategories = result.modifications.aiCategories;
    if (result.modifications.aiConfidence !== undefined) metadata.aiConfidence = result.modifications.aiConfidence;
    if (result.modifications.aiSummary) metadata.aiSummary = result.modifications.aiSummary;
  }

  return {
    success: result.success,
    // Only pass labels as modifications since those are part of EmailRecord
    modifications: result.modifications?.labels
      ? { labels: result.modifications.labels }
      : undefined,
    labelsToAdd: result.labelsToAdd,
    labelsToRemove: result.labelsToRemove,
    skipRemaining: result.skipRemaining,
    error: result.error,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}
