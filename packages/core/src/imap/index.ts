// IMAP module exports

// SyncEngine - main orchestrator
export { SyncEngine } from './sync-engine';
export type { SyncEngineOptions } from './sync-engine';

// Connection management
export { ConnectionManager } from './connection-manager';
export type { ManagerConnectionState, ConnectionEvents, ConnectionManagerConfig } from './connection-manager';

// Sync state management
export {
  SyncStateManager,
  getSyncState,
  resetSyncState,
} from './sync-state';
export type {
  SyncState,
  SyncStatus,
  FolderSyncState,
  SyncStateEvents,
} from './sync-state';

// Folder sync
export { FolderSyncer } from './folder-syncer';
export type { FolderSyncOptions, FolderSyncResult } from './folder-syncer';

// Message processing
export { MessageProcessor } from './message-processor';
export type { MessageProcessorConfig, ProcessResult } from './message-processor';

// Real-time monitoring
export { RealtimeManager } from './realtime-manager';
export type {
  RealtimeEvent,
  RealtimeEvents,
  RealtimeConfig,
  RealtimeMode,
} from './realtime-manager';

// Email operations queue
export { OperationQueue } from './operation-queue';
export type {
  OperationType,
  QueuedOperation,
  OperationResult,
  QueueConfig,
} from './operation-queue';

// Connection pool
export { IMAPConnectionPool, PoolConnectionParkedError } from './connection-pool';
export type { ConnectionPoolConfig } from './connection-pool';

// Low-level IMAP client
export { ImapFlowClient } from './imapflow-client';
export {
  resolveLabelStrategy,
  keywordForCategory,
  folderPathForCategory,
  SARV_LABEL_PARENT,
  isSarvLabelPath,
  type LabelStrategy,
  type CategoryLabel,
  type FolderLabelMode,
} from './label-strategy';

// Server-search criteria mapping — pure translation of the renderer's parsed
// query into an IMAP SearchCriteria, plus the "is this worth a round-trip?" test.
export {
  buildImapSearchCriteria,
  hasServerSearchableCriteria,
  type ParsedSearchQuery,
} from './search-criteria';

// Shared error classifiers — reused by IMAP flows and any HTTP/LLM caller that
// needs the same "is this a transient network failure?" decision.
export {
  isConnectionError,
  isConnectTimeoutError,
  isUpstreamError,
  isAuthError,
  isQuotaError,
  isRateLimited,
  getSuggestedBackoffMs,
  describeNetworkError,
} from './imap-errors';

// Queue-aware body fetching — the single deadline policy for every batching
// caller of SyncEngine.fetchBody (prefetch, thread open, background download).
export {
  fetchBodyQueued,
  BODY_FETCH_QUEUE_WAIT_MS,
  BODY_FETCH_RUN_MS,
  type FetchedBody,
  type QueuedBodyFetcher,
} from './fetch-body-queued';

// Mailbox-scoped critical section (select-then-work on a shared connection)
export { withFolderSelected } from './with-folder';
