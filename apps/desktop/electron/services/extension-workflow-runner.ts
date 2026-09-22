/**
 * Extension workflow runner — the thing that actually runs installed
 * extensions over incoming mail.
 *
 * `ExtensionManager.processEmail()` existed and nothing ever called it, so
 * every workflow an extension registered was dead code. This is the caller: it
 * listens on the same event bus the sync pipeline publishes to, runs the
 * workflows for each new message, and applies what they asked for.
 *
 * Two passes per message, because bodies are fetched lazily AFTER `email:synced`:
 *   - `email:synced` (new mail only) runs every enabled workflow at the
 *     'arrival' stage, so a header-only workflow acts immediately;
 *   - `email:body-ready` re-runs only the workflows that declared
 *     `requiresBody`, once there is a body to read.
 * A `requiresBody` workflow therefore runs twice per message and must be
 * idempotent — that contract is documented in the manifest types and in
 * docs/EXTENSIONS.md.
 *
 * Work is serialised through one queue rather than handled inline. `emit()` is
 * fire-and-forget, so a first sync would otherwise start a workflow run per
 * message all at once — thousands of concurrent AI calls and thousands of
 * concurrent database reads, on the main process. One at a time, with a
 * time-budget yield between messages, keeps the window responsive while the
 * backlog drains.
 */

import {
  createLoopYielder,
  createLogger,
  getEventBus,
  planWorkflowEffects,
  type ExtensionPermission,
  type WorkflowOutcome,
} from '@sarvinbox/core';

import {
  findStorageForEmail,
  getAccountIdForStorage,
  getExtensionManager,
} from '../shared';

import { pushFlagToServer } from './flag-push';

const logger = createLogger('extension-workflow-runner');

/** Per-message tracing. Off by default: this is a hot path on a first sync. */
const DEBUG_RUNNER = process.env.SARV_DEBUG_EXTENSIONS === '1';

/**
 * How many messages may wait for extension processing at once.
 *
 * A first sync can enqueue tens of thousands. Holding all of them would pin the
 * ids of an entire mailbox in memory for work that is enrichment, not
 * correctness. When the queue is full the OLDEST entry is dropped: the newest
 * mail is the mail the user is looking at, and a dropped 'arrival' entry for an
 * old message costs a label nobody was waiting for.
 */
export const MAX_PENDING = 2_000;

type Stage = 'arrival' | 'body';

interface QueuedMessage {
  emailId: string;
  accountId?: string;
  stage: Stage;
}

/** Keyed by stage+id so the two passes over one message both survive dedup. */
const pending = new Map<string, QueuedMessage>();
let draining = false;
let unsubscribe: (() => void) | null = null;
let droppedSinceLastReport = 0;

/** Rejections already logged, so one misbehaving extension cannot flood the log. */
const reportedRejections = new Set<string>();

function queueKey(message: QueuedMessage): string {
  return `${message.stage}:${message.emailId}`;
}

function enqueue(message: QueuedMessage): void {
  const manager = getExtensionManager();
  // Nothing installed, or nothing that contributes a workflow: this whole
  // service costs one map lookup per message and no I/O at all.
  if (!manager || manager.getActiveWorkflowIds().length === 0) return;

  const key = queueKey(message);
  if (pending.has(key)) return;

  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
    droppedSinceLastReport += 1;
  }

  pending.set(key, message);
  void drain();
}

/** Map every registered workflow id back to the extension that registered it. */
function buildExtensionIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const host = getExtensionManager()?.getHost();
  for (const adapter of host?.getAllWorkflowAdapters() ?? []) {
    index.set(adapter.id, adapter.extensionId);
  }
  return index;
}

function permissionsFor(extensionId: string): readonly ExtensionPermission[] {
  return getExtensionManager()?.getExtensionInfo(extensionId)?.manifest.permissions ?? [];
}

function reportRejections(emailId: string, plan: ReturnType<typeof planWorkflowEffects>): void {
  for (const rejection of plan.rejected) {
    const key = `${rejection.extensionId}:${rejection.label}:${rejection.reason}`;
    if (reportedRejections.has(key)) continue;
    reportedRejections.add(key);
    logger.warn(
      `Refused '${rejection.label}' from ${rejection.extensionId} (${rejection.reason}); first seen on ${emailId}`
    );
  }
}

