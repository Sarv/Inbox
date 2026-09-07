/**
 * Pipeline Types and Interfaces
 * Core type definitions for the email processing pipeline
 */

import type { SenderContext } from '../processor/email-processor';
import type { EmailRecord } from '../types/models';

// ============================================================
// Workflow Types
// ============================================================

/**
 * Priority levels for workflows
 * Lower number = higher priority (runs first)
 */
export enum WorkflowPriority {
  CRITICAL = 0,    // Run immediately (e.g., spam detection)
  HIGH = 10,       // Important processing (e.g., importance scoring)
  NORMAL = 50,     // Standard processing (e.g., categorization)
  LOW = 100,       // Background processing (e.g., AI suggestions)
  DEFERRED = 200,  // Run when idle (e.g., analytics)
}

/**
 * Result of a workflow processing an email
 */
export interface WorkflowResult {
  /** Whether the workflow succeeded */
  success: boolean;

  /** Modifications to apply to the email record */
  modifications?: Partial<EmailRecord>;

  /** Labels to add to the email */
  labelsToAdd?: string[];

  /** Labels to remove from the email */
  labelsToRemove?: string[];

  /** Flags to add (e.g., '\Seen', '\Flagged') */
  flagsToAdd?: string[];

  /** Flags to remove */
  flagsToRemove?: string[];

  /** Arbitrary metadata to store */
  metadata?: Record<string, any>;

  /** Chain to specific workflows next */
  nextWorkflows?: string[];

  /** Skip remaining workflows */
  skipRemaining?: boolean;

  /** Error if failed */
  error?: Error;

  /** Processing time in ms */
  processingTime?: number;
}

/**
 * Context passed to workflows during processing
 */
export interface WorkflowContext {
  /** Storage instance for database operations */
  storage: any; // SQLiteStorage type

  /** AI client for LLM operations (optional) */
  aiClient?: AIClient;

  /** Sender context for the email's sender (for importance calculation) */
  senderStats?: SenderContext;

  /** User preferences and settings */
  userPreferences?: UserPreferences;

  /** Results from previous workflows in the pipeline */
  previousResults: Map<string, WorkflowResult>;

  /** Current user's email address */
  userEmail?: string;

  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Email workflow interface - implement this for custom workflows
 */
export interface EmailWorkflow {
  /** Unique identifier for the workflow */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Description of what this workflow does */
  readonly description: string;

  /** Priority determines execution order (lower = earlier) */
  readonly priority: WorkflowPriority | number;

  /** Whether this workflow requires AI/LLM */
  readonly requiresAI: boolean;

  /** Whether to run in background thread */
  readonly runInBackground: boolean;

  /** Whether this workflow is enabled */
  enabled: boolean;

  /**
   * Filter function - determine if this workflow should process the email
   * @param email The email to check
   * @param context The workflow context
   * @returns true if this workflow should process the email
   */
  shouldProcess(email: EmailRecord, context: WorkflowContext): boolean | Promise<boolean>;

  /**
   * Process the email
   * @param email The email to process
   * @param context The workflow context
   * @returns The workflow result
   */
  process(email: EmailRecord, context: WorkflowContext): Promise<WorkflowResult>;

  /**
   * Initialize the workflow (called once on registration)
   */
  initialize?(): Promise<void>;

