/**
 * Extension System Types
 *
 * Core type definitions for the Sarv Inbox extension system,
 * enabling VS Code-like extensibility.
 */

import type { WorkflowResult, PipelineEvent, EventHandler, Unsubscribe } from '../pipeline/types';
import type { EmailRecord } from '../types/models';

// ============================================================
// Extension Manifest Types
// ============================================================

/**
 * Extension manifest file structure (sarvinbox-extension.json)
 */
export interface ExtensionManifest {
  /** Unique identifier (lowercase, alphanumeric, hyphens) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Description of what the extension does */
  description: string;

  /** Author name or organization */
  author: string;

  /** Author's email (optional) */
  authorEmail?: string;

  /** Repository URL (optional) */
  repository?: string;

  /** Homepage URL (optional) */
  homepage?: string;

  /** License identifier (e.g., "MIT", "Apache-2.0") */
  license?: string;

  /** Path to main entry point (relative to extension root) */
  main: string;

  /** Engine compatibility */
  engines: {
    /** Required Sarv Inbox version (semver range) */
    sarvinbox: string;
  };

  /** Required permissions */
  permissions: ExtensionPermission[];

  /** Extension contributions */
  contributes?: ExtensionContributions;

  /** Keywords for search/discovery */
  keywords?: string[];

  /** Extension icon path (optional) */
  icon?: string;

  /** Whether this is a builtin extension */
  builtin?: boolean;
}

/**
 * Extension contributions - what the extension provides
 */
export interface ExtensionContributions {
  /** Workflow contributions */
  workflows?: WorkflowContribution[];

  /** Settings contributions */
  settings?: SettingContribution[];

  /** Event subscriptions */
  events?: string[];
}

/**
 * Workflow contribution declaration
 */
export interface WorkflowContribution {
  /** Workflow ID (scoped to extension) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description */
  description?: string;

  /** Priority (lower = runs first) */
  priority: number;

  /** Whether this workflow requires AI */
  requiresAI?: boolean;

  /**
   * Re-run this workflow once the message body has been fetched.
   *
   * Bodies are fetched lazily AFTER `email:synced`, so a workflow that reads
   * `cleanBody`/`rawBody` sees an empty body on the arrival pass. Setting this
   * makes the host run the workflow again on `email:body-ready`. Such a
   * workflow MUST be idempotent — it will see the same message twice.
   */
  requiresBody?: boolean;

  /** Whether to run in background */
  runInBackground?: boolean;

  /** Default enabled state */
  enabledByDefault?: boolean;
}

/**
 * Setting contribution declaration
 */
export interface SettingContribution {
  /** Setting key (scoped to extension: "extension-id.setting-name") */
  key: string;

  /** Setting type */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';

  /** Default value */
  default: unknown;

  /** Human-readable description */
  description: string;

  /** Enum values (for string type) */
  enum?: string[];

  /** Minimum value (for number type) */
  minimum?: number;

  /** Maximum value (for number type) */
  maximum?: number;
}

// ============================================================
// Permission Types
// ============================================================

/**
 * Available extension permissions
 */
export type ExtensionPermission =
  | 'email:read'      // Read email content (subject, body, headers)
  | 'email:label'     // Modify labels/categories
  | 'email:flag'      // Modify flags (read, starred, etc.)
  | 'email:move'      // Move emails between folders
  | 'email:delete'    // Delete emails (requires user confirmation)
  | 'ai:use'          // Access AI services for analysis
  | 'storage:local'   // Store extension-specific data
  | 'network:fetch'   // Make HTTP requests (restricted domains)
  | 'settings:read'   // Read user settings
  | 'settings:write'  // Modify user settings
  | 'ui:notify';      // Surface a notification card in the app window

/**
 * Permission metadata
 */
export interface PermissionInfo {
  id: ExtensionPermission;
  name: string;
  description: string;
  dangerous: boolean;
  requiresConfirmation: boolean;
}