async function runOne(message: QueuedMessage, extensionIndex: Map<string, string>): Promise<void> {
  const manager = getExtensionManager();
  if (!manager) return;

  const storage = findStorageForEmail(message.emailId, message.accountId);
  // Not in any database yet — the id can reach the bus before the insert lands.
  // The body-ready pass is the second chance; nothing here needs a retry queue.
  if (!storage) return;

  const email = await storage.getEmail(message.emailId);
  if (!email) return;

  const results = await manager.processEmail(email, undefined, undefined, message.stage);
  if (results.size === 0) return;

  const outcomes: WorkflowOutcome[] = [];
  for (const [workflowId, result] of results) {
    const extensionId = extensionIndex.get(workflowId);
    // A workflow whose extension deactivated mid-run has no permissions to
    // check against, so its result cannot be applied safely.
    if (!extensionId) continue;
    outcomes.push({ extensionId, permissions: permissionsFor(extensionId), result });
  }

  const plan = planWorkflowEffects(email.tags || '||', outcomes);
  reportRejections(email.id, plan);

  if (plan.changed) {
    await storage.updateEmail(email.id, { tags: plan.tags });
  }
  for (const change of plan.flagChanges) {
    await pushFlagToServer(storage, email, change);
  }

  if (DEBUG_RUNNER) {
    logger.debug(
      `${message.stage} ${email.id} acct=${getAccountIdForStorage(storage) ?? 'active'} ` +
        `workflows=${results.size} tags=${plan.changed ? plan.tags : 'unchanged'}`
    );
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;

  // Yield on elapsed time, not on a message count: one message can cost an AI
  // call and the next can cost nothing, so a count-based yield holds the thread
  // for however long the expensive ones happen to take.
  const maybeYield = createLoopYielder();
  const extensionIndex = buildExtensionIndex();

  try {
    while (pending.size > 0) {
      const key = pending.keys().next().value as string;
      const message = pending.get(key)!;
      pending.delete(key);

      await maybeYield();
      try {
        await runOne(message, extensionIndex);
      } catch (error) {
        logger.error(`Extension workflows failed for ${message.emailId}:`, error);
      }
    }
  } finally {
    draining = false;
    if (droppedSinceLastReport > 0) {
      logger.warn(
        `Dropped ${droppedSinceLastReport} queued message(s): more than ${MAX_PENDING} were waiting for extension processing`
      );
      droppedSinceLastReport = 0;
    }
  }
}

/**
 * Subscribe to the pipeline's mail events and start running extension
 * workflows. Idempotent; safe to call before any extension is installed.
 */
export function startExtensionWorkflowRunner(): void {
  if (unsubscribe) return;

  const eventBus = getEventBus();

  const offSynced = eventBus.on('email:synced' as any, (event: any) => {
    // Only genuinely new mail. A re-sync of an existing message would re-run
    // every workflow over the whole mailbox on every connection.
    if (!event?.isNew) return;
    const emailId = event.email?.id;
    if (!emailId) return;
    enqueue({ emailId, accountId: event.email?.accountId, stage: 'arrival' });
  });

  const offBodyReady = eventBus.on('email:body-ready' as any, (event: any) => {
    const emailId = event?.emailId;
    if (!emailId) return;
    enqueue({ emailId, stage: 'body' });
  });

  unsubscribe = () => {
    try { offSynced(); } catch { /* already gone */ }
    try { offBodyReady(); } catch { /* already gone */ }
  };

  logger.info('Extension workflow runner started');
}

/** Stop listening and drop anything still queued. Used on quit and in tests. */
export function stopExtensionWorkflowRunner(): void {
  if (unsubscribe) {
    try { unsubscribe(); } catch { /* already gone */ }
    unsubscribe = null;
  }
  pending.clear();
  reportedRejections.clear();
  droppedSinceLastReport = 0;
}
