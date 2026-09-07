/**
 * Extension Manager
 *
 * High-level manager that orchestrates the extension system.
 * Initializes registry, host, and handles extension lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';

import { EventBus, createEventBus } from '../pipeline/event-bus';
import type { WorkflowResult } from '../pipeline/types';
import type { EmailRecord } from '../types/models';
import { logger } from '../utils/logger';

import type {
  ExtensionStorageBackend,
  ExtensionAIBackend,
  ExtensionSettingsBackend,
} from './extension-api';
import {
  ExtensionHost,
  createExtensionHost,
} from './extension-host';
import {
  ExtensionRegistry,
  createExtensionRegistry,
} from './extension-registry';
import type {
  InstalledExtension,
  ExtensionInfo,
} from './types';


/**
 * Extension manager options
 */
export interface ExtensionManagerOptions {
  /** Base directory for extensions data */
  extensionsBaseDir: string;

  /** Optional: directory containing builtin extensions */
  builtinExtensionsDir?: string;

  /** Optional: custom storage backend */
  storageBackend?: ExtensionStorageBackend;

  /** Optional: AI backend for extensions */
  aiBackend?: ExtensionAIBackend;

  /** Optional: settings backend */
  settingsBackend?: ExtensionSettingsBackend;

  /** Optional: event bus (shared with pipeline) */
  eventBus?: EventBus;
}

/**
 * Extension Manager - orchestrates the extension system
 */
export class ExtensionManager {
  private baseDir: string;
  private registry: ExtensionRegistry;
  private host: ExtensionHost;
  private eventBus: EventBus;
  private initialized: boolean = false;

  // Directory paths
  private userExtensionsDir: string;
  private builtinExtensionsDir: string;
  private storageDir: string;
  private stateFile: string;

  constructor(options: ExtensionManagerOptions) {
    this.baseDir = options.extensionsBaseDir;

    // Set up directories
    this.userExtensionsDir = path.join(this.baseDir, 'extensions');
    this.builtinExtensionsDir = options.builtinExtensionsDir || path.join(__dirname, 'builtin');
    this.storageDir = path.join(this.baseDir, 'extension-storage');
    this.stateFile = path.join(this.baseDir, 'extensions-state.json');

    // Create event bus
    this.eventBus = options.eventBus || createEventBus();

    // Create default backends if not provided
    const storageBackend = options.storageBackend || this.createDefaultStorageBackend();
    const settingsBackend = options.settingsBackend || this.createDefaultSettingsBackend();

    // Create registry
    this.registry = createExtensionRegistry({
      userExtensionsDir: this.userExtensionsDir,
      builtinExtensionsDir: this.builtinExtensionsDir,
      statePath: this.stateFile,
    });

    // Create host
    this.host = createExtensionHost({
      registry: this.registry,
      eventBus: this.eventBus,
      storageBackend,
      aiBackend: options.aiBackend,
      settingsBackend,
      extensionStoragePath: this.storageDir,
    });
  }

