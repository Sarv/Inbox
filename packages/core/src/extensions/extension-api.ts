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
 * Settings backend interface (implemented by host)
 */
export interface ExtensionSettingsBackend {
  get<T>(extensionId: string, key: string): T | undefined;
  update(extensionId: string, key: string, value: unknown): Promise<void>;
  has(extensionId: string, key: string): boolean;
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
  readonly log: ExtensionLogger;
  subscriptions: Unsubscribe[] = [];

  /** Extension exports - API exposed to the host application */
  exports: Record<string, unknown> = {};

  private grantedPermissions: Set<ExtensionPermission>;
  private registeredWorkflows: Map<string, RegisteredWorkflow> = new Map();

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