  /**
   * Cleanup/teardown (called on unregistration or shutdown)
   */
  dispose?(): Promise<void>;
}

// ============================================================
// Event Types
// ============================================================

/**
 * All possible pipeline events
 */
export type PipelineEvent =
  | EmailReceivedEvent
  | EmailSyncedEvent
  | EmailBodyReadyEvent
  | EmailProcessedEvent
  | EmailLabeledEvent
  | EmailFlaggedEvent
  | SyncStartedEvent
  | SyncProgressEvent
  | SyncCompletedEvent
  | SyncErrorEvent
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowErrorEvent
  | TaskScheduledEvent
  | TaskCompletedEvent
  | TaskFailedEvent;

export interface EmailReceivedEvent {
  type: 'email:received';
  email: EmailRecord;
  folder: string;
  timestamp: number;
}

export interface EmailSyncedEvent {
  type: 'email:synced';
  email: EmailRecord;
  folder: string;
  isNew: boolean;
  timestamp: number;
}

export interface EmailBodyReadyEvent {
  type: 'email:body-ready';
  emailId: string;
  timestamp: number;
}

export interface EmailProcessedEvent {
  type: 'email:processed';
  emailId: string;
  workflowId: string;
  result: WorkflowResult;
  timestamp: number;
}

export interface EmailLabeledEvent {
  type: 'email:labeled';
  emailId: string;
  labelsAdded: string[];
  labelsRemoved: string[];
  timestamp: number;
}

export interface EmailFlaggedEvent {
  type: 'email:flagged';
  emailId: string;
  flagsAdded: string[];
  flagsRemoved: string[];
  timestamp: number;
}

export interface SyncStartedEvent {
  type: 'sync:started';
  folders: string[];
  fullSync: boolean;
  timestamp: number;
}

export interface SyncProgressEvent {
  type: 'sync:progress';
  currentFolder: string;
  foldersCompleted: number;
  totalFolders: number;
  messagesProcessed: number;
  totalMessages: number;
  percentComplete: number;
  timestamp: number;
}

export interface SyncCompletedEvent {
  type: 'sync:completed';
  stats: SyncStats;
  timestamp: number;
}

export interface SyncErrorEvent {
  type: 'sync:error';
  error: Error;
  folder?: string;
  recoverable: boolean;
  timestamp: number;
}

export interface WorkflowStartedEvent {
  type: 'workflow:started';
  workflowId: string;
  emailId: string;
  timestamp: number;
}

export interface WorkflowCompletedEvent {
  type: 'workflow:completed';
  workflowId: string;
  emailId: string;
  result: WorkflowResult;
  timestamp: number;
}

export interface WorkflowErrorEvent {
  type: 'workflow:error';
  workflowId: string;
  emailId: string;
  error: Error;
  timestamp: number;
}

export interface TaskScheduledEvent {
  type: 'task:scheduled';
  taskId: string;
  taskType: string;
  scheduledAt: number;
  timestamp: number;
}

export interface TaskCompletedEvent {
  type: 'task:completed';
  taskId: string;
  taskType: string;
  result: any;
  timestamp: number;
}

export interface TaskFailedEvent {
  type: 'task:failed';
  taskId: string;
  taskType: string;
  error: Error;
  retryCount: number;
  timestamp: number;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends PipelineEvent = PipelineEvent> = (event: T) => void | Promise<void>;

/**
 * Unsubscribe function returned by event subscriptions
 */
export type Unsubscribe = () => void;

// ============================================================
// Sync Types
// ============================================================

export interface SyncStats {
  startTime: number;
  endTime: number;
  duration: number;
  foldersProcessed: number;
  messagesProcessed: number;
  newMessages: number;
  updatedMessages: number;
  errors: number;
  folderStats: Record<string, FolderSyncStats>;
}

export interface FolderSyncStats {
  folder: string;
  messagesProcessed: number;
  newMessages: number;
  updatedMessages: number;
  duration: number;
  error?: string;
}

export enum SyncPriority {
  CRITICAL = 0,   // INBOX - sync immediately
  HIGH = 1,       // Starred, Important
  NORMAL = 2,     // Sent, Drafts
  LOW = 3,        // Other folders
  BACKGROUND = 4, // All Mail, Archive
}

export interface SyncTier {
  priority: SyncPriority;
  folders: string[];
  maxMessages: number;
  syncInterval: number; // ms between syncs
}

// ============================================================
// Background Task Types
// ============================================================

export enum TaskPriority {
  HIGH = 0,
  NORMAL = 1,
  LOW = 2,
}

export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  PAUSED = 'paused',
}

export interface BackgroundTask {
  id: string;
  type: 'sync' | 'process' | 'ai-analysis' | 'cleanup' | 'custom';
  priority: TaskPriority;
  status: TaskStatus;
  data: any;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  scheduledAt?: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  progress?: number;
}

export interface TaskQueueOptions {
  maxConcurrent: number;
  retryDelay: number;
  persistTasks: boolean;
}

// ============================================================
// AI Types
// ============================================================

export interface AIClient {
  /** Categorize an email */
  categorize(email: EmailRecord): Promise<string>;

  /** Generate reply suggestions */
  generateReplySuggestions(email: EmailRecord): Promise<string[]>;

  /** Summarize an email or thread */
  summarize(content: string): Promise<string>;

  /** Extract action items from email */
  extractActionItems(email: EmailRecord): Promise<string[]>;

  /** Detect sentiment */
  detectSentiment(content: string): Promise<'positive' | 'negative' | 'neutral'>;

  /** Check if AI is available */
  isAvailable(): boolean;
}

// ============================================================
// User Preferences
// ============================================================

export interface UserPreferences {
  /** Email addresses to treat as VIP */
  vipSenders: string[];

  /** Email addresses to block */
  blockedSenders: string[];

  /** Domains to treat as important */
  importantDomains: string[];

  /** Custom labels/categories */
  customLabels: string[];

  /** AI features enabled */
  aiEnabled: boolean;

  /** Background sync enabled */
  backgroundSyncEnabled: boolean;

  /** Sync interval in minutes */
  syncIntervalMinutes: number;

  /** Auto-mark read delay in seconds */
  autoMarkReadDelay: number;
}

// ============================================================
// Pipeline Status
// ============================================================

export interface PipelineStatus {
  isProcessing: boolean;
  currentEmail?: string;
  workflowsRegistered: number;
  workflowsEnabled: number;
  queuedEmails: number;
  processedToday: number;
  errorsToday: number;
  lastProcessedAt?: number;
}

export interface BatchOptions {
  /** Maximum concurrent email processing */
  concurrency?: number;

  /** Progress callback */
  onProgress?: (processed: number, total: number) => void;

  /** Stop on first error */
  stopOnError?: boolean;

  /** Abort signal */
  abortSignal?: AbortSignal;
}
