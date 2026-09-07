/**
 * Extension Registry
 *
 * Tracks installed extensions, manages enable/disable state,
 * and persists extension configuration.
 */

import * as fs from 'fs';
import * as path from 'path';

import { logger } from '../utils/logger';

import { loadExtension, discoverExtensions, type LoadedExtension } from './extension-loader';
import {
  ExtensionSource,
  type ExtensionPermission,
  type ExtensionInfo,
  type InstalledExtension,
  type ExtensionFilter,
} from './types';

/**
 * Extension registry options
 */
export interface ExtensionRegistryOptions {
  /** Directory for user extensions */
  userExtensionsDir: string;

  /** Directory for builtin extensions */
  builtinExtensionsDir?: string;

  /** Path to persist registry state */
  statePath: string;
}

/**
 * Persisted registry state
 */
interface RegistryState {
  /** Installed extensions */
  extensions: Record<string, InstalledExtension>;

  /** Last update timestamp */
  lastUpdated: number;
}

/**
 * Extension event types
 */
export type ExtensionRegistryEvent =
  | { type: 'installed'; extensionId: string; extension: InstalledExtension }
  | { type: 'uninstalled'; extensionId: string }
  | { type: 'enabled'; extensionId: string }
  | { type: 'disabled'; extensionId: string }
  | { type: 'updated'; extensionId: string; oldVersion: string; newVersion: string }
  | { type: 'permissions-changed'; extensionId: string; permissions: ExtensionPermission[] };

/**
 * Extension registry event listener
 */
export type ExtensionRegistryListener = (event: ExtensionRegistryEvent) => void;

/**
 * Extension Registry - manages installed extensions
 */
export class ExtensionRegistry {
  private userExtensionsDir: string;
  private builtinExtensionsDir?: string;
  private statePath: string;

  private extensions: Map<string, InstalledExtension> = new Map();
  private loadedExtensions: Map<string, LoadedExtension> = new Map();
  private runtimeInfo: Map<string, ExtensionInfo> = new Map();
  private listeners: Set<ExtensionRegistryListener> = new Set();

  constructor(options: ExtensionRegistryOptions) {
    this.userExtensionsDir = options.userExtensionsDir;
    this.builtinExtensionsDir = options.builtinExtensionsDir;
    this.statePath = options.statePath;
  }

  /**
   * Initialize the registry by loading persisted state and discovering extensions
   */
  async initialize(): Promise<void> {
    // Ensure directories exist
    await this.ensureDirectories();

    // Load persisted state
    await this.loadState();

    // Discover and load extensions
    await this.discoverAndLoad();

    logger.info(`Extension registry initialized: ${this.extensions.size} extensions`);
  }

  /**
   * Ensure extension directories exist
   */
  private async ensureDirectories(): Promise<void> {
    if (!fs.existsSync(this.userExtensionsDir)) {
      fs.mkdirSync(this.userExtensionsDir, { recursive: true });
    }

    const stateDir = path.dirname(this.statePath);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
  }

  /**
   * Load persisted state
   */
  private async loadState(): Promise<void> {
    if (!fs.existsSync(this.statePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.statePath, 'utf-8');
      const state: RegistryState = JSON.parse(content);

      for (const [id, ext] of Object.entries(state.extensions)) {
        this.extensions.set(id, ext);
      }

      logger.debug(`Loaded registry state: ${this.extensions.size} extensions`);
    } catch (error) {
      logger.error('Failed to load registry state:', error);
    }
  }

  /**
   * Save state to disk
   */
  private async saveState(): Promise<void> {
    const state: RegistryState = {
      extensions: Object.fromEntries(this.extensions),
      lastUpdated: Date.now(),
    };

    try {
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save registry state:', error);
    }
  }

  /**
   * Discover and load all extensions
   */
  private async discoverAndLoad(): Promise<void> {
    // Load builtin extensions
    if (this.builtinExtensionsDir && fs.existsSync(this.builtinExtensionsDir)) {
      const builtins = await discoverExtensions(this.builtinExtensionsDir);
      for (const loaded of builtins) {
        await this.registerDiscoveredExtension(loaded, ExtensionSource.BUILTIN);
      }
    }

    // Load user extensions
    const userExtensions = await discoverExtensions(this.userExtensionsDir);
    for (const loaded of userExtensions) {
      await this.registerDiscoveredExtension(loaded, ExtensionSource.LOCAL);
    }
  }