  /**
   * Initialize the extension system
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('Extension manager already initialized');
      return;
    }

    logger.info('Initializing extension manager...');

    // Ensure directories exist
    this.ensureDirectories();

    // Initialize registry (discovers and loads extensions)
    await this.registry.initialize();

    // Activate all enabled extensions
    await this.host.activateAll();

    this.initialized = true;

    logger.info(
      `Extension manager initialized: ${this.registry.count} extensions, ` +
      `${this.host.getActiveExtensionIds().length} active`
    );
  }

  /**
   * Ensure required directories exist
   */
  private ensureDirectories(): void {
    const dirs = [
      this.baseDir,
      this.userExtensionsDir,
      this.storageDir,
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Create default storage backend (file-based)
   */
  private createDefaultStorageBackend(): ExtensionStorageBackend {
    const storageDir = this.storageDir;

    return {
      async get<T>(extensionId: string, key: string): Promise<T | undefined> {
        const filePath = path.join(storageDir, extensionId, 'storage.json');
        try {
          if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return data[key];
          }
        } catch (error) {
          logger.error(`Extension storage get error [${extensionId}]:`, error);
        }
        return undefined;
      },

      async set<T>(extensionId: string, key: string, value: T): Promise<void> {
        const extDir = path.join(storageDir, extensionId);
        const filePath = path.join(extDir, 'storage.json');
        try {
          if (!fs.existsSync(extDir)) {
            fs.mkdirSync(extDir, { recursive: true });
          }
          let data: Record<string, unknown> = {};
          if (fs.existsSync(filePath)) {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          }
          data[key] = value;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (error) {
          logger.error(`Extension storage set error [${extensionId}]:`, error);
        }
      },

      async delete(extensionId: string, key: string): Promise<void> {
        const filePath = path.join(storageDir, extensionId, 'storage.json');
        try {
          if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            delete data[key];
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
          }
        } catch (error) {
          logger.error(`Extension storage delete error [${extensionId}]:`, error);
        }
      },

      async keys(extensionId: string): Promise<string[]> {
        const filePath = path.join(storageDir, extensionId, 'storage.json');
        try {
          if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return Object.keys(data);
          }
        } catch (error) {
          logger.error(`Extension storage keys error [${extensionId}]:`, error);
        }
        return [];
      },

      async clear(extensionId: string): Promise<void> {
        const filePath = path.join(storageDir, extensionId, 'storage.json');
        try {
          if (fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, '{}', 'utf-8');
          }
        } catch (error) {
          logger.error(`Extension storage clear error [${extensionId}]:`, error);
        }
      },
    };
  }

  /**
   * Create default settings backend
   */
  private createDefaultSettingsBackend(): ExtensionSettingsBackend {
    const settings: Map<string, Record<string, unknown>> = new Map();
    const stateFile = path.join(this.baseDir, 'extension-settings.json');

    // Load existing settings
    try {
      if (fs.existsSync(stateFile)) {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        for (const [extId, extSettings] of Object.entries(data)) {
          settings.set(extId, extSettings as Record<string, unknown>);
        }
      }
    } catch (error) {
      logger.error('Failed to load extension settings:', error);
    }

    const saveSettings = () => {
      try {
        const data: Record<string, unknown> = {};
        for (const [extId, extSettings] of settings) {
          data[extId] = extSettings;
        }
        fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf-8');
      } catch (error) {
        logger.error('Failed to save extension settings:', error);
      }
    };

    return {
      get<T>(extensionId: string, key: string): T | undefined {
        const extSettings = settings.get(extensionId);
        return extSettings?.[key] as T | undefined;
      },

      async update(extensionId: string, key: string, value: unknown): Promise<void> {
        let extSettings = settings.get(extensionId);
        if (!extSettings) {
          extSettings = {};
          settings.set(extensionId, extSettings);
        }
        extSettings[key] = value;
        saveSettings();
      },

      has(extensionId: string, key: string): boolean {
        const extSettings = settings.get(extensionId);
        return extSettings ? key in extSettings : false;
      },
    };
  }

  /**
   * Get the extension registry
   */
  getRegistry(): ExtensionRegistry {
    return this.registry;
  }

  /**
   * Get the extension host
   */
  getHost(): ExtensionHost {
    return this.host;
  }

  /**
   * Get the event bus
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get all installed extensions
   */
  getInstalledExtensions(): InstalledExtension[] {
    return this.registry.getAll();
  }

  /**
   * Get extension info by ID
   */
  getExtensionInfo(extensionId: string): ExtensionInfo | undefined {
    return this.registry.getRuntimeInfo(extensionId);
  }

  /**
   * Install an extension from a path
   */
  async installExtension(extensionPath: string): Promise<InstalledExtension> {
    const installed = await this.registry.install(extensionPath);

    // Automatically activate if enabled
    if (installed.enabled) {
      const loaded = this.registry.getLoaded(installed.id);
      if (loaded) {
        await this.host.activate(loaded, installed.grantedPermissions);
      }
    }

    return installed;
  }

  /**
   * Uninstall an extension
   */
  async uninstallExtension(extensionId: string): Promise<void> {
    // Deactivate first
    await this.host.deactivate(extensionId);

    // Then uninstall
    await this.registry.uninstall(extensionId);
  }

  /**
   * Enable an extension
   */
  async enableExtension(extensionId: string): Promise<void> {
    await this.registry.enable(extensionId);

    // Activate
    const loaded = this.registry.getLoaded(extensionId);
    const installed = this.registry.get(extensionId);
    if (loaded && installed) {
      await this.host.activate(loaded, installed.grantedPermissions);
    }
  }

  /**
   * Disable an extension
   */
  async disableExtension(extensionId: string): Promise<void> {
    // Deactivate first
    await this.host.deactivate(extensionId);

    // Then disable in registry
    await this.registry.disable(extensionId);
  }

  /**
   * Process an email through all extension workflows
   */
  async processEmail(
    email: EmailRecord,
    previousResults?: Map<string, WorkflowResult>,
    abortSignal?: AbortSignal
  ): Promise<Map<string, WorkflowResult>> {
    return this.host.processEmail(email, {
      storage: null, // Extensions use their own storage
      previousResults: previousResults || new Map(),
      abortSignal,
    });
  }

  /**
   * Get all active workflow IDs
   */
  getActiveWorkflowIds(): string[] {
    return this.host.getAllWorkflowAdapters().map((a) => a.id);
  }

  /**
   * Get an extension's exported API
   * This allows the host application to call functions exposed by extensions
   */
  getExtensionExports<T = Record<string, unknown>>(extensionId: string): T | undefined {
    return this.host.getExtensionExports<T>(extensionId);
  }

  /**
   * Call an extension's exported function
   * Convenience method to invoke an extension function by name
   */
  async callExtensionFunction<T = unknown>(
    extensionId: string,
    functionName: string,
    ...args: unknown[]
  ): Promise<T> {
    const exports = this.getExtensionExports(extensionId);
    if (!exports) {
      throw new Error(`Extension '${extensionId}' is not active or has no exports`);
    }

    const fn = exports[functionName];
    if (typeof fn !== 'function') {
      throw new Error(`Extension '${extensionId}' does not export function '${functionName}'`);
    }

    return fn(...args) as T;
  }

  /**
   * Check if extension system is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Shutdown the extension system
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down extension manager...');

    // Deactivate all extensions
    await this.host.dispose();

    // Dispose registry
    this.registry.dispose();

    this.initialized = false;

    logger.info('Extension manager shutdown complete');
  }
}

// Singleton instance
let globalManager: ExtensionManager | null = null;

/**
 * Initialize the global extension manager
 */
export function initializeExtensionManager(
  options: ExtensionManagerOptions
): ExtensionManager {
  if (globalManager) {
    logger.warn('Extension manager already initialized');
    return globalManager;
  }
  globalManager = new ExtensionManager(options);
  return globalManager;
}

/**
 * Get the global extension manager
 */
export function getExtensionManager(): ExtensionManager | null {
  return globalManager;
}

/**
 * Create a new extension manager (for testing or isolation)
 */
export function createExtensionManager(
  options: ExtensionManagerOptions
): ExtensionManager {
  return new ExtensionManager(options);
}
