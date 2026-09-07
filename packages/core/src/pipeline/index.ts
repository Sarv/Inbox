/**
 * Pipeline Module - Email processing pipeline system
 *
 * Provides types and utilities for the email processing pipeline.
 * The actual workflow execution is now handled by the extension system.
 */

// Types
export type {
  EmailWorkflow,
  WorkflowResult,
  WorkflowContext,
  WorkflowPriority,
  PipelineEvent,
  EventHandler,
  Unsubscribe,
  SyncStats,
  FolderSyncStats,
  SyncPriority,
  SyncTier,
  BackgroundTask,
  TaskQueueOptions,
  AIClient,
  UserPreferences,
  PipelineStatus,
  BatchOptions,
  TaskPriority,
  TaskStatus,
} from './types';

// SenderContext is exported at the package root via the processor barrel;
// pipeline consumes it internally (see ./types) but must not re-export it here
// too, which duplicated the export at the root.

// Event Bus
export {
  EventBus,
  getEventBus,
  createEventBus,
  createEvent,
} from './event-bus';