  /**
   * Register a discovered extension
   */
  private async registerDiscoveredExtension(
    loaded: LoadedExtension,
    source: ExtensionSource
  ): Promise<void> {
    const { manifest } = loaded;

    // Check if already registered
    const existing = this.extensions.get(manifest.id);

    if (existing) {
      // Update loaded extension reference
      this.loadedExtensions.set(manifest.id, loaded);

      // Check if version changed
      if (existing.version !== manifest.version) {
        logger.info(
          `Extension ${manifest.id} updated: ${existing.version} -> ${manifest.version}`
        );
        existing.version = manifest.version;
        this.emit({
          type: 'updated',
          extensionId: manifest.id,
          oldVersion: existing.version,
          newVersion: manifest.version,
        });
        await this.saveState();
      }
    } else {
      // New extension
      const installed: InstalledExtension = {
        id: manifest.id,
        source,
        path: loaded.path,
        version: manifest.version,
        installedAt: Date.now(),
        enabled: manifest.builtin ?? true, // Builtin extensions enabled by default
        grantedPermissions: manifest.permissions, // Grant all by default (user can revoke)
        settings: {},
      };

      this.extensions.set(manifest.id, installed);
      this.loadedExtensions.set(manifest.id, loaded);

      this.emit({ type: 'installed', extensionId: manifest.id, extension: installed });
      await this.saveState();

      logger.info(`Registered extension: ${manifest.id} v${manifest.version} (${source})`);
    }
  }

  /**
   * Install an extension from a path
   */
  async install(extensionPath: string): Promise<InstalledExtension> {
    // Load and validate
    const loaded = await loadExtension(extensionPath);
    const { manifest } = loaded;

    // Check if already installed
    if (this.extensions.has(manifest.id)) {
      throw new Error(`Extension '${manifest.id}' is already installed`);
    }

    // Copy to user extensions directory
    const targetPath = path.join(this.userExtensionsDir, manifest.id);
    if (extensionPath !== targetPath) {
      await this.copyDirectory(extensionPath, targetPath);
    }

    // Register
    await this.registerDiscoveredExtension(
      { ...loaded, path: targetPath },
      ExtensionSource.LOCAL
    );

    return this.extensions.get(manifest.id)!;
  }

  /**
   * Uninstall an extension
   */
  async uninstall(extensionId: string): Promise<void> {
    const extension = this.extensions.get(extensionId);
    if (!extension) {
      throw new Error(`Extension '${extensionId}' is not installed`);
    }

    if (extension.source === ExtensionSource.BUILTIN) {
      throw new Error('Cannot uninstall builtin extensions');
    }

    // Remove from disk
    if (fs.existsSync(extension.path)) {
      fs.rmSync(extension.path, { recursive: true });
    }

    // Remove from registry
    this.extensions.delete(extensionId);
    this.loadedExtensions.delete(extensionId);
    this.runtimeInfo.delete(extensionId);

    this.emit({ type: 'uninstalled', extensionId });
    await this.saveState();

    logger.info(`Uninstalled extension: ${extensionId}`);
  }

  /**
   * Enable an extension
   */
  async enable(extensionId: string): Promise<void> {
    const extension = this.extensions.get(extensionId);
    if (!extension) {
      throw new Error(`Extension '${extensionId}' is not installed`);
    }

    if (extension.enabled) {
      return;
    }

    extension.enabled = true;
    this.emit({ type: 'enabled', extensionId });
    await this.saveState();

    logger.info(`Enabled extension: ${extensionId}`);
  }

  /**
   * Disable an extension
   */
  async disable(extensionId: string): Promise<void> {
    const extension = this.extensions.get(extensionId);
    if (!extension) {
      throw new Error(`Extension '${extensionId}' is not installed`);
    }

    if (!extension.enabled) {
      return;
    }

    extension.enabled = false;
    this.emit({ type: 'disabled', extensionId });
    await this.saveState();

    logger.info(`Disabled extension: ${extensionId}`);
  }

  /**
   * Grant permissions to an extension
   */
  async grantPermissions(
    extensionId: string,
    permissions: ExtensionPermission[]
  ): Promise<void> {
    const extension = this.extensions.get(extensionId);
    if (!extension) {
      throw new Error(`Extension '${extensionId}' is not installed`);
    }

    const loaded = this.loadedExtensions.get(extensionId);
    if (!loaded) {
      throw new Error(`Extension '${extensionId}' is not loaded`);
    }

    // Can only grant permissions declared in manifest
    const validPermissions = new Set(loaded.manifest.permissions);
    for (const permission of permissions) {
      if (!validPermissions.has(permission)) {
        throw new Error(
          `Extension '${extensionId}' did not declare permission '${permission}'`
        );
      }
    }

    extension.grantedPermissions = permissions;
    this.emit({ type: 'permissions-changed', extensionId, permissions });
    await this.saveState();
  }