/**
 * Permission definitions with metadata
 */
export const PERMISSION_INFO: Record<ExtensionPermission, PermissionInfo> = {
  'email:read': {
    id: 'email:read',
    name: 'Read Emails',
    description: 'Read email content including subject, body, and headers',
    dangerous: false,
    requiresConfirmation: false,
  },
  'email:label': {
    id: 'email:label',
    name: 'Modify Labels',
    description: 'Add or remove labels and categories from emails',
    dangerous: false,
    requiresConfirmation: false,
  },
  'email:flag': {
    id: 'email:flag',
    name: 'Modify Flags',
    description: 'Mark emails as read, starred, or change other flags',
    dangerous: false,
    requiresConfirmation: false,
  },
  'email:move': {
    id: 'email:move',
    name: 'Move Emails',
    description: 'Move emails between folders',
    dangerous: true,
    requiresConfirmation: true,
  },
  'email:delete': {
    id: 'email:delete',
    name: 'Delete Emails',
    description: 'Permanently delete emails',
    dangerous: true,
    requiresConfirmation: true,
  },
  'ai:use': {
    id: 'ai:use',
    name: 'Use AI Services',
    description: 'Access AI for email analysis and categorization',
    dangerous: false,
    requiresConfirmation: false,
  },
  'storage:local': {
    id: 'storage:local',
    name: 'Local Storage',
    description: 'Store extension-specific data locally',
    dangerous: false,
    requiresConfirmation: false,
  },
  'network:fetch': {
    id: 'network:fetch',
    name: 'Network Access',
    description: 'Make HTTP requests to external services',
    dangerous: true,
    requiresConfirmation: true,
  },
  'settings:read': {
    id: 'settings:read',
    name: 'Read Settings',
    description: 'Read user preferences and settings',
    dangerous: false,
    requiresConfirmation: false,
  },
  'settings:write': {
    id: 'settings:write',
    name: 'Write Settings',
    description: 'Modify user preferences and settings',
    dangerous: true,
    requiresConfirmation: true,
  },
  'ui:notify': {
    id: 'ui:notify',
    name: 'Show Notifications',
    description: 'Show a notification card in the app window',
    dangerous: false,
    requiresConfirmation: false,
  },
};

// ============================================================
// Extension Lifecycle Types
// ============================================================

/**
 * Extension activation state
 */
export enum ExtensionState {
  /** Not yet loaded */
  UNLOADED = 'unloaded',
  /** Loading in progress */
  LOADING = 'loading',
  /** Loaded but not activated */
  LOADED = 'loaded',
  /** Activating in progress */
  ACTIVATING = 'activating',
  /** Active and running */
  ACTIVE = 'active',
  /** Deactivating in progress */
  DEACTIVATING = 'deactivating',
  /** Deactivated */
  DEACTIVATED = 'deactivated',
  /** Error state */
  ERROR = 'error',
  /** Disabled by user */
  DISABLED = 'disabled',
}

/**
 * Extension runtime information
 */
export interface ExtensionInfo {
  /** Extension manifest */
  manifest: ExtensionManifest;

  /** Current state */
  state: ExtensionState;

  /** Whether enabled by user */
  enabled: boolean;

  /** Installation path */
  path: string;

  /** Error message if in error state */
  error?: string;

  /** Activation timestamp */
  activatedAt?: number;

  /** Registered workflow IDs */
  workflowIds: string[];

  /** Event subscriptions */
  subscriptions: Unsubscribe[];
}

// ============================================================
// Extension Context Types
// ============================================================

/**
 * Context passed to extension's activate function
 * This is the API surface available to extensions
 */
export interface ExtensionContext {
  /** Extension manifest */
  readonly manifest: ExtensionManifest;

  /** Extension's storage directory path */
  readonly storagePath: string;

  /** Register a workflow */
  registerWorkflow(workflow: ExtensionWorkflow): void;

