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
  isSarvHost,
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

// The header stage — the one derivation of `auth_status`, the spam score and
// the origin IP from a fetched message. Shared by ingest (`convertMessage`)
// and the header backfill, so mail scored at either moment gets one answer.
export { headerStage } from './header-stage';
export type { HeaderStageOptions, HeaderStageResult } from './header-stage';
export { bodyStage, rescoreWithBody } from './body-stage';
export type { BodyStageInput } from './body-stage';

// The reputation stage — blocklist lookups for the sender, cached and
// circuit-broken. Off until zones are configured; see the module header.
export {
  ReputationStage,
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_CACHE_MAX,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_FAILURE_THRESHOLD,
} from './reputation-stage';
export type {
  ReputationLookup,
  ReputationStageConfig,
  ReputationStageDeps,
  ReputationSubject,
} from './reputation-stage';
