// Sarv Inbox Storage Node - Desktop SQLite implementation

export {
  SQLiteStorage,
  type SignaturePattern,
  type SenderStats,
  type SnoozedEmail,
  type EmailAICategory,
  type ThreadSummaryRecord,
  type AICategoryCounts,
  type SpammerRecord,
  type CategoryDefinition,
  type DynamicCategoryCounts,
} from './sqlite-storage';
export { SQLiteVectorStorage } from './vector-storage';
export { createMigrationManager, type Migration } from './migrations';
// The shared contact directory's filename. Exported because the desktop app's
// orphan-DB sweep has to know this file is not an account DB — it deleted the
// whole address book once by assuming it was.
export { SHARED_CONTACTS_FILE, SHARED_SCHEMA } from './shared-contacts';
// Every writer of the `emails` table must record the thread resolver's lookup
// key — including the sent-mail append and the draft save in the Electron main
// process, which insert rows directly rather than through EmailRepository.
export { writeThreadKey } from './thread-keys';
export { setSlowQueryReporter, type SlowQueryEvent } from './slow-query-reporter';

// Is the native addon loadable by this process? better-sqlite3 dlopens lazily,
// so an ABI mismatch surfaces as an empty read rather than an error — anything
// that boots on top of this package should provoke and report the failure
// itself. See native-abi.ts.
export {
  describeNativeAbiFailure,
  parseAbiMismatch,
  probeNativeSqlite,
  type NativeAbiMismatch,
  type NativeSqliteProbe,
} from './native-abi';
export { probeBundledSqlite } from './native-abi-probe';

// The single source of truth for "is this email waiting for AI
// categorization" — every counter, tile and worker query builds on these.
export {
  AGENT_EXCLUDED_TAGS,
  agentEligibleClause,
  agentStuckClause,
  excludedByTagsClause,
  type EligibilityOptions,
  extractionEligibleClause,
  extractionStuckClause,
  hasBodyClause,
  missingBodyClause,
  notExcludedByTagsClause,
  recentWindowClause,
  processingBreakdown,
  type ProcessingBreakdown,
} from './repositories/agent-eligibility';

// Body-size metrics: the length columns that let a has-body test be answered
// from an index, plus the per-database readiness flag every caller of the
// clauses above must pass rather than assume.
export {
  areBodyLengthsReady,
  bodyLengthFromParam,
  fastHasBodyExpression,
  legacyHasBodyExpression,
  rawBodyLengthExpression,
} from './repositories/body-metrics';

// Where bodies live. Anything outside this package that writes or reads a body
// in raw SQL MUST go through these — the inline `emails.clean_body` /
// `emails.raw_body` columns are emptied once migration 73's move has run, and
// reading them directly is silently wrong rather than an error.
export {
  BODIES_RELOCATED_KEY,
  EMAIL_BODIES_TABLE,
  UPSERT_BODY_SQL,
  areBodiesRelocated,
  bodySelectColumns,
  cleanBodyExpression,
  cleanBodySnippetColumn,
  markBodiesRelocated,
  rawBodyExpression,
  upsertBodyPatchSql,
} from './repositories/body-storage';

// Where inline images live. The same rule as bodies, one level down: anything
// outside this package that writes a body in raw SQL must relocate its images
// through these, or that body keeps its base64 forever — the background backfill
// marks itself complete once and never looks again.
export {
  EMAIL_INLINE_IMAGES_TABLE,
  INLINE_IMAGE_SIZE_SQL,
  INLINE_IMAGES_EXTRACTED_KEY,
  INLINE_IMAGES_TABLE,
  areInlineImagesExtracted,
  clearInlineImageCache,
  collectUnreferencedImages,
  hashImageBytes,
  inflateInlineImages,
  inlineImageStats,
  markInlineImagesExtracted,
  rawBodyForStorage,
  relocateBodyForInsert,
  relocateBodyImages,
  writeImageLinks,
} from './repositories/inline-image-store';

// The FTS5 index definition, so nothing recreates an older trigger shape that
// would index empty bodies. See fts-schema.ts.
export { FTS_BACKFILL_MISSING_SQL, FTS_REBUILD_SQL, applyFtsSchema } from './fts-schema';

export { BodyStorageBackfill } from './body-storage-backfill';
export { InlineImageBackfill } from './inline-image-backfill';

// Modular repositories for advanced usage
export {
  BaseRepository,
  EmailRepository,
  FolderRepository,
  ThreadRepository,
  ContactRepository,
  AIRepository,
  SearchRepository,
  AgentRepository,
  type DatabaseAccessor,
  type SenderContext,
} from './repositories';

export const version = '0.1.0';
