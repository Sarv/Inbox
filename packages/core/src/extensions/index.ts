/**
 * Extension System
 *
 * Provides VS Code-like extensibility for Sarv Inbox.
 * Extensions can register workflows, subscribe to events,
 * and process emails with permission-based access control.
 */

// Types
export type {
  ExtensionManifest,
  ExtensionContributions,
  WorkflowContribution,
  SettingContribution,
  ExtensionPermission,
  PermissionInfo,
  ExtensionState,
  ExtensionInfo,
  ExtensionContext,
  ExtensionWorkflow,
  WorkflowExecutionContext,
  ExtensionWorkflowResult,
  ExtensionEventBus,
  ExtensionStorage,
  ExtensionAI,
  ExtensionSettings,
  ExtensionLogger,
  AICategorizationResult,
  AICompletionOptions,
  InstalledExtension,
  ExtensionSource,
  ExtensionFilter,
  // Extension export types
  EmailForSummary,
  ThreadSummaryResult,
  EmailSummaryResult,
  EmailSummarizationExports,
  EmailCategorizationResult,
  AICategorizationExports,
} from './types';

export { PERMISSION_INFO } from './types';

// Extension API
export {
  createExtensionContext,
  ExtensionContextImpl,
  toWorkflowResult,
  type ExtensionContextOptions,
  type ExtensionStorageBackend,
  type ExtensionAIBackend,
  type ExtensionSettingsBackend,
  type RegisteredWorkflow,
} from './extension-api';

// Extension Loader
export {
  loadExtension,
  discoverExtensions,
  validateManifest,
  satisfiesVersion,
  MANIFEST_FILENAME,
  ALT_MANIFEST_FILENAME,
  PACKAGE_JSON_EXTENSION_KEY,
  type ValidationResult,
  type LoadedExtension,
} from './extension-loader';

// Extension Registry
export {
  ExtensionRegistry,
  initializeExtensionRegistry,
  getExtensionRegistry,
  createExtensionRegistry,
  type ExtensionRegistryOptions,
  type ExtensionRegistryEvent,
  type ExtensionRegistryListener,
} from './extension-registry';

// Extension Host
export {
  ExtensionHost,
  ExtensionWorkflowAdapter,
  initializeExtensionHost,
  getExtensionHost,
  createExtensionHost,
  type ExtensionModule,
  type ExtensionHostOptions,
} from './extension-host';

// Extension Manager
export {
  ExtensionManager,
  initializeExtensionManager,
  getExtensionManager,
  createExtensionManager,
  type ExtensionManagerOptions,
} from './extension-manager';