  /**
   * Revoke permissions from an extension
   */
  async revokePermissions(
    extensionId: string,
    permissions: ExtensionPermission[]
  ): Promise<void> {
    const extension = this.extensions.get(extensionId);
    if (!extension) {
      throw new Error(`Extension '${extensionId}' is not installed`);
    }

    const remaining = extension.grantedPermissions.filter(
      (p) => !permissions.includes(p)
    );

    extension.grantedPermissions = remaining;
    this.emit({ type: 'permissions-changed', extensionId, permissions: remaining });
    await this.saveState();
  }

  /**
   * Update extension settings
   */
  async updateSettings(
    extensionId: string,
    settings: Record<string, unknown>
  ): Promise<void> {
    const extension = this.extensions.get(extensionId);
    if (!extension) {
      throw new Error(`Extension '${extensionId}' is not installed`);
    }

    extension.settings = { ...extension.settings, ...settings };
    await this.saveState();
  }

  /**
   * Get an installed extension
   */
  get(extensionId: string): InstalledExtension | undefined {
    return this.extensions.get(extensionId);
  }

  /**
   * Get loaded extension data
   */
  getLoaded(extensionId: string): LoadedExtension | undefined {
    return this.loadedExtensions.get(extensionId);
  }

  /**
   * Get runtime info for an extension
   */
  getRuntimeInfo(extensionId: string): ExtensionInfo | undefined {
    return this.runtimeInfo.get(extensionId);
  }

  /**
   * Set runtime info for an extension
   */
  setRuntimeInfo(extensionId: string, info: ExtensionInfo): void {
    this.runtimeInfo.set(extensionId, info);
  }

  /**
   * Get all installed extensions
   */
  getAll(): InstalledExtension[] {
    return Array.from(this.extensions.values());
  }

  /**
   * Get extensions matching a filter
   */
  filter(filter: ExtensionFilter): InstalledExtension[] {
    let results = this.getAll();

    if (filter.enabled !== undefined) {
      results = results.filter((e) => e.enabled === filter.enabled);
    }

    if (filter.source) {
      results = results.filter((e) => e.source === filter.source);
    }

    if (filter.hasPermission) {
      results = results.filter((e) =>
        e.grantedPermissions.includes(filter.hasPermission!)
      );
    }

    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      results = results.filter((e) => {
        const loaded = this.loadedExtensions.get(e.id);
        if (!loaded) return false;

        return (
          e.id.toLowerCase().includes(searchLower) ||
          loaded.manifest.name.toLowerCase().includes(searchLower) ||
          loaded.manifest.description?.toLowerCase().includes(searchLower)
        );
      });
    }

    return results;
  }

  /**
   * Get count of installed extensions
   */
  get count(): number {
    return this.extensions.size;
  }

  /**
   * Get count of enabled extensions
   */
  get enabledCount(): number {
    return this.filter({ enabled: true }).length;
  }

  /**
   * Check if an extension is installed
   */
  has(extensionId: string): boolean {
    return this.extensions.has(extensionId);
  }

  /**
   * Subscribe to registry events
   */
  subscribe(listener: ExtensionRegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: ExtensionRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('Error in registry event listener:', error);
      }
    }
  }

  /**
   * Copy a directory recursively
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Cleanup and dispose
   */
  dispose(): void {
    this.listeners.clear();
  }
}

// Singleton instance
let globalRegistry: ExtensionRegistry | null = null;

/**
 * Initialize the global extension registry
 */
export function initializeExtensionRegistry(
  options: ExtensionRegistryOptions
): ExtensionRegistry {
  if (globalRegistry) {
    logger.warn('Extension registry already initialized');
    return globalRegistry;
  }
  globalRegistry = new ExtensionRegistry(options);
  return globalRegistry;
}

/**
 * Get the global extension registry
 */
export function getExtensionRegistry(): ExtensionRegistry | null {
  return globalRegistry;
}

/**
 * Create a new extension registry (for testing or isolation)
 */
export function createExtensionRegistry(
  options: ExtensionRegistryOptions
): ExtensionRegistry {
  return new ExtensionRegistry(options);
}