  /** Unregister a workflow */
  unregisterWorkflow(workflowId: string): void;

  /** Event bus for subscribing to events */
  readonly events: ExtensionEventBus;

  /** Local storage for extension data */
  readonly storage: ExtensionStorage;

  /** AI client (if ai:use permission granted) */
  readonly ai?: ExtensionAI;

  /** Settings access */
  readonly settings: ExtensionSettings;

  /** Notification cards shown in the app window (if ui:notify granted) */
  readonly ui: ExtensionUI;

  /** Logger */
  readonly log: ExtensionLogger;

  /** Disposables to clean up on deactivation */
  subscriptions: Unsubscribe[];

  /**
   * API this extension offers to the rest of the app, set during `activate`.
   *
   * Reached by the host through `getExtensionExports(id)` — that is how an IPC
   * handler calls into an extension on demand (see `extension:summarizeThread`)
   * rather than waiting for a workflow to run over a message. Declared here and
   * not only on the implementation class because an extension is written
   * against THIS interface: without it, assigning exports needs a cast, and a
   * cast is where the export contract stops being checked.
   */
  exports: Record<string, unknown>;
}

/**
 * Simplified workflow interface for extensions
 */
export interface ExtensionWorkflow {
  /** Workflow ID (will be prefixed with extension ID) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description */
  description?: string;

  /** Priority (lower = runs first, default: 50) */
  priority?: number;

  /** Whether this workflow requires AI */
  requiresAI?: boolean;

  /**
   * Re-run once the body has been fetched (see WorkflowContribution). The
   * workflow must be idempotent: it sees the message on arrival AND again when
   * the body lands.
   */
  requiresBody?: boolean;

  /** Whether to run in background */
  runInBackground?: boolean;

  /** Whether enabled (default: true) */
  enabled?: boolean;

  /** Filter function - return true if workflow should process this email */
  shouldProcess: (email: EmailRecord) => boolean | Promise<boolean>;

  /** Process the email */
  process: (email: EmailRecord, ctx: WorkflowExecutionContext) => Promise<ExtensionWorkflowResult>;
}

/**
 * Context available during workflow execution
 */
export interface WorkflowExecutionContext {
  /** AI client (if permission granted) */
  ai?: ExtensionAI;

  /** Access to previous workflow results */
  previousResults: Map<string, WorkflowResult>;

  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;

  /** Logger */
  log: ExtensionLogger;
}

/**
 * Simplified workflow result for extensions
 */
export interface ExtensionWorkflowResult {
  /** Whether processing succeeded */
  success: boolean;

  /** Modifications to apply to email */
  modifications?: {
    aiCategory?: string;
    aiCategories?: string[];
    aiConfidence?: number;
    aiSummary?: string;
    labels?: string[];
  };

  /** Labels to add */
  labelsToAdd?: string[];

  /** Labels to remove */
  labelsToRemove?: string[];

  /** Skip remaining workflows */
  skipRemaining?: boolean;

  /** Error if failed */
  error?: Error;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Event bus interface exposed to extensions
 */
export interface ExtensionEventBus {
  /** Subscribe to an event */
  on<T extends PipelineEvent>(eventType: T['type'], handler: EventHandler<T>): Unsubscribe;

  /** Subscribe to an event once */
  once<T extends PipelineEvent>(eventType: T['type'], handler: EventHandler<T>): void;

  /** Emit an event */
  emit(event: PipelineEvent): void;
}

/**
 * Local storage interface for extensions
 */
export interface ExtensionStorage {
  /** Get a value */
  get<T>(key: string): Promise<T | undefined>;

  /** Set a value */
  set<T>(key: string, value: T): Promise<void>;

  /** Delete a value */
  delete(key: string): Promise<void>;

  /** Get all keys */
  keys(): Promise<string[]>;

