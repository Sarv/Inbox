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
  PanelContribution,
  PanelSurface,
  CapabilityContribution,
  ExtensionScreenshot,
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
  ExtensionMail,
  ExtensionMailFolder,
  ExtensionUI,
  ExtensionUIAction,
  ExtensionUIActionHandler,
  ExtensionUIField,
  ExtensionUINotification,
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

// Catalogue categories - the closed vocabulary an author's manifest is folded onto
export {
  DEFAULT_EXTENSION_CATEGORY,
  EXTENSION_CATEGORIES,
  isExtensionCategory,
  normalizeExtensionCategory,
  type ExtensionCategory,
} from './categories';

// Panel assets — the privileged scheme's address format and allow-list
export {
  PANEL_SCHEME,
  SDK_HOST,
  panelAssetContentType,
  panelAssetUrl,
  parsePanelUrl,
  type PanelAssetRequest,
} from './panel-assets';

// Panel bridge — what a panel iframe may ask the host for
export {
  PANEL_BRIDGE_CHANNEL,
  isPanelRequestMethod,
  panelRequestPermission,
  parsePanelRequest,
  toPanelMessage,
  type PanelEvent,
  type PanelEventName,
  type PanelRequest,
  type PanelMessage,
  type PanelRequestMethod,
  type PanelResponse,
} from './panel-bridge';

export type { AvailablePanel } from './extension-manager';
export type { PanelRequestDeps } from './extension-host';

// Extension API
export {
  createExtensionContext,
  ExtensionContextImpl,
  toWorkflowResult,
  type ExtensionContextOptions,
  type ExtensionStorageBackend,
  type ExtensionAIBackend,
  type ExtensionSettingsBackend,
  type ExtensionUIBackend,
  type ExtensionMailBackend,
  type RegisteredWorkflow,
} from './extension-api';

// Notification card sanitisation
export {
  sanitizeExtensionNotification,
  namespaceNotificationId,
  splitNotificationId,
  MAX_NOTIFICATION_LIFETIME_MS,
  MIN_NOTIFICATION_TIMEOUT_MS,
  MAX_NOTIFICATION_TIMEOUT_MS,
  type SanitizedExtensionNotification,
} from './ui-notification';

// Workflow result -> host effects (permission enforcement)
export {
  planWorkflowEffects,
  SYNCABLE_FLAG_TAGS,
  type ExtensionFlagChange,
  type RejectedLabel,
  type SyncableFlagTag,
  type WorkflowEffectPlan,
  type WorkflowOutcome,
} from './workflow-effects';

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
  type WorkflowStage,
} from './extension-host';

// Out-of-process runtime — the boundary extension code actually runs behind.
// Exported so the desktop app can supply its own transport (a `utilityProcess`)
// and so a headless embedder can drive the sandbox directly.
export {
  ExtensionBridge,
  DEFAULT_INVOKE_TIMEOUT_MS,
  type ActivationOutcome,
  type ExtensionBridgeHooks,
  type ExtensionBridgeOptions,
} from './runtime/extension-bridge';

export {
  createInProcessChannelPair,
  type ExtensionChannelPair,
} from './runtime/in-process-channel';

export {
  startExtensionSandbox,
  type ExtensionSandbox,
  type SandboxExtensionModule,
  type SandboxModuleLoader,
} from './runtime/sandbox';

export {
  serializeError,
  deserializeError,
  type ExtensionChannel,
  type HostCallMethod,
  type HostToSandboxMessage,
  type SandboxActivationRequest,
  type SandboxInvokeTarget,
  type SandboxSyncState,
  type SandboxToHostMessage,
  type SerializedError,
  type SerializedWorkflowCall,
  type SerializedWorkflowResult,
  type WorkflowDescriptor,
} from './runtime/protocol';

export {
  createRemoteExports,
  createRemoteWorkflow,
  deserializeWorkflowResult,
  serializeWorkflowResult,
} from './runtime/remote-proxies';

// Extension Manager
export {
  ExtensionManager,
  initializeExtensionManager,
  getExtensionManager,
  createExtensionManager,
  type ExtensionManagerOptions,
} from './extension-manager';

// Marketplace — the GitHub-hosted registry the app browses and installs from.
export {
  TRUSTED_REGISTRY_HOSTS,
  REGISTRY_SCHEMA_VERSION,
  MAX_DOWNLOAD_BYTES,
  isTrustedRegistryUrl,
  resolveTrustedUrl,
  parseRegistryDocument,
  mergeRegistryDetail,
  compareExtensionVersions,
  buildCatalog,
  mergeRegistries,
  type RegistryDownload,
  type RegistryEntry,
  type RegistryEntryStats,
  type RegistryContributions,
  type RegistryScreenshot,
  type RegistrySourceStats,
  type ParsedRegistry,
  type RejectedEntry,
  type CatalogItem,
  type CatalogState,
  type InstalledSummary,
  type BuildCatalogOptions,
} from './marketplace';

// Build-time configuration: which registries, and which extensions a new
// profile starts with.
export {
  OFFICIAL_REGISTRY_URL,
  DEFAULT_EXTENSIONS_CONFIG,
  parseExtensionsConfig,
  type ExtensionsConfig,
  type ParsedExtensionsConfig,
} from './extensions-config';
