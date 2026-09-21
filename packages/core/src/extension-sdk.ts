/**
 * The public helper surface for Sarv Inbox extensions.
 *
 * Why this exists as its own entry point rather than the `@sarvinbox/core`
 * barrel: an extension is bundled into ONE self-contained CommonJS file (it is
 * loaded by path, from a folder with no node_modules beside it), so anything it
 * imports as a value is copied into it. Importing `hasTag` from the barrel drags
 * in IMAP, storage, AI and the whole dependency tree — measured at 6.3 MB for a
 * single one-line helper.
 *
 * So this module re-exports ONLY helpers that are pure, dependency-free and
 * genuinely shared. That is what lets an extension reuse the app's own logic
 * instead of hand-rolling a near-copy of it — the tag encoding and the
 * sent-folder rules in particular are subtle enough that a second
 * implementation would drift and be wrong in ways nobody notices.
 *
 * Adding to this file: only ever re-export from a module with no imports of its
 * own. A helper that needs a dependency goes behind its own entry point instead
 * — see `extension-sdk-text.ts` (`@sarvinbox/core/extension-sdk/text`), which
 * exists because `html-to-text` is CommonJS and therefore cannot be tree-shaken
 * out of an extension that does not use it.
 *
 * And measure, rather than trusting that rule. After adding anything here,
 * rebuild `extensions/vip-scoring` and check its size: it imports a handful of
 * these helpers and nothing heavy, so a jump means the new export dragged
 * something in.
 */

// Tag encoding. `EmailRecord.tags` is a `|a|b|c|` string, not an array —
// reading or writing it by hand is how tag corruption gets introduced.
export {
  FLAG_TAG_NAMES,
  sanitizeTagName,
  buildTags,
  parseTags,
  hasTag,
  addTag,
  removeTag,
  imapFlagsToTags,
  tagsToImapFlags,
} from './utils/tags';

// Folder classification. Deciding "is this the Sent folder" from a name is
// full of provider-specific cases ([Gmail]/Sent Mail, INBOX.Sent, Sent Items).
export {
  classifyFolder,
  isOwnMailFolder,
  isInboxFolder,
  isSentFolder,
  isDraftsFolder,
  isTrashFolder,
  isSpamFolder,
  isArchiveFolder,
  type ClassifiableFolder,
  type StandardFolderType,
} from './config/folder-mapping';

// Cooperative yielding. An extension that loops over many messages on the main
// thread must yield on a TIME budget, never on a row count.
export {
  DEFAULT_YIELD_BUDGET_MS,
  DEFAULT_DUTY_CYCLE,
  yieldToEventLoop,
  createLoopYielder,
  createPacer,
  sleep,
  type LoopYielderOptions,
  type PacerOptions,
} from './utils/event-loop';

// The extension API contract itself. Types only — erased at build time, so
// importing them costs an extension nothing.
export type {
  ExtensionManifest,
  ExtensionContext,
  ExtensionWorkflow,
  ExtensionWorkflowResult,
  WorkflowExecutionContext,
  ExtensionPermission,
  ExtensionUI,
  ExtensionUIField,
  ExtensionUINotification,
  ExtensionAI,
  ExtensionStorage,
  ExtensionSettings,
  ExtensionLogger,
  ExtensionEventBus,
} from './extensions/types';

// Writing without thrashing the disk. The storage backend an extension is given
// rewrites its whole JSON file synchronously per `set`, so anything recorded per
// message must be coalesced.
export {
  DEFAULT_FLUSH_INTERVAL_MS,
  createFlushScheduler,
  type FlushScheduler,
  type FlushSchedulerOptions,
} from './utils/flush-scheduler';

// Coalescing concurrent work. Two callers asking for the same expensive thing
// at the same moment — a workflow and a click, say — must pay for it once.
export { createSingleFlight, type SingleFlight } from './utils/single-flight';

// The on-demand summarization contract. An extension that sets exports of this
// shape is reachable from the app's `extension:summarizeThread` IPC handler.
export type {
  EmailForSummary,
  EmailSummaryResult,
  ThreadSummaryResult,
  EmailSummarizationExports,
  AICompletionOptions,
} from './extensions/types';

export type { EmailRecord } from './types/models';
export type { PipelineEvent, EmailSyncedEvent, EmailBodyReadyEvent } from './pipeline/types';
