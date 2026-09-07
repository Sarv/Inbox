/**
 * Extension Host
 *
 * Manages extension lifecycle and execution.
 * Currently runs extensions in-process with permission checking.
 * Future: Can be upgraded to Worker thread isolation for better security.
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
  toWorkflowResult,
} from './extension-api';
import type { LoadedExtension } from './extension-loader';
import type { ExtensionRegistry } from './extension-registry';
import {
  ExtensionState,
  type ExtensionManifest,
  type ExtensionPermission,
  type ExtensionInfo,
  type ExtensionWorkflow,
} from './types';

/**
 * Extension module interface (what the extension exports)
 */
export interface ExtensionModule {
  activate(context: ExtensionContextImpl): void | Promise<void>;
  deactivate?(): void | Promise<void>;
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

  /** Base path for extension storage */
  extensionStoragePath: string;
}

/**
 * Active extension info
 */
interface ActiveExtension {
  manifest: ExtensionManifest;
  context: ExtensionContextImpl;
  module: ExtensionModule;
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
  private extensionStoragePath: string;

  private activeExtensions: Map<string, ActiveExtension> = new Map();
  private workflowAdapters: Map<string, ExtensionWorkflowAdapter> = new Map();

  constructor(options: ExtensionHostOptions) {
    this.registry = options.registry;
    this.eventBus = options.eventBus;
    this.storageBackend = options.storageBackend;
    this.aiBackend = options.aiBackend;
    this.settingsBackend = options.settingsBackend;
    this.extensionStoragePath = options.extensionStoragePath;
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
      });

      // Load the extension module
      // Clear require cache to allow hot-reloading during development
      delete require.cache[require.resolve(entryPoint)];
      const module: ExtensionModule = require(entryPoint);

      if (typeof module.activate !== 'function') {
        throw new Error('Extension must export an activate function');
      }

      // Call activate
      await module.activate(context);

      // Store active extension
      this.activeExtensions.set(manifest.id, {
        manifest,
        context,
        module,
        state: ExtensionState.ACTIVE,
      });

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
      // Call deactivate if defined
      if (active.module.deactivate) {
        await active.module.deactivate();
      }

      // Cleanup context
      active.context.dispose();

      // Remove workflow adapters
      const workflows = active.context.getRegisteredWorkflows();
      for (const registered of workflows) {
        this.workflowAdapters.delete(registered.fullId);
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
      if (info) {
        info.state = ExtensionState.ERROR;
        info.error = error instanceof Error ? error.message : String(error);
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
   * Get an extension's exported API
   * Returns the exports object set by the extension during activation
   */
  getExtensionExports<T = Record<string, unknown>>(extensionId: string): T | undefined {
    const active = this.activeExtensions.get(extensionId);
    if (!active) {
      return undefined;
    }
    // The context stores exports set by the extension
    return (active.context as any).exports as T | undefined;
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
   * Process an email through all extension workflows
   */
  async processEmail(
    email: EmailRecord,
    context: WorkflowContext
  ): Promise<Map<string, WorkflowResult>> {
    const results = new Map<string, WorkflowResult>();

    // Get workflows sorted by priority
    const adapters = this.getAllWorkflowAdapters()
      .filter((a) => a.enabled)
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