  /** Clear all extension data */
  clear(): Promise<void>;
}

/**
 * AI completion options
 */
export interface AICompletionOptions {
  /** System prompt for the AI */
  systemPrompt: string;
  /** User prompt/message */
  userPrompt: string;
  /** Maximum tokens in response */
  maxTokens?: number;
}

/**
 * AI interface exposed to extensions
 */
export interface ExtensionAI {
  /** Categorize an email */
  categorize(email: EmailRecord): Promise<AICategorizationResult>;

  /** Generate reply suggestions */
  generateReplySuggestions(email: EmailRecord): Promise<string[]>;

  /** Summarize content */
  summarize(content: string): Promise<string>;

  /** Extract action items */
  extractActionItems(email: EmailRecord): Promise<string[]>;

  /** Check if AI is available */
  isAvailable(): boolean;

  /** Generic completion API for custom prompts */
  complete(options: AICompletionOptions): Promise<string>;
}

/**
 * AI categorization result
 */
export interface AICategorizationResult {
  /** Primary category */
  category: string;

  /** All applicable categories */
  categories: string[];

  /** Confidence score (0-1) */
  confidence: number;

  /** Brief explanation */
  reasoning?: string;
}

/**
 * Settings interface for extensions
 */
export interface ExtensionSettings {
  /** Get a setting value */
  get<T>(key: string): T | undefined;

  /** Get a setting value with default */
  get<T>(key: string, defaultValue: T): T;

  /** Update a setting value */
  update(key: string, value: unknown): Promise<void>;

  /** Check if setting exists */
  has(key: string): boolean;
}

/**
 * Logger interface for extensions
 */
export interface ExtensionLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ============================================================
// Extension UI Types
// ============================================================

/**
 * One labelled value on a notification card.
 *
 * `copyable` renders a copy button next to the value — the reason this exists:
 * an extension that extracts something the user must paste elsewhere (a
 * one-time passcode, a tracking number, a reference id) should not make them
 * open the mail and select the text by hand.
 */
export interface ExtensionUIField {
  /** Field label, e.g. "Code" */
  label: string;

  /** Field value, rendered verbatim (never as HTML) */
  value: string;

  /** Show a copy-to-clipboard button for this value */
  copyable?: boolean;

  /** Render in a larger monospace face — for codes and reference numbers */
  emphasis?: boolean;
}

/**
 * A notification card an extension asks the app to show.
 *
 * This is the ONLY way an extension reaches the renderer. It is deliberately
 * declarative (no markup, no scripts, no styling) so the app can render it with
 * its own design system and an extension can never inject DOM into the window.
 */
export interface ExtensionUINotification {
  /** Stable id — re-notifying with the same id replaces the visible card */
  id: string;

  /** Card title, e.g. "Verification code" */
  title: string;

  /** Optional supporting line, e.g. the sender name */
  body?: string;

  /** Labelled values rendered as rows on the card */
  fields?: ExtensionUIField[];

  /**
   * UTC epoch milliseconds at which the information stops being useful. The
   * card renders a live countdown to this moment and dismisses itself when it
   * passes. Omit for a card that has no natural expiry.
   */
  expiresAt?: number;

  /** Auto-dismiss after this many ms. Ignored when `expiresAt` is set. */
  timeoutMs?: number;

  /** Email this card refers to; clicking the card opens it */
  emailId?: string;

  /** Account owning `emailId`, for the cross-account open path */
  accountId?: string;
}

/**
 * Notification API exposed to extensions (requires `ui:notify`)
 */
export interface ExtensionUI {
  /** Show (or replace) a notification card */
  notify(notification: ExtensionUINotification): void;

