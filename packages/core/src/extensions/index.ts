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
  ExtensionNetwork,
  ExtensionNetworkRequest,
  ExtensionNetworkResponse,
  ExtensionNetworkResult,
  ExtensionMailFolder,
  ExtensionSecurity,
  AntivirusScanTarget,
  AntivirusSetupStatus,
  AntivirusScanJob,
  AntivirusScanSubmitOptions,
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
  type ExtensionNetworkBackend,
  type ExtensionSecurityBackend,
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
  ACTIVATE_ALL_WAIT_MS,
  EXTENSION_FAILED_TO_START,
  EXTENSION_HELD_BACK,
  MAX_NAME_ON_PROBLEM_CARD,
  SANDBOX_RESTART_DELAYS_MS,
  SANDBOX_RESTART_FORGIVE_MS,
  SANDBOX_START_TIMEOUT_MS,
  initializeExtensionHost,
  getExtensionHost,
  createExtensionHost,
  type ExtensionModule,
  type ExtensionHostOptions,
  type WorkflowStage,
} from './extension-host';

// Out-of-process runtime — the boundary extension code actually runs behind.
// Exported so the desktop app can supply its own transport (a confined renderer)
// and so a headless embedder can drive the sandbox directly.
export {
  ExtensionBridge,
  DEACTIVATE_TIMEOUT_MS,
  DEFAULT_INVOKE_TIMEOUT_MS,
  HOST_CALL_SLICE_MS,
  MAX_DESCRIPTION_LENGTH,
  MAX_EXPORTS_PER_EXTENSION,
  MAX_IDENTIFIER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LABELS_PER_CHANGE,
  MAX_QUEUED_HOST_CALLS,
  MAX_SUBSCRIPTIONS_PER_EXTENSION,
  MAX_WORKFLOW_REGISTRATIONS,
  MAX_WORKFLOWS_PER_EXTENSION,
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

export { createNodeModuleLoader } from './runtime/node-module-loader';

export {
  messageBytes,
  MAX_MESSAGE_BYTES,
  createFloodBudget,
  FLOOD_BASE_MESSAGES,
  FLOOD_BYTES,
  FLOOD_MESSAGES_PER_CALL,
  FLOOD_WINDOW_MS,
  type FloodBudget,
  type FloodVerdict,
} from './runtime/flood-budget';

export {
  createLogBudget,
  LOG_LINES_PER_WINDOW,
  LOG_WINDOW_MS,
  MAX_EXTENSION_LOG_LINE,
  type LogBudget,
  type LogBudgetVerdict,
} from './runtime/log-budget';

export {
  isKnownNodeApi,
  nodeApiBehindError,
  nodeBuiltinNamed,
  refusalInConsoleLine,
  UnsupportedNodeApiError,
  unsupportedNodeApiMessage,
} from './runtime/unsupported-node-api';

export {
  serializeError,
  deserializeError,
  type ExtensionChannel,
  type HostCallMethod,
  type HostToSandboxMessage,
  type SandboxActivationRequest,
  type SandboxCloseDetails,
  type SandboxInvokeTarget,
  type SandboxSyncState,
  type SandboxTarget,
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
  STORAGE_MAX_KEY_LENGTH,
  STORAGE_MAX_TOTAL_BYTES,
  STORAGE_MAX_VALUE_BYTES,
  initializeExtensionManager,
  getExtensionManager,
  createExtensionManager,
  type ExtensionManagerOptions,
} from './extension-manager';

// Marketplace — the GitHub-hosted registry the app browses and installs from.
export {
  TRUSTED_REGISTRY_HOSTS,
  REGISTRY_MIRROR_HOST,
  registryMirrorUrl,
  REGISTRY_SCHEMA_VERSION,
  MAX_DOWNLOAD_BYTES,
  isTrustedRegistryUrl,
  resolveTrustedUrl,
  parseRegistryDocument,
  mergeRegistryDetail,
  compareExtensionVersions,
  isNewerCompatibleRelease,
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