  /** Dismiss a card early by id */
  dismiss(notificationId: string): void;
}

// ============================================================
// Extension Host Types (Worker Thread Communication)
// ============================================================

/**
 * Message types for worker thread communication
 */
export type ExtensionHostMessage =
  | { type: 'activate'; extensionId: string; context: SerializedExtensionContext }
  | { type: 'deactivate'; extensionId: string }
  | { type: 'process-email'; requestId: string; workflowId: string; email: EmailRecord }
  | { type: 'event'; event: PipelineEvent }
  | { type: 'storage-result'; requestId: string; result: unknown }
  | { type: 'ai-result'; requestId: string; result: unknown }
  | { type: 'settings-result'; requestId: string; result: unknown };

/**
 * Response types from extension host
 */
export type ExtensionHostResponse =
  | { type: 'activated'; extensionId: string; workflowIds: string[] }
  | { type: 'deactivated'; extensionId: string }
  | { type: 'error'; extensionId: string; error: string }
  | { type: 'workflow-result'; requestId: string; result: ExtensionWorkflowResult }
  | { type: 'storage-request'; requestId: string; operation: string; args: unknown[] }
  | { type: 'ai-request'; requestId: string; operation: string; args: unknown[] }
  | { type: 'settings-request'; requestId: string; operation: string; args: unknown[] }
  | { type: 'log'; level: string; message: string; args: unknown[] };

/**
 * Serialized context for worker thread transfer
 */
export interface SerializedExtensionContext {
  manifest: ExtensionManifest;
  storagePath: string;
  permissions: ExtensionPermission[];
}

// ============================================================
// Extension Registry Types
// ============================================================

/**
 * Extension installation source
 */
export enum ExtensionSource {
  /** Bundled with the application */
  BUILTIN = 'builtin',
  /** Installed from local file */
  LOCAL = 'local',
  /** Installed from marketplace */
  MARKETPLACE = 'marketplace',
}

/**
 * Extension installation record
 */
export interface InstalledExtension {
  /** Extension ID */
  id: string;

  /** Installation source */
  source: ExtensionSource;

  /** Installation path */
  path: string;

  /** Installed version */
  version: string;

  /** Installation timestamp */
  installedAt: number;

  /** Whether enabled */
  enabled: boolean;

  /** User-granted permissions (subset of manifest permissions) */
  grantedPermissions: ExtensionPermission[];

  /** User settings for this extension */
  settings: Record<string, unknown>;
}

/**
 * Extension search/filter options
 */
export interface ExtensionFilter {
  /** Filter by enabled state */
  enabled?: boolean;

  /** Filter by source */
  source?: ExtensionSource;

  /** Filter by permission */
  hasPermission?: ExtensionPermission;

  /** Search by name/description */
  search?: string;
}

// ============================================================
// Builtin Extension Export Types
// ============================================================

/**
 * Email data structure for summarization
 */
export interface EmailForSummary {
  id: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  date: number;
  body: string;
}

/**
 * Thread summary result
 */
export interface ThreadSummaryResult {
  summary: string;
  key_points: string[];
  participants: string[];
  action_items?: string[];
  confidence: number;
}

/**
 * Single email summary result
 */
export interface EmailSummaryResult {
  summary: string;
  key_points: string[];
  action_items?: string[];
  confidence: number;
}

/**
 * Email Summarization Extension exports
 */
export interface EmailSummarizationExports {
  /** Summarize a single email on demand */
  summarizeEmail: (email: EmailForSummary) => Promise<EmailSummaryResult>;
  /** Summarize a thread of emails */
  summarizeThread: (emails: EmailForSummary[]) => Promise<ThreadSummaryResult | null>;
}

/**
 * Email categorization result
 */
export interface EmailCategorizationResult {
  emailId: string;
  isImportant: boolean;
  isSpam: boolean;
  isReminder: boolean;
  isWaitingReply: boolean;
  isNeedsResponse: boolean;
  isMeetingRelated: boolean;
  isInvoiceBilling: boolean;
  confidence: number;
  reasoning: string;
}

/**
 * AI Categorization Extension exports
 */
export interface AICategorizationExports {
  /** Categorize multiple emails in a single batch */
  categorizeEmails: (
    emails: EmailRecord[],
    userEmail: string
  ) => Promise<EmailCategorizationResult[]>;
}
